
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
      TELEGRAM_WEBHOOK_SECRET
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase environment variables missing");
    }

    // Verify Telegram webhook secret if configured
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

    // Ignore updates other than join requests
    if (!request) {
      return {
        statusCode: 200,
        body: "Update received"
      };
    }

    const user = request.from;
    const chat = request.chat;

    const record = {
      telegram_user_id: user.id,
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null,
      chat_id: chat.id,
      chat_title: chat.title || null,
      invite_link: request.invite_link?.invite_link || null,
      requested_at: new Date(
        request.date * 1000
      ).toISOString(),
      status: "pending"
    };

    const response = await fetch(
      `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/telegram_join_requests?on_conflict=telegram_user_id,chat_id`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify(record)
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error);
    }

    return {
      statusCode: 200,
      body: "Join request saved successfully"
    };

  } catch (error) {
    console.error("Telegram webhook error:", error);

    return {
      statusCode: 500,
      body: "Webhook processing failed"
    };
  }
};
