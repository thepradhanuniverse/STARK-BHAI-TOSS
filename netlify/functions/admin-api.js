
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
    const tableUrl = `${baseUrl}/rest/v1/telegram_join_requests`;

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
        throw new Error("Could not fetch join requests");
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

      if (!/^-?\d+$/.test(userId) || !/^-?\d+$/.test(chatId) ||
          !Number.isSafeInteger(Number(userId)) ||
          !Number.isSafeInteger(Number(chatId))) {
        return response(400, {
          success: false,
          message: "Invalid Telegram ID"
        });
      }

      const telegramMethod = action === "approve"
        ? "approveChatJoinRequest"
        : "declineChatJoinRequest";

      const telegramResponse = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${telegramMethod}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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

      const updateUrl = new URL(tableUrl);
      updateUrl.searchParams.set("telegram_user_id", `eq.${userId}`);
      updateUrl.searchParams.set("chat_id", `eq.${chatId}`);

      const updateResponse = await fetch(updateUrl.toString(), {
        method: "PATCH",
        headers: {
          ...supabaseHeaders,
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          status: action === "approve" ? "approved" : "declined"
        })
      });

      if (!updateResponse.ok) {
        console.error("Supabase status update failed");
        return response(500, {
          success: false,
          message: "Telegram action succeeded, but database update failed. Check the record."
        });
      }

      const updatedRows = await updateResponse.json();

      if (!updatedRows.length) {
        return response(500, {
          success: false,
          message: "Telegram action succeeded, but no database record was updated."
        });
      }

      return response(200, {
        success: true,
        message: action === "approve"
          ? "Join request approved successfully"
          : "Join request declined successfully"
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
