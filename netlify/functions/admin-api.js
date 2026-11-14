
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

  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

async function sha256(value) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(new Uint8Array(hash))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sendMetaSubscribe(attribution, userId) {
  const {
    META_PIXEL_ID,
    META_ACCESS_TOKEN
  } = process.env;

  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
    throw new Error("Meta CAPI environment variables missing");
  }

  const userData = {
    external_id: [await sha256(String(userId))]
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

  const payload = {
    data: [{
      event_name: "Subscribe",
      event_time: Math.floor(Date.now() / 1000),
      event_id: `telegram-approved-${userId}`,
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
      body: JSON.stringify(payload)
    }
  );

  const result = await metaResponse.json();

  if (
    !metaResponse.ok ||
    result.error ||
    result.events_received !== 1
  ) {
    throw new Error(
      result.error?.message || JSON.stringify(result)
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

    const supabase = SUPABASE_URL.replace(/\/$/, "");

    const dbHeaders = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    };

    const tableUrl =
      `${supabase}/rest/v1/telegram_join_requests`;

    const attributionUrl =
      `${supabase}/rest/v1/telegram_attributions`;

    // GET: Dashboard requests and statistics.
    if (event.httpMethod === "GET") {
      const url = new URL(tableUrl);

      url.searchParams.set(
        "select",
        "id,telegram_user_id,username,first_name,last_name,chat_id,chat_title,invite_link,requested_at,status,created_at"
      );

      url.searchParams.set("order", "requested_at.desc");
      url.searchParams.set("limit", "500");

      const result = await fetch(url.toString(), {
        headers: dbHeaders
      });

      if (!result.ok) {
        throw new Error(
          "Dashboard data fetch failed: " +
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

    // POST: Approve or decline a join request.
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

      // 1. Find the existing request.
      const lookupUrl = new URL(tableUrl);

      lookupUrl.searchParams.set(
        "select",
        "telegram_user_id,chat_id,invite_link,status"
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
        { headers: dbHeaders }
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

      const requestRecord = matchingRequests[0];
      const inviteLink = requestRecord.invite_link;
      const currentStatus = requestRecord.status;

      // 2. Prevent reversing a previously completed decision.
      if (
        currentStatus === "approved" &&
        action === "decline"
      ) {
        return response(409, {
          success: false,
          message: "This request has already been approved"
        });
      }

      if (
        currentStatus === "declined" &&
        action === "approve"
      ) {
        return response(409, {
          success: false,
          message: "This request has already been declined"
        });
      }

      // 3. Find matching attribution.
      let attribution = null;

      if (inviteLink) {
        const findUrl = new URL(attributionUrl);

        findUrl.searchParams.set(
          "select",
          "id,telegram_user_id,invite_link,fbc,fbp,client_ip_address,client_user_agent,meta_event_sent"
        );

        findUrl.searchParams.set(
          "invite_link",
          `eq.${inviteLink}`
        );

        findUrl.searchParams.set(
          "telegram_user_id",
          `eq.${userId}`
        );

        findUrl.searchParams.set("limit", "1");

        const attributionResponse = await fetch(
          findUrl.toString(),
          { headers: dbHeaders }
        );

        if (!attributionResponse.ok) {
          throw new Error(await attributionResponse.text());
        }

        const rows = await attributionResponse.json();
        attribution = rows[0] || null;
      }

      // 4. Call Telegram only if the request is still pending.
      if (currentStatus === "pending") {
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

        // 5. Save the decision in Supabase.
        const updateUrl = new URL(tableUrl);

        updateUrl.searchParams.set(
          "telegram_user_id",
          `eq.${userId}`
        );

        updateUrl.searchParams.set(
          "chat_id",
          `eq.${chatId}`
        );

        updateUrl.searchParams.set(
          "status",
          "eq.pending"
        );

        const newStatus =
          action === "approve" ? "approved" : "declined";

        const updateResponse = await fetch(
          updateUrl.toString(),
          {
            method: "PATCH",
            headers: {
              ...dbHeaders,
              Prefer: "return=representation"
            },
            body: JSON.stringify({
              status: newStatus
            })
          }
        );

        if (!updateResponse.ok) {
          throw new Error(
            "Telegram action succeeded but request status update failed: " +
            await updateResponse.text()
          );
        }

        const updatedRows = await updateResponse.json();

        if (!updatedRows.length) {
          throw new Error(
            "Telegram action succeeded but database status was not updated"
          );
        }

        // Update attribution status.
        if (attribution) {
          const statusUrl = new URL(attributionUrl);

          statusUrl.searchParams.set(
            "id",
            `eq.${attribution.id}`
          );

          const statusBody =
            action === "approve"
              ? {
                  status: "approved",
                  approved_at: new Date().toISOString()
                }
              : {
                  status: "declined"
                };

          const statusResponse = await fetch(
            statusUrl.toString(),
            {
              method: "PATCH",
              headers: dbHeaders,
              body: JSON.stringify(statusBody)
            }
          );

          if (!statusResponse.ok) {
            console.error(
              "Attribution status update failed:",
              await statusResponse.text()
            );
          }
        }
      }

      // 6. Decline action is complete.
      if (action === "decline") {
        return response(200, {
          success: true,
          message: "Join request declined successfully"
        });
      }

      // 7. Approval succeeded but attribution is missing.
      if (!attribution) {
        return response(200, {
          success: true,
          meta_event_sent: false,
          message: "Telegram approved. Matching attribution not found."
        });
      }

      // 8. Skip duplicate Subscribe event.
      if (attribution.meta_event_sent === true) {
        return response(200, {
          success: true,
          meta_event_sent: true,
          message: "Meta Subscribe event was already sent."
        });
      }

      // 9. Send Meta Subscribe.
      try {
        const metaResult = await sendMetaSubscribe(
          attribution,
          userId
        );

        // Mark sent only after Meta confirms receipt.
        const markUrl = new URL(attributionUrl);

        markUrl.searchParams.set(
          "id",
          `eq.${attribution.id}`
        );

        const markResponse = await fetch(
          markUrl.toString(),
          {
            method: "PATCH",
            headers: {
              ...dbHeaders,
              Prefer: "return=minimal"
            },
            body: JSON.stringify({
              meta_event_sent: true
            })
          }
        );

        if (!markResponse.ok) {
          console.error(
            "Meta received event but database flag update failed:",
            await markResponse.text()
          );

          return response(200, {
            success: true,
            meta_event_sent: false,
            meta_events_received: metaResult.events_received,
            message: "Meta received Subscribe, but database flag update failed."
          });
        }

        return response(200, {
          success: true,
          meta_event_sent: true,
          meta_events_received: metaResult.events_received,
          message: "Telegram approved and Meta Subscribe event sent."
        });

      } catch (metaError) {
        console.error("Meta Subscribe CAPI error:", metaError);

        return response(200, {
          success: true,
          meta_event_sent: false,
          message: "Telegram approved, but Meta event failed. Retry approval action to retry Meta delivery."
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
