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

/** Remove repeated "provider/" prefixes so talknova/talknova/x → x */
export function stripProviderPrefix(providerId, modelId) {
  let id = String(modelId || "").trim();
  const p = String(providerId || "").trim().toLowerCase();
  if (!id) return "";
  if (!p) return id;
  // strip leading provider/ repeatedly
  const re = new RegExp("^" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/", "i");
  while (re.test(id)) id = id.replace(re, "");
  return id.trim();
}

/** Unique list preserving order */
function uniqueIds(list, providerId) {
  const seen = new Set();
  const out = [];
  for (const x of list || []) {
    const raw = stripProviderPrefix(providerId, x);
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
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
  const authStyle = ["bearer", "x-api-key", "anthropic", "none"].includes(p.authStyle) ? p.authStyle : "bearer";

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
    models[cat] = uniqueIds(Array.isArray(p.models?.[cat]) ? p.models[cat] : [], id).slice(0, 500);
  }
  // A model id should live in only one category (prefer media over chat)
  const claimed = new Set();
  for (const cat of ["video", "image", "audio", "chat"]) {
    const next = [];
    for (const mid of models[cat]) {
      const k = mid.toLowerCase();
      if (claimed.has(k)) continue;
      claimed.add(k);
      next.push(mid);
    }
    models[cat] = next;
  }

  const modelsMeta = (p.modelsMeta && typeof p.modelsMeta === "object") ? p.modelsMeta : {};
  // Multiple accounts for round-robin (same baseUrl/provider family)
  let accounts = [];
  if (Array.isArray(p.accounts)) {
    for (const a of p.accounts.slice(0, 20)) {
      const key = String(a?.apiKey || a?.key || "").trim();
      if (!key || key.startsWith("••••")) continue;
      accounts.push({
        label: String(a?.label || "").trim().slice(0, 40) || "account",
        apiKey: key.slice(0, 500)
      });
    }
  }
  // Primary key still required for backward compat; if only accounts, use first
  let primaryKey = apiKey;
  if ((!primaryKey || primaryKey.startsWith("••••")) && accounts.length) {
    primaryKey = accounts[0].apiKey;
  }

  // Default Anthropic paths when style is anthropic and paths empty
  if (authStyle === "anthropic") {
    if (!paths.chat || paths.chat === "/v1/chat/completions") {
      paths.chat = paths.chat || "/v1/messages";
    }
  }

  return {
    id, label, baseUrl, apiKey: primaryKey, authStyle, paths, models, modelsMeta,
    accounts,
    roundRobin: p.roundRobin !== false && accounts.length > 1,
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
    hasApiKey: !!p.apiKey,
    accounts: Array.isArray(p.accounts)
      ? p.accounts.map(a => ({ label: a.label, apiKey: maskKey(a.apiKey) }))
      : []
  }));
  res.json({ ok: true, providers: safe });
}

