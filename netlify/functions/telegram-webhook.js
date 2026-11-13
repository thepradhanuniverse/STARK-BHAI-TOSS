
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

    // 1. Save the join request
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

    // 2. Match the invite link with its visitor attribution
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
        console.warn(
          "No attribution found for invite link:",
          inviteLink
        );
      } else {
        console.log(
          "Attribution linked successfully for Telegram user:",
          user.id
        );
      }

    } else {
      console.warn(
        "Join request received without an invite link"
      );
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
