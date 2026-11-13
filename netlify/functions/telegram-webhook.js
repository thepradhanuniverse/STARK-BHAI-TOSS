
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: "Method Not Allowed"
      };
    }

    const {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      TELEGRAM_WEBHOOK_SECRET,
      META_PIXEL_ID,
      META_ACCESS_TOKEN
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase environment variables missing");
    }

    if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
      throw new Error("Meta CAPI environment variables missing");
    }

    if (
      TELEGRAM_WEBHOOK_SECRET &&
      event.headers["x-telegram-bot-api-secret-token"] !==
        TELEGRAM_WEBHOOK_SECRET
    ) {
      return {
        statusCode: 401,
        body: "Unauthorized"
      };
    }

    const update = JSON.parse(event.body || "{}");
    const request = update.chat_join_request;

    if (!request) {
      return {
        statusCode: 200,
        body: "Update received"
      };
    }

    const user = request.from;
    const chat = request.chat;
    const supabase = SUPABASE_URL.replace(/\/$/, "");

    const dbHeaders = {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    };

    const inviteLink =
      request.invite_link?.invite_link || null;

    const requestedAt =
      new Date(request.date * 1000).toISOString();

    // 1. Save Telegram join request
    const record = {
      telegram_user_id: user.id,
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null,
      chat_id: chat.id,
      chat_title: chat.title || null,
      invite_link: inviteLink,
      requested_at: requestedAt,
      status: "pending"
    };

    const joinResponse = await fetch(
      `${supabase}/rest/v1/telegram_join_requests?on_conflict=telegram_user_id,chat_id`,
      {
        method: "POST",
        headers: {
          ...dbHeaders,
          Prefer: "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify(record)
      }
    );

    if (!joinResponse.ok) {
      throw new Error(
        "Join request save failed: " +
        await joinResponse.text()
      );
    }

    // 2. Match visitor attribution
    if (inviteLink) {
      const attributionResponse = await fetch(
        `${supabase}/rest/v1/telegram_attributions?invite_link=eq.${encodeURIComponent(inviteLink)}`,
        {
          method: "PATCH",
          headers: {
            ...dbHeaders,
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            telegram_user_id: String(user.id),
            requested_at: requestedAt,
            status: "requested"
          })
        }
      );

      if (!attributionResponse.ok) {
        throw new Error(
          "Attribution update failed: " +
          await attributionResponse.text()
        );
      }

      const updatedRows = await attributionResponse.json();

      if (!updatedRows.length) {
        console.warn("No attribution found for invite link:", inviteLink);
      } else {
        const attribution = updatedRows[0];

        console.log(
          "Attribution linked for Telegram user:",
          user.id
        );

        // 3. Send Meta Lead only once per attribution
        if (!attribution.lead_event_sent) {
          const userData = {
            external_id: [
              // SHA-256 hash of Telegram user ID
              await sha256(String(user.id))
            ]
          };

          if (attribution.fbc) {
            userData.fbc = attribution.fbc;
          }

          if (attribution.fbp) {
            userData.fbp = attribution.fbp;
          }

          if (attribution.client_ip_address) {
            userData.client_ip_address =
              attribution.client_ip_address;
          }

          if (attribution.client_user_agent) {
            userData.client_user_agent =
              attribution.client_user_agent;
          }

          const metaPayload = {
            data: [{
              event_name: "Lead",
              event_time: request.date,
              event_id: `telegram-join-request-${user.id}`,
              action_source: "website",
              event_source_url: "https://starkxcricket.netlify.app/",
              user_data: userData
            }]
          };

          const metaResponse = await fetch(
            `https://graph.facebook.com/v25.0/${META_PIXEL_ID}/events`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${META_ACCESS_TOKEN}`
              },
              body: JSON.stringify(metaPayload)
            }
          );

          const metaResult = await metaResponse.json();

          if (
            !metaResponse.ok ||
            metaResult.events_received !== 1
          ) {
            console.error("Meta Lead CAPI error:", metaResult);
          } else {
            console.log("Meta Lead event received successfully");

            // Mark sent only after Meta confirms receipt
            const markResponse = await fetch(
              `${supabase}/rest/v1/telegram_attributions?id=eq.${encodeURIComponent(attribution.id)}`,
              {
                method: "PATCH",
                headers: {
                  ...dbHeaders,
                  Prefer: "return=minimal"
                },
                body: JSON.stringify({
                  lead_event_sent: true
                })
              }
            );

            if (!markResponse.ok) {
              console.error(
                "Could not mark Lead as sent:",
                await markResponse.text()
              );
            }
          }
        } else {
          console.log("Lead event already sent; skipping duplicate");
        }
      }
    } else {
      console.warn("Join request received without an invite link");
    }

    return {
      statusCode: 200,
      body: "Join request and attribution processed successfully"
    };

  } catch (error) {
    console.error("Telegram webhook error:", error);

    return {
      statusCode: 500,
      body: "Webhook processing failed"
    };
  }
};

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hash))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}