export async function adminUpsert(req, res) {
  try {
    const clean = validateProvider(req.body || {});
    // Preserve existing key if the client sent back the mask.
    const existing = await findById(clean.id);
    if (!clean.apiKey || clean.apiKey.startsWith("••••")) {
      if (existing?.apiKey) clean.apiKey = existing.apiKey;
      else if (!(clean.accounts && clean.accounts.length)) {
        return res.status(400).json({ ok: false, error: "API key required" });
      }
    }
    // Preserve accounts when client sent empty (masked) list
    if ((!clean.accounts || !clean.accounts.length) && existing?.accounts?.length) {
      clean.accounts = existing.accounts;
      clean.roundRobin = existing.roundRobin !== false;
    }
    const all = await loadAll();
    const idx = all.findIndex(p => p.id === clean.id);
    if (idx >= 0) all[idx] = clean;
    else all.push(clean);
    await saveAll(all);
    try {
      const mod = await import("./proxy.js");
      if (mod.clearGroupsCache) mod.clearGroupsCache();
    } catch {}
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

  // Drop category overrides for this provider's models
  try {
    const { loadAll: loadCats } = await import("./model-categories.js");
    const { kvPut } = await import("./kv.js");
    const cats = await loadCats();
    let changed = false;
    for (const mid of Object.keys(cats)) {
      if (mid === id || mid.startsWith(id + "/")) {
        delete cats[mid];
        changed = true;
      }
    }
    if (changed) await kvPut("model:categories", cats);
  } catch (e) {
    console.warn("[providers/delete] category cleanup:", e.message);
  }

  // Strip this provider's models out of any combos
  try {
    const combos = await import("./model-combos.js");
    const list = await combos.listCombos();
    let dirty = false;
    const cleaned = list.map(c => {
      const models = (c.models || []).filter(m => {
        const s = String(m);
        return s !== id && !s.startsWith(id + "/");
      });
      if (models.length !== (c.models || []).length) dirty = true;
      return { ...c, models };
    }).filter(c => (c.models || []).length > 0);
    if (dirty) {
      // listCombos doesn't expose save — use kv directly
      const { kvPut } = await import("./kv.js");
      await kvPut("model-combos:v1", cleaned);
    }
  } catch (e) {
    console.warn("[providers/delete] combo cleanup:", e.message);
  }

  // Bust /v1/models group cache so deleted models vanish immediately
  try {
    const mod = await import("./proxy.js");
    if (mod.clearGroupsCache) mod.clearGroupsCache();
  } catch {}

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
    const authStyle = ["bearer", "x-api-key", "anthropic", "none"].includes(body.authStyle) ? body.authStyle : "bearer";
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
    else if (authStyle === "anthropic" && apiKey) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }

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

/** Flat OpenAI-style model rows for merging into /v1/models. */
export async function asCatalogEntries() {
  const all = await loadAll();
  const out = [];
  const seen = new Set();
  for (const p of all) {
    if (p.enabled === false) continue;
    for (const cat of ["chat", "image", "video", "audio"]) {
      for (const mid of uniqueIds(p.models?.[cat] || [], p.id)) {
        // Always namespace under this provider — never double-prefix
        const id = `${p.id}/${mid}`;
        const key = id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id,
          object: "model",
          owned_by: p.id,
          category: cat,
          type: cat,
          name: mid.split("/").pop()
        });
      }
    }
  }
  return out;
}


/** Probe whether an API key works against the provider base URL. */
export async function adminValidateKey(req, res) {
  try {
    const body = req.body || {};
    const baseUrl = normalizeProviderBase(body.baseUrl);
    const authStyle = ["bearer", "x-api-key", "anthropic", "none"].includes(body.authStyle) ? body.authStyle : "bearer";
    let apiKey = String(body.apiKey || "").trim();
    if (!apiKey || apiKey.startsWith("••••")) {
      const id = normalizeId(body.id);
      const existing = id ? await findById(id) : null;
      if (existing?.apiKey) apiKey = existing.apiKey;
    }
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Base URL required");
    if (!apiKey) throw new Error("API key required");

    const headers = { Accept: "application/json" };
    if (authStyle === "bearer") headers.Authorization = `Bearer ${apiKey}`;
    else if (authStyle === "x-api-key") headers["x-api-key"] = apiKey;
    else if (authStyle === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }

    const candidates = [
      `${baseUrl}/v1/models`,
      `${baseUrl}/models`,
      `${baseUrl}/v1/models?type=chat`
    ];
    let last = null;
    for (const url of candidates) {
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
        const text = await r.text().catch(() => "");
        if (r.ok) {
          return res.json({ ok: true, valid: true, status: r.status, url, message: "Key accepted" });
        }
        last = { status: r.status, url, body: text.slice(0, 200) };
        // 401/403 = invalid key
        if (r.status === 401 || r.status === 403) {
          return res.json({ ok: true, valid: false, status: r.status, url, message: "Key rejected by provider" });
        }
      } catch (e) {
        last = { error: e.message };
      }
    }
    // Some Anthropic-only gateways have no /models — treat non-auth errors as soft-ok
    if (last && last.status && last.status !== 401 && last.status !== 403) {
      return res.json({
        ok: true,
        valid: true,
        status: last.status,
        message: "Could not list models, but key was not rejected (HTTP " + last.status + "). Safe to save.",
        soft: true
      });
    }
    res.json({ ok: true, valid: false, message: last?.error || "Could not validate key", detail: last });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "validate failed" });
  }
}
