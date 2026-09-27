import { kvGet, kvPut } from "./kv.js";

const CONFIG_KEY = "telegram:config";
const SESSION_PREFIX = "telegram:session:";

async function getConfig() {
  const c = await kvGet(CONFIG_KEY, "json");
  return {
    enabled: false,
    botToken: "",
    publicUrl: "",
    allowedUserIds: [],
    adminUserIds: [],
    defaultModel: "",
    greeting: "Hi! Send a message to chat, or /help for commands.",
    systemPrompt: "",
    webhookSecret: "",
    ...(c && typeof c === "object" ? c : {})
  };
}

async function setConfig(cfg) {
  await kvPut(CONFIG_KEY, cfg);
}

async function getSession(chatId) {
  const s = await kvGet(SESSION_PREFIX + chatId, "json");
  return {
    messages: [],
    model: null,
    ...(s && typeof s === "object" ? s : {})
  };
}

async function setSession(chatId, session) {
  // Keep last 20 turns
  if (Array.isArray(session.messages) && session.messages.length > 40) {
    session.messages = session.messages.slice(-40);
  }
  await kvPut(SESSION_PREFIX + chatId, session);
}

async function tgApi(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || `Telegram API ${method} failed`);
  return j.result;
}

async function reply(token, chatId, text, extra = {}) {
  const chunks = [];
  const s = String(text || "");
  if (s.length <= 4000) chunks.push(s);
  else {
    for (let i = 0; i < s.length; i += 3900) chunks.push(s.slice(i, i + 3900));
  }
  for (const part of chunks) {
    await tgApi(token, "sendMessage", {
      chat_id: chatId,
      text: part,
      parse_mode: extra.parse_mode,
      reply_to_message_id: extra.reply_to
    });
  }
}

