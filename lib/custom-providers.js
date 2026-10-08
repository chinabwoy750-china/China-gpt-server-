import { kvGet, kvPut } from "./kv.js";

const KEY = "providers:custom";

export async function loadAll() {
  const list = await kvGet(KEY, "json");
  return Array.isArray(list) ? list : [];
}

export async function saveAll(list) {
  await kvPut(KEY, list);
  return list;
}

export function normalizeId(id) {
  return String(id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
}

export function validateProvider(p) {
  const id = normalizeId(p.id);
  if (!id) throw new Error("Provider ID required (letters, numbers, dash, underscore)");
  const label = String(p.label || "").trim().slice(0, 60) || id;
  const baseUrl = String(p.baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Base URL must start with http(s)://");
  const apiKey = String(p.apiKey || "").trim().slice(0, 500);
  const authStyle = ["bearer", "x-api-key", "none"].includes(p.authStyle) ? p.authStyle : "bearer";

  const defaultPaths = {
    chat: "/v1/chat/completions",
    image: "/v1/images/generations",
    video: "/v1/videos/generations",
    audio: "/v1/audio/speech"
  };
  const paths = {};
  for (const k of Object.keys(defaultPaths)) {
    const v = String(p.paths?.[k] || defaultPaths[k]).trim();
    paths[k] = v.startsWith("/") ? v : "/" + v;
  }

  const models = {};
  for (const cat of ["chat", "image", "video", "audio"]) {
    models[cat] = Array.isArray(p.models?.[cat])
      ? p.models[cat].map(x => String(x).trim()).filter(Boolean).slice(0, 500)
      : [];
  }

  return {
    id, label, baseUrl, apiKey, authStyle, paths, models,
    enabled: p.enabled !== false
  };
}

export async function findById(id) {
  const all = await loadAll();
  return all.find(p => p.id === normalizeId(id)) || null;
}

/* Resolve a prefixed model ID to { provider, actualModelId } or null. */
export async function resolveForModel(modelId) {
  const raw = String(modelId || "");
  const slash = raw.indexOf("/");
  if (slash === -1) return null;
  const prefix = raw.slice(0, slash).toLowerCase();
  const rest = raw.slice(slash + 1);
  if (!rest) return null;
  const all = await loadAll();
  const provider = all.find(p => p.id === prefix && p.enabled !== false);
  if (!provider) return null;
  return { provider, actualModelId: rest };
}

/* ---- Admin routes ---- */

function maskKey(k) {
  if (!k) return "";
  if (k.length <= 8) return "••••••••";
  return "••••••" + k.slice(-4);
}

export async function adminList(req, res) {
  const all = await loadAll();
  const safe = all.map(p => ({
    ...p,
    apiKey: maskKey(p.apiKey),
    hasApiKey: !!p.apiKey
  }));
  res.json({ ok: true, providers: safe });
}

export async function adminUpsert(req, res) {
  try {
    const clean = validateProvider(req.body || {});
    // Preserve existing key if the client sent back the mask.
    if (!clean.apiKey || clean.apiKey.startsWith("••••••")) {
      const existing = await findById(clean.id);
      if (existing?.apiKey) clean.apiKey = existing.apiKey;
      else return res.status(400).json({ ok: false, error: "API key required" });
    }
    const all = await loadAll();
    const idx = all.findIndex(p => p.id === clean.id);
    if (idx >= 0) all[idx] = clean;
    else all.push(clean);
    await saveAll(all);
    res.json({ ok: true, provider: { ...clean, apiKey: maskKey(clean.apiKey) } });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

export async function adminDelete(req, res) {
  const id = normalizeId(req.body?.id);
  if (!id) return res.status(400).json({ ok: false, error: "Provider ID required" });
  const all = await loadAll();
  const next = all.filter(p => p.id !== id);
  await saveAll(next);
  res.json({ ok: true, removed: all.length - next.length });
}

export async function adminProbeModels(req, res) {
  try {
    const body = req.body || {};
    const baseUrl = String(body.baseUrl || "").trim().replace(/\/+$/, "");
    const authStyle = ["bearer", "x-api-key", "none"].includes(body.authStyle) ? body.authStyle : "bearer";
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Base URL required");

    let apiKey = String(body.apiKey || "").trim();
    if (!apiKey || apiKey.startsWith("••••••")) {
      const id = normalizeId(body.id);
      const existing = id ? await findById(id) : null;
      if (existing?.apiKey) apiKey = existing.apiKey;
    }

    const headers = { Accept: "application/json" };
    if (authStyle === "bearer" && apiKey) headers.Authorization = `Bearer ${apiKey}`;
    else if (authStyle === "x-api-key" && apiKey) headers["x-api-key"] = apiKey;

    const r = await fetch(`${baseUrl}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const data = Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : []);
    const models = data.map(x => {
      if (typeof x === "string") return { id: x };
      if (!x || typeof x !== "object" || !x.id) return null;
      return {
        id: String(x.id),
        supported_endpoint_types: Array.isArray(x.supported_endpoint_types)
          ? x.supported_endpoint_types.map(String)
          : (Array.isArray(x.endpoints) ? x.endpoints.map(String) : undefined),
        name: x.name || undefined
      };
    }).filter(Boolean);
    res.json({ ok: true, models });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || "Could not fetch models" });
  }
}
