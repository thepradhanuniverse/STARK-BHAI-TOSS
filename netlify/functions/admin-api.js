
const crypto = require("crypto");

const META_PIXEL_ID = "4634843846793315";
const META_API_VERSION = "v27.0";

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "https://starkxcricket.netlify.app",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

function response(statusCode, data) {
  return {
    statusCode,
    headers: HEADERS,
    body: JSON.stringify(data)
  };
}

function safeCompare(a, b) {
  if (!a || !b) return false;

  const first = Buffer.from(a);
  const second = Buffer.from(b);

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

// Send approved registration event to Meta Conversions API
async function sendMetaRegistration(attribution, approvedAt) {
  const accessToken = process.env.META_ACCESS_TOKEN;

  if (!accessToken) {
    throw new Error("META_ACCESS_TOKEN is missing");
  }

  const userData = {};

  if (attribution.fbp) {
    userData.fbp = attribution.fbp;
  }

  if (attribution.fbc) {
    userData.fbc = attribution.fbc;
  }

  // Do not send an event without browser matching data
  if (!userData.fbp && !userData.fbc) {
    throw new Error("No fbp or fbc available for Meta matching");
  }

  const eventId =
    `telegram-approved-${attribution.session_id}`;

  const payload = {
    data: [
      {
        event_name: "CompleteRegistration",
        event_time: Math.floor(
          new Date(approvedAt).getTime() / 1000
        ),
        event_id: eventId,
        action_source: "website",
        event_source_url: "https://starkxcricket.netlify.app/",
        user_data: userData,
        custom_data: {
          content_name: "STARK BHAI TOSS Telegram Channel",
          registration_status: "approved"
        }
      }
    ]
  };

  const metaUrl =
    `https://graph.facebook.com/${META_API_VERSION}/${META_PIXEL_ID}/events`;

  const metaResponse = await fetch(metaUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...payload,
      access_token: accessToken
    })
  });

  const metaResult = await metaResponse.json();

  if (!metaResponse.ok || metaResult.error) {
    throw new Error(
      metaResult.error?.message ||
      "Meta Conversions API request failed"
    );
  }

  if (!metaResult.events_received ||
      metaResult.events_received < 1) {
    throw new Error("Meta did not confirm event receipt");
  }

  return metaResult;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: HEADERS,
        body: ""
      };
    }

    const {
      ADMIN_PASSWORD,
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      TELEGRAM_BOT_TOKEN
    } = process.env;

    if (
      !ADMIN_PASSWORD ||
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY ||
      !TELEGRAM_BOT_TOKEN
    ) {
      return response(500, {
        success: false,
        message: "Server environment variables missing"
      });
    }

    const suppliedPassword =
      event.headers?.["x-admin-password"] ||
      event.headers?.["X-Admin-Password"];

    if (!safeCompare(suppliedPassword, ADMIN_PASSWORD)) {
      return response(401, {
        success: false,
        message: "Invalid admin password"
      });
    }

    const supabaseHeaders = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    };

    const baseUrl = SUPABASE_URL.replace(/\/$/, "");

    const tableUrl =
      `${baseUrl}/rest/v1/telegram_join_requests`;

    const attributionUrl =
      `${baseUrl}/rest/v1/telegram_attributions`;

    // GET: Fetch join requests and dashboard statistics
    if (event.httpMethod === "GET") {
      const url = new URL(tableUrl);

      url.searchParams.set(
        "select",
        "id,telegram_user_id,username,first_name,last_name,chat_id,chat_title,invite_link,requested_at,status,created_at"
      );

      url.searchParams.set("order", "requested_at.desc");
      url.searchParams.set("limit", "500");

      const result = await fetch(url.toString(), {
        headers: supabaseHeaders
      });

      if (!result.ok) {
        throw new Error(
          "Could not fetch join requests: " +
          await result.text()
        );
      }

      const rows = await result.json();

      return response(200, {
        success: true,
        total: rows.length,
        pending: rows.filter(r => r.status === "pending").length,
        approved: rows.filter(r => r.status === "approved").length,
        declined: rows.filter(r => r.status === "declined").length,
        requests: rows
      });
    }

    // POST: Approve or decline a Telegram join request
    if (event.httpMethod === "POST") {
      let body;

      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        return response(400, {
          success: false,
          message: "Invalid JSON"
        });
      }

      const { action, telegram_user_id, chat_id } = body;

      if (
        !["approve", "decline"].includes(action) ||
        !telegram_user_id ||
        !chat_id
      ) {
        return response(400, {
          success: false,
          message: "Missing or invalid action, user ID or chat ID"
        });
      }

      const userId = String(telegram_user_id);
      const chatId = String(chat_id);

      if (
        !/^-?\d+$/.test(userId) ||
        !/^-?\d+$/.test(chatId) ||
        !Number.isSafeInteger(Number(userId)) ||
        !Number.isSafeInteger(Number(chatId))
      ) {
        return response(400, {
          success: false,
          message: "Invalid Telegram ID"
        });
      }

      // Find matching Telegram join request
      const lookupUrl = new URL(tableUrl);

      lookupUrl.searchParams.set(
        "select",
        "telegram_user_id,chat_id,invite_link"
      );

      lookupUrl.searchParams.set(
        "telegram_user_id",
        `eq.${userId}`
      );

      lookupUrl.searchParams.set(
        "chat_id",
        `eq.${chatId}`
      );

      const lookupResponse = await fetch(
        lookupUrl.toString(),
        { headers: supabaseHeaders }
      );

      if (!lookupResponse.ok) {
        throw new Error(
          "Could not find join request: " +
          await lookupResponse.text()
        );
      }

      const matchingRequests = await lookupResponse.json();

      if (!matchingRequests.length) {
        return response(404, {
          success: false,
          message: "Join request record not found"
        });
      }

      const inviteLink = matchingRequests[0].invite_link;

      if (!inviteLink) {
        return response(404, {
          success: false,
          message: "Invite link missing from join request"
        });
      }

      // Find the matching visitor attribution
      const attributionLookupUrl =
        new URL(attributionUrl);

      attributionLookupUrl.searchParams.set(
        "select",
        "session_id,fbp,fbc,meta_event_sent"
      );

      attributionLookupUrl.searchParams.set(
        "invite_link",
        `eq.${inviteLink}`
      );

      attributionLookupUrl.searchParams.set(
        "telegram_user_id",
        `eq.${userId}`
      );

      const attributionLookupResponse = await fetch(
        attributionLookupUrl.toString(),
        { headers: supabaseHeaders }
      );

      if (!attributionLookupResponse.ok) {
        throw new Error(
          "Could not fetch attribution: " +
          await attributionLookupResponse.text()
        );
      }

      const attributionRows =
        await attributionLookupResponse.json();

      if (!attributionRows.length) {
        return response(404, {
          success: false,
          message: "Matching visitor attribution not found"
        });
      }

      const attribution = attributionRows[0];

      // Perform actual Telegram approval or decline
      const telegramMethod =
        action === "approve"
          ? "approveChatJoinRequest"
          : "declineChatJoinRequest";

      const telegramResponse = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${telegramMethod}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            chat_id: Number(chatId),
            user_id: Number(userId)
          })
        }
      );

      const telegramResult = await telegramResponse.json();

      if (!telegramResponse.ok || !telegramResult.ok) {
        return response(400, {
          success: false,
          message:
            telegramResult.description ||
            "Telegram action failed"
        });
      }

      // Update Telegram join request status
      const newStatus =
        action === "approve" ? "approved" : "declined";

      const updateUrl = new URL(tableUrl);

      updateUrl.searchParams.set(
        "telegram_user_id",
        `eq.${userId}`
      );

      updateUrl.searchParams.set(
        "chat_id",
        `eq.${chatId}`
      );

      const joinUpdateResponse = await fetch(
        updateUrl.toString(),
        {
          method: "PATCH",
          headers: {
            ...supabaseHeaders,
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            status: newStatus
          })
        }
      );

      if (!joinUpdateResponse.ok) {
        throw new Error(
          "Join request status update failed: " +
          await joinUpdateResponse.text()
        );
      }

      const updatedRows =
        await joinUpdateResponse.json();

      if (!updatedRows.length) {
        return response(500, {
          success: false,
          message:
            "Telegram action succeeded, but join request database update failed"
        });
      }

      // Update visitor attribution status
      const approvedAt = new Date().toISOString();

      const attributionUpdateUrl =
        new URL(attributionUrl);

      attributionUpdateUrl.searchParams.set(
        "invite_link",
        `eq.${inviteLink}`
      );

      attributionUpdateUrl.searchParams.set(
        "telegram_user_id",
        `eq.${userId}`
      );

      const attributionUpdate = {
        status: newStatus
      };

      if (action === "approve") {
        attributionUpdate.approved_at = approvedAt;
      }

      const attributionUpdateResponse = await fetch(
        attributionUpdateUrl.toString(),
        {
          method: "PATCH",
          headers: {
            ...supabaseHeaders,
            Prefer: "return=representation"
          },
          body: JSON.stringify(attributionUpdate)
        }
      );

      if (!attributionUpdateResponse.ok) {
        console.error(
          "Attribution update failed:",
          await attributionUpdateResponse.text()
        );

        return response(500, {
          success: false,
          message:
            "Telegram action succeeded, but attribution update failed"
        });
      }

      const updatedAttributions =
        await attributionUpdateResponse.json();

      if (!updatedAttributions.length) {
        return response(500, {
          success: false,
          message:
            "Telegram action succeeded, but attribution record was not updated"
        });
      }

      // Send Meta event ONLY after successful approval
      let metaEventSent = false;
      let metaWarning = null;

      if (action === "approve") {
        if (attribution.meta_event_sent === true) {
          metaEventSent = true;
        } else {
          try {
            await sendMetaRegistration(
              attribution,
              approvedAt
            );

            // Mark Meta event as sent in Supabase
            const metaStatusUrl =
              new URL(attributionUrl);

            metaStatusUrl.searchParams.set(
              "invite_link",
              `eq.${inviteLink}`
            );

            metaStatusUrl.searchParams.set(
              "telegram_user_id",
              `eq.${userId}`
            );

            const metaStatusResponse = await fetch(
              metaStatusUrl.toString(),
              {
                method: "PATCH",
                headers: {
                  ...supabaseHeaders,
                  Prefer: "return=minimal"
                },
                body: JSON.stringify({
                  meta_event_sent: true
                })
              }
            );

            if (!metaStatusResponse.ok) {
              throw new Error(
                "Meta event sent, but Supabase tracking update failed: " +
                await metaStatusResponse.text()
              );
            }

            metaEventSent = true;

          } catch (metaError) {
            console.error(
              "Meta CompleteRegistration event error:",
              metaError.message
            );

            metaWarning =
              "Telegram approval succeeded, but Meta event was not confirmed. Do not approve the same request again.";
          }
        }
      }

      return response(200, {
        success: true,
        meta_event_sent: metaEventSent,
        message:
          action === "approve"
            ? metaWarning ||
              "Telegram approved and CompleteRegistration event sent successfully"
            : "Telegram join request and attribution declined successfully"
      });
    }

    return response(405, {
      success: false,
      message: "Method not allowed"
    });

  } catch (error) {
    console.error("Admin API error:", error);

    return response(500, {
      success: false,
      message: "Internal server error"
    });
  }
};