async function handleUpdate(update, cfg) {
  const msg = update.message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = (msg.text || msg.caption || "").trim();

  if (!cfg.enabled || !cfg.botToken) return;

  const allowed = Array.isArray(cfg.allowedUserIds) ? cfg.allowedUserIds.map(Number) : [];
  if (allowed.length && !allowed.includes(Number(userId))) {
    await reply(cfg.botToken, chatId, "You are not authorized to use this bot.");
    return;
  }

  // Commands
  if (text.startsWith("/")) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    if (cmd === "/start" || cmd === "/help") {
      await reply(cfg.botToken, chatId,
        (cfg.greeting || "Hi!") +
        "\n\nCommands:\n/help — this message\n/me — your Telegram user ID\n/model <id> — set model\n/new — clear conversation\n/status — current model");
      return;
    }
    if (cmd === "/me") {
      await reply(cfg.botToken, chatId, `Your Telegram user ID: ${userId}`);
      return;
    }
    if (cmd === "/new") {
      await setSession(chatId, { messages: [], model: null });
      await reply(cfg.botToken, chatId, "Conversation cleared.");
      return;
    }
    if (cmd === "/model") {
      const session = await getSession(chatId);
      if (!arg) {
        await reply(cfg.botToken, chatId, `Current model: ${session.model || cfg.defaultModel || "(none)"}`);
        return;
      }
      session.model = arg;
      await setSession(chatId, session);
      await reply(cfg.botToken, chatId, `Model set to ${arg}`);
      return;
    }
    if (cmd === "/status") {
      const session = await getSession(chatId);
      await reply(cfg.botToken, chatId,
        `Model: ${session.model || cfg.defaultModel || "(none)"}\nMessages: ${session.messages.length}`);
      return;
    }
  }

  if (!text && !(msg.photo && msg.photo.length)) {
    await reply(cfg.botToken, chatId, "Send text or a photo.");
    return;
  }

  const session = await getSession(chatId);
  const model = session.model || cfg.defaultModel;
  if (!model) {
    await reply(cfg.botToken, chatId, "No model configured. Use /model <id> or set a default in admin.");
    return;
  }

  const messages = [];
  if (cfg.systemPrompt) {
    messages.push({ role: "system", content: cfg.systemPrompt });
  }
  for (const m of session.messages) messages.push(m);

  // Build user content
  let userContent = text || "";
  if (msg.photo && msg.photo.length) {
    // Use largest photo
    const photo = msg.photo[msg.photo.length - 1];
    try {
      const file = await tgApi(cfg.botToken, "getFile", { file_id: photo.file_id });
      const fileUrl = `https://api.telegram.org/file/bot${cfg.botToken}/${file.file_path}`;
      const imgRes = await fetch(fileUrl);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const b64 = buf.toString("base64");
      const mime = "image/jpeg";
      userContent = [
        { type: "text", text: text || "Describe this image." },
        { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }
      ];
    } catch (e) {
      console.error("tg photo fetch failed", e);
      userContent = text || "I sent a photo but it could not be loaded.";
    }
  }

  messages.push({ role: "user", content: userContent });

  // Call upstream via internal chat completions path is complex; call ninerouter directly
  const NINEROUTER_BASE = "https://ninerouter-china.onrender.com";
  try {
    await tgApi(cfg.botToken, "sendChatAction", { chat_id: chatId, action: "typing" });
    const r = await fetch(`${NINEROUTER_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(90000)
    });
    if (!r.ok) {
      const errText = await r.text();
      await reply(cfg.botToken, chatId, `Model error (${r.status}): ${errText.slice(0, 300)}`);
      return;
    }
    const j = await r.json();
    const replyText = j.choices?.[0]?.message?.content || "(empty response)";
    session.messages.push({ role: "user", content: typeof userContent === "string" ? userContent : text || "[image]" });
    session.messages.push({ role: "assistant", content: replyText });
    await setSession(chatId, session);
    await reply(cfg.botToken, chatId, replyText);
  } catch (e) {
    console.error("tg chat error", e);
    await reply(cfg.botToken, chatId, "Sorry, something went wrong: " + (e.message || "unknown")).catch(() => {});
  }
}

export async function webhook(req, res) {
  const cfg = await getConfig();
  // Optional secret header check
  if (cfg.webhookSecret) {
    const hdr = req.headers["x-telegram-bot-api-secret-token"];
    if (hdr && hdr !== cfg.webhookSecret) {
      return res.status(403).json({ ok: false });
    }
  }
  res.status(200).json({ ok: true });
  const update = req.body;
  if (!update) return;
  setImmediate(() => {
    handleUpdate(update, cfg).catch(e => console.error("tg handle error:", e));
  });
}

function maskToken(t) {
  if (!t) return "";
  if (t.length <= 12) return "…";
  return t.slice(0, 8) + "…" + t.slice(-4);
}

export async function adminGet(req, res) {
  const cfg = await getConfig();
  res.json({
    ok: true,
    config: {
      enabled: cfg.enabled,
      publicUrl: cfg.publicUrl,
      allowedUserIds: cfg.allowedUserIds,
      adminUserIds: cfg.adminUserIds,
      defaultModel: cfg.defaultModel,
      greeting: cfg.greeting,
      systemPrompt: cfg.systemPrompt,
      hasToken: !!cfg.botToken,
      tokenMasked: maskToken(cfg.botToken),
      webhookSecret: cfg.webhookSecret,
      webhookPath: "/telegram/webhook"
    }
  });
}

export async function adminSave(req, res) {
  const body = req.body || {};
  const cfg = await getConfig();

  if (typeof body.botToken === "string" && body.botToken.trim()) {
    const t = body.botToken.trim();
    if (!/^\d+:[\w-]{20,}$/.test(t)) {
      return res.status(400).json({ ok: false, error: "Invalid bot token shape (expected 123456:AA…)" });
    }
    cfg.botToken = t;
  }
  if (typeof body.publicUrl === "string") cfg.publicUrl = body.publicUrl.trim().replace(/\/+$/, "");
  if (typeof body.enabled === "boolean") cfg.enabled = body.enabled;
  if (typeof body.defaultModel === "string") cfg.defaultModel = body.defaultModel.trim();
  if (typeof body.greeting === "string") cfg.greeting = body.greeting.trim().slice(0, 800);
  if (typeof body.systemPrompt === "string") cfg.systemPrompt = body.systemPrompt.trim().slice(0, 2000);
  if (Array.isArray(body.allowedUserIds)) {
    cfg.allowedUserIds = body.allowedUserIds
      .map(x => Number(String(x).replace(/[^\d-]/g, "")))
      .filter(Number.isFinite)
      .slice(0, 100);
  }
  if (Array.isArray(body.adminUserIds)) {
    cfg.adminUserIds = body.adminUserIds
      .map(x => Number(String(x).replace(/[^\d-]/g, "")))
      .filter(Number.isFinite)
      .slice(0, 20);
  }

  if (cfg.enabled && !cfg.webhookSecret) {
    cfg.webhookSecret = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  }

  await setConfig(cfg);
  res.json({ ok: true });
}

export async function adminSetWebhook(req, res) {
  const cfg = await getConfig();
  if (!cfg.botToken) return res.status(400).json({ ok: false, error: "Bot token required" });
  const base = (cfg.publicUrl || "").replace(/\/+$/, "");
  if (!base) return res.status(400).json({ ok: false, error: "Public URL required" });
  const url = base + "/telegram/webhook";

  try {
    await tgApi(cfg.botToken, "setWebhook", {
      url,
      secret_token: cfg.webhookSecret || undefined,
      allowed_updates: ["message"]
    });
    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

export async function adminDeleteWebhook(req, res) {
  const cfg = await getConfig();
  if (!cfg.botToken) return res.status(400).json({ ok: false, error: "Bot token required" });
  try {
    await tgApi(cfg.botToken, "deleteWebhook", {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

export async function adminGetMe(req, res) {
  const cfg = await getConfig();
  if (!cfg.botToken) return res.status(400).json({ ok: false, error: "Bot token required" });
  try {
    const me = await tgApi(cfg.botToken, "getMe", {});
    res.json({ ok: true, bot: { id: me.id, username: me.username, firstName: me.first_name } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
