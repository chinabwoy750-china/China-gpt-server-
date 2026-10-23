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
  // Keep host root; paths already include /v1/... (avoids /v1/v1/...)
  let baseUrl = String(p.baseUrl || "").trim().replace(/\/+$/, "");
  baseUrl = baseUrl.replace(/\/v1$/i, "");
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

  const modelsMeta = (p.modelsMeta && typeof p.modelsMeta === "object") ? p.modelsMeta : {};
  return {
    id, label, baseUrl, apiKey, authStyle, paths, models, modelsMeta,
    enabled: p.enabled !== false
  };
}

export async function findById(id) {
  const all = await loadAll();
  return all.find(p => p.id === normalizeId(id)) || null;
}

/* Resolve a prefixed model ID to { provider, actualModelId } or null.
   Only matches when a custom provider is registered with that prefix.
   If the provider declares model lists, the id must appear there — this
   prevents hijacking 9Router ids like cf/@cf/... or nb/nanobanana-flash
   when someone registers a short provider id (cf, nb, openai, …). */
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

  const listed = [];
  for (const cat of ["chat", "image", "video", "audio"]) {
    for (const m of (provider.models?.[cat] || [])) listed.push(String(m));
  }
  if (listed.length) {
    const ok = listed.some(m =>
      m === rest || m === raw || m === `${prefix}/${rest}` || `${prefix}/${m}` === raw
    );
    if (!ok) return null;
  } else {
    // No explicit catalogue: still avoid claiming 9Router-style paths
    // (e.g. @cf/..., provider/model/version with extra slashes).
    if (rest.startsWith("@") || rest.includes("/")) return null;
  }

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

/** Strip trailing /v1 so we never request /v1/v1/models */
function normalizeProviderBase(url) {
  let u = String(url || "").trim().replace(/\/+$/, "");
  u = u.replace(/\/v1$/i, "");
  return u;
}

function mapProbeModels(data) {
  return (Array.isArray(data) ? data : []).map(x => {
    if (typeof x === "string") return { id: x };
    if (!x || typeof x !== "object" || !x.id) return null;
    const types = Array.isArray(x.supported_endpoint_types)
      ? x.supported_endpoint_types.map(String)
      : (Array.isArray(x.endpoints) ? x.endpoints.map(String)
        : (x.type ? [String(x.type)] : undefined));
    // Preserve TalkNova / gateway capability fields for UI badges + composer opts
    const keep = [
      "aspect_ratios", "supported_aspect_ratios", "aspects",
      "durations", "supported_durations", "duration_options", "max_duration", "min_duration",
      "qualities", "supported_qualities", "resolutions", "supported_resolutions",
      "mode", "modality", "description", "category", "capabilities"
    ];
    const extra = {};
    for (const k of keep) {
      if (x[k] != null) extra[k] = x[k];
    }
    return {
      id: String(x.id),
      supported_endpoint_types: types,
      name: x.name || undefined,
      type: x.type || undefined,
      ...extra
    };
  }).filter(Boolean);
}

export async function adminProbeModels(req, res) {
  try {
    const body = req.body || {};
    const baseUrl = normalizeProviderBase(body.baseUrl);
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

    // Try OpenAI list, then TalkNova-style type=all / type filters
    const candidates = [
      `${baseUrl}/v1/models?type=all`,
      `${baseUrl}/v1/models`,
      `${baseUrl}/v1/models?type=chat`,
    ];
    let models = [];
    let lastErr = null;
    for (const url of candidates) {
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
        if (!r.ok) { lastErr = new Error(`HTTP ${r.status} from ${url}`); continue; }
        const j = await r.json();
        const data = Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : []);
        const mapped = mapProbeModels(data);
        if (mapped.length) {
          models = mapped;
          break;
        }
      } catch (e) {
        lastErr = e;
      }
    }

    // Supplement image + video lists when provider supports type= filters (TalkNova)
    async function fetchType(type) {
      try {
        const r = await fetch(`${baseUrl}/v1/models?type=${type}`, {
          headers, signal: AbortSignal.timeout(12000)
        });
        if (!r.ok) return [];
        const j = await r.json();
        const data = Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : []);
        return mapProbeModels(data).map(m => ({
          ...m,
          supported_endpoint_types: m.supported_endpoint_types || [type],
          type: m.type || type
        }));
      } catch {
        return [];
      }
    }
    const [imgExtra, vidExtra] = await Promise.all([fetchType("image"), fetchType("video")]);
    const byId = new Map(models.map(m => [m.id, m]));
    for (const m of [...imgExtra, ...vidExtra]) {
      const prev = byId.get(m.id);
      if (!prev) byId.set(m.id, m);
      else {
        const types = new Set([
          ...(prev.supported_endpoint_types || []),
          ...(m.supported_endpoint_types || []),
          m.type
        ].filter(Boolean));
        byId.set(m.id, { ...prev, supported_endpoint_types: [...types] });
      }
    }
    models = [...byId.values()];

    if (!models.length && lastErr) throw lastErr;
    res.json({ ok: true, models, baseUrlNormalized: baseUrl });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || "Could not fetch models" });
  }
}
