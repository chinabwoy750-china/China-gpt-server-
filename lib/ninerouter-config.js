import { kvGet, kvPut } from "./kv.js";

const KV_KEY = "config:ninerouter";
const DEFAULT_BASE = "https://ninerouter-china.onrender.com";

/** Resolve Nine Router API key: KV override wins, then env. */
export async function getNineRouterKey() {
  try {
    const cfg = await kvGet(KV_KEY, "json");
    if (cfg && typeof cfg.apiKey === "string" && cfg.apiKey.trim()) {
      return cfg.apiKey.trim();
    }
  } catch {}
  const env = process.env.NINEROUTER_API_KEY;
  return env && String(env).trim() ? String(env).trim() : "";
}

export async function getNineRouterBase() {
  try {
    const cfg = await kvGet(KV_KEY, "json");
    if (cfg && typeof cfg.baseUrl === "string" && /^https?:\/\//i.test(cfg.baseUrl.trim())) {
      return cfg.baseUrl.trim().replace(/\/+$/, "");
    }
  } catch {}
  return process.env.NINEROUTER_BASE || DEFAULT_BASE;
}

export async function getNineRouterConfig() {
  const cfg = (await kvGet(KV_KEY, "json").catch(() => null)) || {};
  const envKey = Boolean(process.env.NINEROUTER_API_KEY);
  const kvKey = Boolean(cfg.apiKey && String(cfg.apiKey).trim());
  return {
    apiKeyConfigured: envKey || kvKey,
    source: kvKey ? "admin" : (envKey ? "env" : "none"),
    baseUrl: await getNineRouterBase(),
    // never return the raw key
    apiKeyMasked: kvKey
      ? ("••••••" + String(cfg.apiKey).trim().slice(-4))
      : (envKey ? "(from Render env)" : "")
  };
}

export async function setNineRouterKey(apiKey, baseUrl) {
  const prev = (await kvGet(KV_KEY, "json").catch(() => null)) || {};
  const next = { ...prev };
  if (apiKey != null) {
    const k = String(apiKey).trim();
    if (!k || k.startsWith("••••")) {
      // keep existing
    } else {
      next.apiKey = k.slice(0, 200);
    }
  }
  if (baseUrl != null) {
    const b = String(baseUrl).trim().replace(/\/+$/, "");
    if (b && /^https?:\/\//i.test(b)) next.baseUrl = b.slice(0, 300);
  }
  next.updatedAt = new Date().toISOString();
  await kvPut(KV_KEY, next);
  return getNineRouterConfig();
}

/** Admin handlers */
export async function adminGet(req, res) {
  const c = await getNineRouterConfig();
  res.json({ ok: true, ...c });
}

export async function adminSave(req, res) {
  try {
    const body = req.body || {};
    const c = await setNineRouterKey(body.apiKey, body.baseUrl);
    res.json({ ok: true, ...c });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "save failed" });
  }
}
