
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "https://starkxcricket.netlify.app",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  const reply = (statusCode, data) => ({
    statusCode,
    headers,
    body: JSON.stringify(data)
  });

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return reply(405, { error: "Method not allowed" });
  }

  try {
    const {
      TELEGRAM_BOT_TOKEN,
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY
    } = process.env;

    if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Required environment variables are missing");
    }

    const body = JSON.parse(event.body || "{}");
    const { session_id, fbclid, fbc, fbp } = body;

    if (
      typeof session_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session_id)
    ) {
      return reply(400, { error: "Invalid session ID" });
    }

    const requestHeaders = event.headers || {};

    const getHeader = (name) => {
      const key = Object.keys(requestHeaders).find(
        k => k.toLowerCase() === name.toLowerCase()
      );
      return key ? requestHeaders[key] : null;
    };

    const clientIp =
      getHeader("x-nf-client-connection-ip") ||
      getHeader("x-forwarded-for")?.split(",")[0]?.trim() ||
      null;

    const clientUserAgent = getHeader("user-agent") || null;

    const supabase = SUPABASE_URL.replace(/\/$/, "");

    const dbHeaders = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    };

    // Reuse an existing invite link for this browser session.
    const existingResponse = await fetch(
      `${supabase}/rest/v1/telegram_attributions?session_id=eq.${encodeURIComponent(session_id)}&select=invite_link&limit=1`,
      { headers: dbHeaders }
    );

    if (!existingResponse.ok) {
      throw new Error("Could not check existing attribution");
    }

    const existingRows = await existingResponse.json();

    if (existingRows.length && existingRows[0].invite_link) {
      // Refresh available visitor matching data.
      const updateResponse = await fetch(
        `${supabase}/rest/v1/telegram_attributions?session_id=eq.${encodeURIComponent(session_id)}`,
        {
          method: "PATCH",
          headers: {
            ...dbHeaders,
            Prefer: "return=minimal"
          },
          body: JSON.stringify({
            fbclid: fbclid || null,
            fbc: fbc || null,
            fbp: fbp || null,
            client_ip_address: clientIp,
            client_user_agent: clientUserAgent
          })
        }
      );

      if (!updateResponse.ok) {
        throw new Error("Could not update visitor attribution");
      }

      return reply(200, {
        invite_link: existingRows[0].invite_link
      });
    }

    // Get the private channel ID from a previous join request.
    const chatResponse = await fetch(
      `${supabase}/rest/v1/telegram_join_requests?select=chat_id&order=requested_at.desc&limit=1`,
      { headers: dbHeaders }
    );

    if (!chatResponse.ok) {
      throw new Error("Could not find the Telegram channel ID");
    }

    const chatRows = await chatResponse.json();

    if (!chatRows.length || !chatRows[0].chat_id) {
      throw new Error("No channel ID found. A test join request is needed first.");
    }

    const chatId = chatRows[0].chat_id;

    // Create a unique invite link requiring admin approval.
    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          name: `SX-${session_id.slice(0, 8)}`,
          creates_join_request: true
        })
      }
    );

    const telegramData = await telegramResponse.json();

    if (!telegramData.ok || !telegramData.result?.invite_link) {
      throw new Error(
        telegramData.description || "Telegram invite creation failed"
      );
    }

    const inviteLink = telegramData.result.invite_link;

    // Save invite and Meta attribution data.
    const saveResponse = await fetch(
      `${supabase}/rest/v1/telegram_attributions`,
      {
        method: "POST",
        headers: {
          ...dbHeaders,
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          session_id,
          invite_link: inviteLink,
          fbclid: fbclid || null,
          fbc: fbc || null,
          fbp: fbp || null,
          client_ip_address: clientIp,
          client_user_agent: clientUserAgent,
          status: "clicked",
          clicked_at: new Date().toISOString()
        })
      }
    );

    if (!saveResponse.ok) {
      throw new Error(
        "Invite was created but attribution could not be saved"
      );
    }

    return reply(200, { invite_link: inviteLink });

  } catch (error) {
    console.error("Create invite error:", error);
    return reply(500, {
      error: "Could not create Telegram invite link"
    });
  }
};
