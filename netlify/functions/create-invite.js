
exports.handler = async (event) => {
  const siteUrl = (process.env.SITE_URL || "https://starkbhaitoss.netlify.app").replace(/\/$/, "");
  const origin = event.headers?.origin || event.headers?.Origin || "";
  const allowedOrigins = new Set([siteUrl]);

  const headers = {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : siteUrl,
    "Vary": "Origin",
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
      TELEGRAM_CHAT_ID,
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY
    } = process.env;

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Required environment variables are missing");
    }

    let body;

    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return reply(400, { error: "Invalid JSON body" });
    }

    const { session_id, fbclid, fbc, fbp } = body;

    if (
      typeof session_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session_id)
    ) {
      return reply(400, { error: "Invalid session ID" });
    }

    const supabase = SUPABASE_URL.replace(/\/$/, "");

    const dbHeaders = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    };

    const clickedAt = new Date().toISOString();

    const clientIp =
      event.headers?.["x-nf-client-connection-ip"] ||
      event.headers?.["client-ip"] ||
      null;

    const clientUserAgent =
      event.headers?.["user-agent"] || null;

    // 1. Check existing invite for this session.
    const existingUrl = new URL(
      `${supabase}/rest/v1/telegram_attributions`
    );

    existingUrl.searchParams.set("session_id", `eq.${session_id}`);
    existingUrl.searchParams.set("select", "id,invite_link");
    existingUrl.searchParams.set("order", "created_at.desc");
    existingUrl.searchParams.set("limit", "1");

    const existingResponse = await fetch(existingUrl.toString(), {
      headers: dbHeaders
    });

    if (!existingResponse.ok) {
      throw new Error(
        "Existing attribution lookup failed: " +
        await existingResponse.text()
      );
    }

    const existingRows = await existingResponse.json();
    const existingRecord = existingRows[0] || null;

    // Reuse existing invite link.
    if (existingRecord?.invite_link) {
      return reply(200, {
        invite_link: existingRecord.invite_link,
        reused: true
      });
    }

    // 2. Use the fixed Telegram channel ID from Netlify environment variables.
    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          name: `SX-${session_id.slice(0, 8)}`,
          creates_join_request: true
        })
      }
    );

    const telegramData = await telegramResponse.json();

    if (
      !telegramResponse.ok ||
      !telegramData.ok ||
      !telegramData.result?.invite_link
    ) {
      throw new Error(
        telegramData.description ||
        "Telegram invite creation failed"
      );
    }

    const inviteLink = telegramData.result.invite_link;

    // 3. Prepare attribution data.
    const attributionData = {
      session_id,
      invite_link: inviteLink,
      fbclid: fbclid || null,
      fbc: fbc || null,
      fbp: fbp || null,
      client_ip_address: clientIp,
      client_user_agent: clientUserAgent,
      status: "clicked",
      clicked_at: clickedAt
    };

    let saveResponse;

    if (existingRecord?.id) {
      const updateUrl = new URL(
        `${supabase}/rest/v1/telegram_attributions`
      );

      updateUrl.searchParams.set("id", `eq.${existingRecord.id}`);

      saveResponse = await fetch(updateUrl.toString(), {
        method: "PATCH",
        headers: {
          ...dbHeaders,
          Prefer: "return=minimal"
        },
        body: JSON.stringify(attributionData)
      });
    } else {
      saveResponse = await fetch(
        `${supabase}/rest/v1/telegram_attributions`,
        {
          method: "POST",
          headers: {
            ...dbHeaders,
            Prefer: "return=minimal"
          },
          body: JSON.stringify(attributionData)
        }
      );
    }

    if (!saveResponse.ok) {
      console.error(
        "Attribution save failed:",
        await saveResponse.text()
      );

      throw new Error(
        "Invite created but attribution could not be saved"
      );
    }

    return reply(200, {
      invite_link: inviteLink,
      reused: false
    });

  } catch (error) {
    console.error("Create invite error:", error);

    return reply(500, {
      error: "Could not create Telegram invite link"
    });
  }
};
