
const crypto = require("crypto");

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

async function sendMetaSubscribe(attribution) {
  const {
    META_PIXEL_ID,
    META_ACCESS_TOKEN,
    META_TEST_EVENT_CODE
  } = process.env;

  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
    throw new Error("Meta environment variables missing");
  }

  const userData = {};

  if (attribution.fbc) userData.fbc = attribution.fbc;
  if (attribution.fbp) userData.fbp = attribution.fbp;

  const event = {
    event_name: "Subscribe",
    event_time: Math.floor(Date.now() / 1000),
    event_id:
      `telegram-approved-${attribution.telegram_user_id}`,
    action_source: "website",
    event_source_url: "https://starkxcricket.netlify.app/",
    user_data: userData
  };

  const payload = { data: [event] };

  if (META_TEST_EVENT_CODE) {
    payload.test_event_code = META_TEST_EVENT_CODE;
  }

  const metaResponse = await fetch(
    `https://graph.facebook.com/v25.0/${META_PIXEL_ID}/events?access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const result = await metaResponse.json();

  if (!metaResponse.ok || result.error ||
      result.events_received !== 1) {
    throw new Error(
      result.error?.message ||
      JSON.stringify(result)
    );
  }

  return result;
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

    // GET: Dashboard data
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
        throw new Error(await result.text());
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

    // POST: Approve or decline
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

      // Find the join request
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
        throw new Error(await lookupResponse.text());
      }

      const matchingRequests = await lookupResponse.json();

      if (!matchingRequests.length) {
        return response(404, {
          success: false,
          message: "Join request record not found"
        });
      }

      const inviteLink = matchingRequests[0].invite_link;

      // Find the matching attribution
      let attribution = null;

      if (inviteLink) {
        const findAttributionUrl = new URL(attributionUrl);

        findAttributionUrl.searchParams.set(
          "select",
          "telegram_user_id,invite_link,fbc,fbp,meta_event_sent"
        );
        findAttributionUrl.searchParams.set(
          "invite_link",
          `eq.${inviteLink}`
        );
        findAttributionUrl.searchParams.set(
          "telegram_user_id",
          `eq.${userId}`
        );
        findAttributionUrl.searchParams.set("limit", "1");

        const attributionLookup = await fetch(
          findAttributionUrl.toString(),
          { headers: supabaseHeaders }
        );

        if (!attributionLookup.ok) {
          throw new Error(await attributionLookup.text());
        }

        const attributionRows = await attributionLookup.json();
        attribution = attributionRows[0] || null;
      }

      // Telegram action
      const telegramMethod = action === "approve"
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
          message: telegramResult.description ||
            "Telegram action failed"
        });
      }

      const newStatus =
        action === "approve" ? "approved" : "declined";

      // Update join request status
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
        throw new Error(await joinUpdateResponse.text());
      }

      const updatedRows = await joinUpdateResponse.json();

      if (!updatedRows.length) {
        return response(500, {
          success: false,
          message: "Telegram action succeeded, but database update failed"
        });
      }

      // Decline: update attribution only
      if (action === "decline") {
        if (attribution) {
          const declineUrl = new URL(attributionUrl);

          declineUrl.searchParams.set(
            "invite_link",
            `eq.${inviteLink}`
          );
          declineUrl.searchParams.set(
            "telegram_user_id",
            `eq.${userId}`
          );

          await fetch(declineUrl.toString(), {
            method: "PATCH",
            headers: supabaseHeaders,
            body: JSON.stringify({
              status: "declined"
            })
          });
        }

        return response(200, {
          success: true,
          message: "Join request declined successfully"
        });
      }

      // Approval: send Meta event once
      if (!attribution) {
        return response(200, {
          success: true,
          meta_event_sent: false,
          message: "Telegram approved. Matching attribution record not found."
        });
      }

      if (attribution.meta_event_sent === true) {
        return response(200, {
          success: true,
          meta_event_sent: true,
          message: "Already approved and Meta event was already sent."
        });
      }

      try {
        const metaResult = await sendMetaSubscribe({
          ...attribution,
          telegram_user_id: userId
        });

        // Mark as sent only after Meta confirms receipt
        const markSentUrl = new URL(attributionUrl);

        markSentUrl.searchParams.set(
          "invite_link",
          `eq.${inviteLink}`
        );
        markSentUrl.searchParams.set(
          "telegram_user_id",
          `eq.${userId}`
        );

        const markResponse = await fetch(
          markSentUrl.toString(),
          {
            method: "PATCH",
            headers: supabaseHeaders,
            body: JSON.stringify({
              status: "approved",
              approved_at: new Date().toISOString(),
              meta_event_sent: true
            })
          }
        );

        if (!markResponse.ok) {
          throw new Error(
            "Meta received event, but database flag update failed: " +
            await markResponse.text()
          );
        }

        return response(200, {
          success: true,
          meta_event_sent: true,
          meta_events_received: metaResult.events_received,
          message: "Telegram approved and Meta Subscribe event sent."
        });

      } catch (metaError) {
        console.error("Meta CAPI error:", metaError);

        return response(200, {
          success: true,
          meta_event_sent: false,
          message: "Telegram approved, but Meta event failed. Check Netlify function logs."
        });
      }
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
