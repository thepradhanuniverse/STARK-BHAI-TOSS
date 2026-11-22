
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders()
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, {
      ok: false,
      error: "Method not allowed"
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error("Missing Supabase environment variables");

    return json(500, {
      ok: false,
      error: "Server configuration missing"
    });
  }

  let body;

  try {
    body = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, {
      ok: false,
      error: "Invalid JSON"
    });
  }

  const sessionId = String(body.session_id || "").trim();

  if (!sessionId || sessionId.length > 200) {
    return json(400, {
      ok: false,
      error: "Invalid session_id"
    });
  }

  const forwardedFor =
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["x-forwarded-for"] ||
    "";

  const clientIp =
    String(forwardedFor).split(",")[0].trim() || null;

  const userAgent =
    String(
      body.client_user_agent ||
      event.headers["user-agent"] ||
      ""
    ).slice(0, 1000) || null;

  const row = {
    session_id: sessionId,

    invite_link: "https://t.me/+AgcwI8HCXQ80MWRl",

    fbclid: body.fbclid || null,
    fbc: body.fbc || null,
    fbp: body.fbp || null,

    client_ip_address: clientIp,
    client_user_agent: userAgent,

    status: "clicked",
    clicked_at: new Date().toISOString()
  };

  const url =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/telegram_attributions?on_conflict=session_id`;

  let response;

  try {
    response = await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Prefer": "resolution=merge-duplicates,return=minimal"
      },

      body: JSON.stringify(row)
    });

  } catch (error) {
    console.error("Supabase request failed:", error);

    return json(502, {
      ok: false,
      error: "Attribution storage unavailable"
    });
  }

  if (!response.ok) {
    const details = await response.text();

    console.error(
      "Supabase insert failed:",
      response.status,
      details
    );

    return json(502, {
      ok: false,
      error: "Attribution storage failed"
    });
  }

  return json(200, {
    ok: true
  });
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(data)
  };
}
