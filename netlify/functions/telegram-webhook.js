
// STARK BHAI TOSS - Telegram webhook
// Campaign-level tracking using the permanent Telegram invite link.
// Sends ONLY Meta CAPI Subscribe when a new join request is received.
// It does NOT wait for admin approval and does NOT send Lead.

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      TELEGRAM_WEBHOOK_SECRET,
      META_PIXEL_ID,
      META_ACCESS_TOKEN,
      META_TEST_EVENT_CODE,
      SITE_URL
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase environment variables missing");
    }

    const suppliedSecret =
      event.headers?.["x-telegram-bot-api-secret-token"] ||
      event.headers?.["X-Telegram-Bot-Api-Secret-Token"];

    if (
      TELEGRAM_WEBHOOK_SECRET &&
      suppliedSecret !== TELEGRAM_WEBHOOK_SECRET
    ) {
      return { statusCode: 401, body: "Unauthorized" };
    }

    let update;
    try {
      update = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, body: "Invalid JSON" };
    }

    const supabase = SUPABASE_URL.replace(/\/$/, "");
    const dbHeaders = {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    };

    // ==========================================
    // 1. TELEGRAM JOIN APPROVAL TRACKING
    // ==========================================
    if (update.chat_member) {
      const memberUpdate = update.chat_member;
      const chat = memberUpdate.chat;
      const user = memberUpdate.new_chat_member?.user;

      const oldStatus = memberUpdate.old_chat_member?.status;
      const newStatus = memberUpdate.new_chat_member?.status;

      const wasMember =
        oldStatus === "member" || oldStatus === "administrator";
      const isNowMember =
        newStatus === "member" || newStatus === "administrator";

      if (chat?.id && user?.id && !wasMember && isNowMember) {
        const approvedAt =
          new Date(memberUpdate.date * 1000).toISOString();

        const joinApprovalUrl =
          new URL(`${supabase}/rest/v1/telegram_join_requests`);

        joinApprovalUrl.searchParams.set(
          "telegram_user_id",
          `eq.${user.id}`
        );
        joinApprovalUrl.searchParams.set(
          "chat_id",
          `eq.${chat.id}`
        );
        joinApprovalUrl.searchParams.set(
          "status",
          "eq.pending"
        );

        const joinApprovalResponse = await fetch(
          joinApprovalUrl.toString(),
          {
            method: "PATCH",
            headers: {
              ...dbHeaders,
              Prefer: "return=representation"
            },
            body: JSON.stringify({
              status: "approved",
              approved_at: approvedAt
            })
          }
        );

        if (!joinApprovalResponse.ok) {
          throw new Error(
            "Join request approval update failed: " +
            await joinApprovalResponse.text()
          );
        }

        const approvedJoinRows =
          await joinApprovalResponse.json();

        // Preserve existing attribution approval tracking.
        const attributionApprovalUrl =
          new URL(`${supabase}/rest/v1/telegram_attributions`);

        attributionApprovalUrl.searchParams.set(
          "telegram_user_id",
          `eq.${String(user.id)}`
        );
        attributionApprovalUrl.searchParams.set(
          "status",
          "eq.requested"
        );

        const attributionApprovalResponse = await fetch(
          attributionApprovalUrl.toString(),
          {
            method: "PATCH",
            headers: {
              ...dbHeaders,
              Prefer: "return=representation"
            },
            body: JSON.stringify({
              status: "approved",
              approved_at: approvedAt
            })
          }
        );

        if (!attributionApprovalResponse.ok) {
          throw new Error(
            "Attribution approval update failed: " +
            await attributionApprovalResponse.text()
          );
        }

        const approvedAttributionRows =
          await attributionApprovalResponse.json();

        console.log("Telegram member approved:", {
          userId: user.id,
          chatId: chat.id,
          joinRowsUpdated: approvedJoinRows.length,
          attributionRowsUpdated: approvedAttributionRows.length
        });

        return {
          statusCode: 200,
          body: "Approval processed"
        };
      }

      return {
        statusCode: 200,
        body: "Membership update received; no approval transition"
      };
    }

    // ==========================================
    // 2. TELEGRAM JOIN REQUEST
    // ==========================================
    const request = update.chat_join_request;

    if (!request) {
      return {
        statusCode: 200,
        body: "Update received"
      };
    }

    const user = request.from;
    const chat = request.chat;

    if (!user?.id || !chat?.id || !request.date) {
      throw new Error("Incomplete Telegram join request");
    }

    const inviteLink =
      request.invite_link?.invite_link || null;

    const requestedAt =
      new Date(request.date * 1000).toISOString();

    const source = isKnownCampaignInvite(inviteLink)
      ? "META_LANDING_PAGE"
      : (inviteLink ? "OTHER_INVITE_LINK" : "UNKNOWN");

    // Save the join request.
    const record = {
      telegram_user_id: user.id,
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null,
      chat_id: chat.id,
      chat_title: chat.title || null,
      invite_link: inviteLink,
      requested_at: requestedAt,
      status: "pending",
      source
    };

    const joinResponse = await fetch(
      `${supabase}/rest/v1/telegram_join_requests?on_conflict=telegram_user_id,chat_id`,
      {
        method: "POST",
        headers: {
          ...dbHeaders,
          Prefer: "resolution=ignore-duplicates,return=minimal"
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

    // Fetch the saved request row.
    const rowUrl =
      new URL(`${supabase}/rest/v1/telegram_join_requests`);

    rowUrl.searchParams.set(
      "telegram_user_id",
      `eq.${user.id}`
    );
    rowUrl.searchParams.set(
      "chat_id",
      `eq.${chat.id}`
    );
    rowUrl.searchParams.set(
      "select",
      "id,source,subscribe_event_sent,subscribe_event_status,subscribe_event_id"
    );
    rowUrl.searchParams.set("limit", "1");

    const rowResponse = await fetch(rowUrl.toString(), {
      headers: dbHeaders
    });

    if (!rowResponse.ok) {
      throw new Error(
        "Join request lookup failed: " +
        await rowResponse.text()
      );
    }

    const rows = await rowResponse.json();
    const joinRow = rows[0];

    if (!joinRow) {
      throw new Error("Join request row not found after save");
    }

    // Never send events for historical records.
    if (joinRow.subscribe_event_status === "legacy") {
      return {
        statusCode: 200,
        body: "Existing historical request; Subscribe not sent"
      };
    }

    if (
      joinRow.subscribe_event_sent === true ||
      joinRow.subscribe_event_status === "sent"
    ) {
      return {
        statusCode: 200,
        body: "Subscribe already sent"
      };
    }

    if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
      await updateEventState(
        supabase,
        dbHeaders,
        joinRow.id,
        "failed",
        false,
        null,
        "Meta CAPI credentials missing"
      );

      return {
        statusCode: 200,
        body: "Join request saved; Meta CAPI is not configured"
      };
    }

    // Stable event ID for Meta deduplication.
    const eventId =
      `telegram-join-request-${chat.id}-${user.id}-subscribe`;

    // Claim event before sending to prevent concurrent duplicate sends.
    const claimUrl =
      new URL(`${supabase}/rest/v1/telegram_join_requests`);

    claimUrl.searchParams.set("id", `eq.${joinRow.id}`);
    claimUrl.searchParams.set(
      "subscribe_event_sent",
      "eq.false"
    );
    claimUrl.searchParams.set(
      "subscribe_event_status",
      "in.(pending,failed)"
    );

    const claimResponse = await fetch(claimUrl.toString(), {
      method: "PATCH",
      headers: {
        ...dbHeaders,
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        subscribe_event_status: "sending",
        subscribe_event_id: eventId,
        subscribe_event_error: null
      })
    });

    if (!claimResponse.ok) {
      throw new Error(
        "Subscribe event claim failed: " +
        await claimResponse.text()
      );
    }

    const claimedRows = await claimResponse.json();

    if (!claimedRows.length) {
      return {
        statusCode: 200,
        body: "Subscribe is already sent or being processed"
      };
    }

    // Telegram does not provide the visitor's browser identifiers.
    // Do not invent fbc, fbp, browser IP or browser User-Agent.
    const userData = {
      external_id: [
        await sha256(String(user.id))
      ]
    };

    const eventSourceUrl =
      (SITE_URL || "https://starkbhaitoss.netlify.app")
        .replace(/\/$/, "") + "/";

    // ONLY SUBSCRIBE EVENT. NO LEAD EVENT.
    const metaPayload = {
      ...(META_TEST_EVENT_CODE
        ? { test_event_code: META_TEST_EVENT_CODE }
        : {}),
      data: [{
        event_name: "Subscribe",
        event_time: request.date,
        event_id: eventId,
        action_source: "other",
        event_source_url: eventSourceUrl,
        user_data: userData
      }]
    };

    let metaResult;
    let metaResponse;

    try {
      metaResponse = await fetch(
        `https://graph.facebook.com/v25.0/${META_PIXEL_ID}/events`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${META_ACCESS_TOKEN}`
          },
          body: JSON.stringify(metaPayload)
        }
      );

      metaResult = await metaResponse.json();

    } catch (error) {
      await updateEventState(
        supabase,
        dbHeaders,
        joinRow.id,
        "failed",
        false,
        eventId,
        String(error.message || error)
      );

      throw error;
    }

    if (
      !metaResponse.ok ||
      metaResult.error ||
      metaResult.events_received !== 1
    ) {
      const errorText = JSON.stringify(metaResult);

      await updateEventState(
        supabase,
        dbHeaders,
        joinRow.id,
        "failed",
        false,
        eventId,
        errorText
      );

      console.error("Meta Subscribe CAPI error:", metaResult);

      return {
        statusCode: 200,
        body: "Join request saved; Meta Subscribe event failed"
      };
    }

    // Mark successful event in Supabase.
    await updateEventState(
      supabase,
      dbHeaders,
      joinRow.id,
      "sent",
      true,
      eventId,
      null
    );

    console.log("Telegram Subscribe event sent:", {
      telegramUserId: user.id,
      chatId: chat.id,
      source: joinRow.source,
      eventId,
      eventsReceived: metaResult.events_received
    });

    return {
      statusCode: 200,
      body: "Join request saved; Subscribe event sent"
    };

  } catch (error) {
    console.error("Telegram webhook error:", error);

    return {
      statusCode: 500,
      body: "Webhook processing failed"
    };
  }
};


// ==========================================
// 3. PERMANENT INVITE LINK IDENTIFICATION
// ==========================================
function isKnownCampaignInvite(inviteLink) {
  if (!inviteLink) return false;

  try {
    const url = new URL(inviteLink);

    const allowedHosts = [
      "t.me",
      "telegram.me",
      "www.telegram.me"
    ];

    const token = url.pathname.replace(/\/+$/, "");

    // This permanent invite link is used only on the STARK BHAI landing page.
    // Telegram/Supabase currently stores the visible value with an ellipsis,
    // so match the stable beginning of the invite token.
    return (
      allowedHosts.includes(url.hostname.toLowerCase()) &&
      token.startsWith("/+AgcwI8HC")
    );

  } catch {
    return false;
  }
}


// ==========================================
// 4. UPDATE SUBSCRIBE EVENT STATUS
// ==========================================
async function updateEventState(
  supabase,
  dbHeaders,
  rowId,
  status,
  sent,
  eventId,
  errorText
) {
  const url =
    new URL(`${supabase}/rest/v1/telegram_join_requests`);

  url.searchParams.set("id", `eq.${rowId}`);

  const body = {
    subscribe_event_status: status,
    subscribe_event_sent: sent,
    subscribe_event_id: eventId,
    subscribe_event_error: errorText,
    ...(sent
      ? { subscribe_event_sent_at: new Date().toISOString() }
      : {})
  };

  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      ...dbHeaders,
      Prefer: "return=minimal"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(
      `Subscribe state update failed: ${await response.text()}`
    );
  }
}


// ==========================================
// 5. SHA256 HASH
// ==========================================
async function sha256(value) {
  const data = new TextEncoder().encode(value);

  const hash = await crypto.subtle.digest(
    "SHA-256",
    data
  );

  return Array.from(new Uint8Array(hash))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}
