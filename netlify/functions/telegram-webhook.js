
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      TELEGRAM_WEBHOOK_SECRET,
      META_PIXEL_ID,
      META_ACCESS_TOKEN,
      META_TEST_EVENT_CODE,
      SITE_URL
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase environment variables missing");
    }

    const suppliedSecret =
      event.headers?.["x-telegram-bot-api-secret-token"] ||
      event.headers?.["X-Telegram-Bot-Api-Secret-Token"];

    if (
      TELEGRAM_WEBHOOK_SECRET &&
      suppliedSecret !== TELEGRAM_WEBHOOK_SECRET
    ) {
      return { statusCode: 401, body: "Unauthorized" };
    }

    let update;
    try {
      update = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, body: "Invalid JSON" };
    }

    const supabase = SUPABASE_URL.replace(/\/$/, "");

    const dbHeaders = {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    };

    // ==========================================
    // 1. TELEGRAM JOIN APPROVAL TRACKING
    // ==========================================
    if (update.chat_member) {
      const memberUpdate = update.chat_member;
      const chat = memberUpdate.chat;
      const user = memberUpdate.new_chat_member?.user;

      const oldStatus = memberUpdate.old_chat_member?.status;
      const newStatus = memberUpdate.new_chat_member?.status;

      const wasMember =
        oldStatus === "member" || oldStatus === "administrator";

      const isNowMember =
        newStatus === "member" || newStatus === "administrator";

      // Only process a transition from non-member to member.
      if (
        chat?.id &&
        user?.id &&
        !wasMember &&
        isNowMember
      ) {
        const approvedAt =
          new Date(memberUpdate.date * 1000).toISOString();

        // Update the matching Telegram join request.
        const joinApprovalUrl =
          new URL(`${supabase}/rest/v1/telegram_join_requests`);

        joinApprovalUrl.searchParams.set(
          "telegram_user_id",
          `eq.${user.id}`
        );
        joinApprovalUrl.searchParams.set(
          "chat_id",
          `eq.${chat.id}`
        );
        joinApprovalUrl.searchParams.set(
          "status",
          "eq.pending"
        );

        const joinApprovalResponse = await fetch(
          joinApprovalUrl.toString(),
          {
            method: "PATCH",
            headers: {
              ...dbHeaders,
              Prefer: "return=representation"
            },
            body: JSON.stringify({
              status: "approved",
              approved_at: approvedAt
            })
          }
        );

        if (!joinApprovalResponse.ok) {
          throw new Error(
            "Join request approval update failed: " +
            await joinApprovalResponse.text()
          );
        }

        const approvedJoinRows =
          await joinApprovalResponse.json();

        // Update requested attribution records for this Telegram user.
        const attributionApprovalUrl =
          new URL(`${supabase}/rest/v1/telegram_attributions`);

        attributionApprovalUrl.searchParams.set(
          "telegram_user_id",
          `eq.${String(user.id)}`
        );
        attributionApprovalUrl.searchParams.set(
          "status",
          "eq.requested"
        );

        const attributionApprovalResponse = await fetch(
          attributionApprovalUrl.toString(),
          {
            method: "PATCH",
            headers: {
              ...dbHeaders,
              Prefer: "return=representation"
            },
            body: JSON.stringify({
              status: "approved",
              approved_at: approvedAt
            })
          }
        );

        if (!attributionApprovalResponse.ok) {
          throw new Error(
            "Attribution approval update failed: " +
            await attributionApprovalResponse.text()
          );
        }

        const approvedAttributionRows =
          await attributionApprovalResponse.json();

        console.log("Telegram member approved:", {
          userId: user.id,
          chatId: chat.id,
          joinRowsUpdated: approvedJoinRows.length,
          attributionRowsUpdated: approvedAttributionRows.length
        });

        return {
          statusCode: 200,
          body: "Approval processed"
        };
      }

      return {
        statusCode: 200,
        body: "Membership update received; no approval transition"
      };
    }

    // ==========================================
    // 2. TELEGRAM JOIN REQUEST
    // ==========================================
    const request = update.chat_join_request;

    if (!request) {
      return {
        statusCode: 200,
        body: "Update received"
      };
    }

    const user = request.from;
    const chat = request.chat;

    if (!user?.id || !chat?.id || !request.date) {
      throw new Error("Incomplete Telegram join request");
    }

    const inviteLink =
      request.invite_link?.invite_link || null;

    const requestedAt =
      new Date(request.date * 1000).toISOString();

    // Save Telegram join request.
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
          Prefer: "resolution=ignore-duplicates,return=minimal"
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

    if (!inviteLink) {
      console.warn("Join request received without invite link");
      return {
        statusCode: 200,
        body: "Join request saved without invite attribution"
      };
    }

    // Match invite link with visitor attribution.
    const attributionUrl =
      new URL(`${supabase}/rest/v1/telegram_attributions`);

    attributionUrl.searchParams.set(
      "invite_link",
      `eq.${inviteLink}`
    );

    attributionUrl.searchParams.set(
      "select",
      "id,telegram_user_id,invite_link,fbc,fbp,client_ip_address,client_user_agent,lead_event_sent,meta_event_sent,status"
    );

    attributionUrl.searchParams.set("limit", "1");

    const attributionResponse = await fetch(
      attributionUrl.toString(),
      { headers: dbHeaders }
    );

    if (!attributionResponse.ok) {
      throw new Error(
        "Attribution lookup failed: " +
        await attributionResponse.text()
      );
    }

    const attributionRows = await attributionResponse.json();
    const attribution = attributionRows[0] || null;

    if (!attribution) {
      console.warn("No attribution found for invite link");
      return {
        statusCode: 200,
        body: "Join request saved; attribution not found"
      };
    }

    // Update attribution to requested.
    const statusUrl =
      new URL(`${supabase}/rest/v1/telegram_attributions`);

    statusUrl.searchParams.set("id", `eq.${attribution.id}`);
    statusUrl.searchParams.set("status", "not.eq.approved");

    const statusResponse = await fetch(
      statusUrl.toString(),
      {
        method: "PATCH",
        headers: {
          ...dbHeaders,
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          telegram_user_id: String(user.id),
          requested_at: requestedAt,
          status: "requested"
        })
      }
    );

    if (!statusResponse.ok) {
      throw new Error(
        "Attribution update failed: " +
        await statusResponse.text()
      );
    }

    // ==========================================
    // 3. META CAPI - LEAD AND SUBSCRIBE
    // ==========================================
    if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
      console.error("Meta CAPI credentials missing");
      return {
        statusCode: 200,
        body: "Join request saved; Meta CAPI is not configured"
      };
    }

    const userData = {
      external_id: [
        await sha256(String(user.id))
      ]
    };

    if (attribution.fbc) userData.fbc = attribution.fbc;
    if (attribution.fbp) userData.fbp = attribution.fbp;

    if (attribution.client_ip_address) {
      userData.client_ip_address =
        attribution.client_ip_address;
    }

    if (attribution.client_user_agent) {
      userData.client_user_agent =
        attribution.client_user_agent;
    }

    const eventSourceUrl =
      (SITE_URL || "https://starkbhaitoss.netlify.app")
        .replace(/\/$/, "") + "/";

    const baseEventId =
      `telegram-join-request-${chat.id}-${user.id}`;

    const eventsToSend = [
      {
        eventName: "Lead",
        flag: "lead_event_sent",
        eventId: `${baseEventId}-lead`,
        alreadySent: attribution.lead_event_sent === true
      },
      {
        eventName: "Subscribe",
        flag: "meta_event_sent",
        eventId: `${baseEventId}-subscribe`,
        alreadySent: attribution.meta_event_sent === true
      }
    ];

    const results = [];

    for (const item of eventsToSend) {
      if (item.alreadySent) {
        results.push(`${item.eventName}: already sent`);
        continue;
      }

      const metaPayload = {
        ...(META_TEST_EVENT_CODE
          ? { test_event_code: META_TEST_EVENT_CODE }
          : {}),
        data: [{
          event_name: item.eventName,
          event_time: request.date,
          event_id: item.eventId,
          action_source: "website",
          event_source_url: eventSourceUrl,
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
        metaResult.error ||
        metaResult.events_received !== 1
      ) {
        console.error(
          `Meta ${item.eventName} CAPI error:`,
          metaResult
        );
        results.push(`${item.eventName}: failed`);
        continue;
      }

      // Mark event sent after Meta acknowledges it.
      const markUrl =
        new URL(`${supabase}/rest/v1/telegram_attributions`);

      markUrl.searchParams.set("id", `eq.${attribution.id}`);

      const markResponse = await fetch(
        markUrl.toString(),
        {
          method: "PATCH",
          headers: {
            ...dbHeaders,
            Prefer: "return=minimal"
          },
          body: JSON.stringify({
            [item.flag]: true
          })
        }
      );

      if (!markResponse.ok) {
        console.error(
          `Database flag update failed for ${item.eventName}:`,
          await markResponse.text()
        );
        results.push(`${item.eventName}: sent, flag update failed`);
      } else {
        results.push(`${item.eventName}: sent`);
      }
    }

    console.log(
      "Telegram request processed:",
      user.id,
      results
    );

    return {
      statusCode: 200,
      body: `Join request processed: ${results.join("; ")}`
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
