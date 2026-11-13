
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

    if (!ADMIN_PASSWORD || !SUPABASE_URL ||
        !SUPABASE_SERVICE_ROLE_KEY || !TELEGRAM_BOT_TOKEN) {
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

      if (!["approve", "decline"].includes(action) ||
          !telegram_user_id || !chat_id) {
        return response(400, {
          success: false,
          message: "Missing or invalid action, user ID or chat ID"
        });
      }

      const userId = String(telegram_user_id);
      const chatId = String(chat_id);

      if (!/^-?\d+$/.test(userId) ||
          !/^-?\d+$/.test(chatId) ||
          !Number.isSafeInteger(Number(userId)) ||
          !Number.isSafeInteger(Number(chatId))) {
        return response(400, {
          success: false,
          message: "Invalid Telegram ID"
        });
      }

      // Find the matching join request and its invite link
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

      const lookupResponse = await fetch(lookupUrl.toString(), {
        headers: supabaseHeaders
      });

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

      // Perform the actual Telegram action
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

      // Update the join request table
      const updateUrl = new URL(tableUrl);

      updateUrl.searchParams.set(
        "telegram_user_id",
        `eq.${userId}`
      );

      updateUrl.searchParams.set(
        "chat_id",
        `eq.${chatId}`
      );

      const newStatus =
        action === "approve" ? "approved" : "declined";

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

      const updatedRows = await joinUpdateResponse.json();

      if (!updatedRows.length) {
        return response(500, {
          success: false,
          message: "Telegram action succeeded, but join request database update failed"
        });
      }

      // Update the matching visitor attribution record
      if (inviteLink) {

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
          attributionUpdate.approved_at =
            new Date().toISOString();
        }

        const attributionResponse = await fetch(
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

        if (!attributionResponse.ok) {
          console.error(
            "Attribution update failed:",
            await attributionResponse.text()
          );

          return response(500, {
            success: false,
            message: "Telegram action succeeded, but attribution update failed"
          });
        }

        const attributionRows =
          await attributionResponse.json();

        if (!attributionRows.length) {
          console.error(
            "No matching attribution record found"
          );

          return response(500, {
            success: false,
            message: "Telegram action succeeded, but matching attribution record was not found"
          });
        }

      } else {
        console.error(
          "No invite link found for this join request"
        );

        return response(500, {
          success: false,
          message: "Telegram action succeeded, but invite link was missing"
        });
      }

      return response(200, {
        success: true,
        message: action === "approve"
          ? "Join request and attribution approved successfully"
          : "Join request and attribution declined successfully"
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
