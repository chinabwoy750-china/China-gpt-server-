import { kvGet, kvPut, kvList, kvDelete } from "./kv.js";
import { getNineRouterKey, getNineRouterBase } from "./ninerouter-config.js";
import { loadAll as loadCustomProviders } from "./custom-providers.js";

const DISABLED_MODELS_KEY = "health:disabled-models";
const DISABLED_PROVIDERS_KEY = "health:disabled-providers";
const RESULTS_KEY = "health:results";
const AUTO_DISABLE_THRESHOLD = 3;
const TEST_TIMEOUT_MS = 20000;

async function getState() {
  const [dm, dp, rs] = await Promise.all([
    kvGet(DISABLED_MODELS_KEY, "json"),
    kvGet(DISABLED_PROVIDERS_KEY, "json"),
    kvGet(RESULTS_KEY, "json")
  ]);
  _resultsCache = (rs && typeof rs === "object") ? rs : {};
  return {
    disabledModels: Array.isArray(dm) ? dm : [],
    disabledProviders: Array.isArray(dp) ? dp : [],
    results: _resultsCache
  };
}

/** Look up which modality a custom-provider model was registered under. */
async function categoryForModel(modelId) {
  const raw = String(modelId || "");
  try {
    const customs = await loadCustomProviders();
    for (const p of customs) {
      if (p.enabled === false) continue;
      for (const cat of ["image", "video", "audio", "chat"]) {
        for (const mid of (p.models?.[cat] || [])) {
          const bare = String(mid).trim();
          const full = bare.includes("/") ? bare : `${p.id}/${bare}`;
          if (full === raw || bare === raw || `${p.id}/${bare}` === raw) {
            return cat;
          }
        }
      }
    }
  } catch {}
  // Heuristic for gateway models
  try {
    const { isLikelyMediaModel, guessCategory } = await import("./model-kind.js");
    if (typeof guessCategory === "function") {
      const g = guessCategory(raw);
      if (g && g !== "chat") return g;
    }
    if (isLikelyMediaModel(raw)) {
      const id = raw.toLowerCase();
      if (/video|seedance|runway|kling|luma|sora/.test(id)) return "video";
      if (/audio|tts|whisper|speech|suno/.test(id)) return "audio";
      return "image";
    }
  } catch {}
  return "chat";
}

function buildHealthBody(category, modelId) {
  if (category === "image") {
    return {
      model: modelId,
      prompt: "health check: a simple red circle on white",
      n: 1,
      size: "256x256"
    };
  }
  if (category === "video") {
    return {
      model: modelId,
      prompt: "health check: a short abstract animation",
      n: 1
    };
  }
  if (category === "audio") {
    return {
      model: modelId,
      input: "Health check.",
      voice: "alloy"
    };
  }
  return {
    model: modelId,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
    stream: false
  };
}

function pathForCategory(paths, category) {
  const p = paths || {};
  if (category === "image") return p.image || "/v1/images/generations";
  if (category === "video") return p.video || "/v1/videos/generations";
  if (category === "audio") return p.audio || "/v1/audio/speech";
  return p.chat || "/v1/chat/completions";
}

async function testModelDirect(modelId) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  const requestedId = String(modelId || "");
  try {
    const category = await categoryForModel(requestedId);
    let url = null;
    let headers = { "Content-Type": "application/json", Accept: "application/json" };
    let upstreamModel = requestedId;

    try {
      const { resolveTarget, buildAuthHeaders } = await import("./route-target.js");
      const target = await resolveTarget(requestedId);
      if (target.kind === "custom") {
        const path = pathForCategory(target.paths, category);
        url = target.baseUrl.replace(/\/+$/, "") + path;
        Object.assign(headers, buildAuthHeaders(target.authStyle, target.apiKey));
        upstreamModel = target.actualModelId || requestedId;
      }
    } catch {}

    if (!url) {
      const key = await getNineRouterKey();
      const base = await getNineRouterBase();
      if (!key) {
        return {
          status: "failed",
          latency: Date.now() - start,
          lastTested: new Date().toISOString(),
          category,
          errorMessage: "NINEROUTER_API_KEY not configured (Admin → API Settings or Render env)"
        };
      }
      url = `${base}${pathForCategory(null, category)}`;
      headers.Authorization = `Bearer ${key}`;
    }

    const body = buildHealthBody(category, upstreamModel);
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const latency = Date.now() - start;
    // Some image APIs return 200 with data; some async 202 — both mean the route works
    if (r.ok || r.status === 202) {
      return {
        status: "ok",
        latency,
        lastTested: new Date().toISOString(),
        category,
        errorMessage: null
      };
    }
    const text = await r.text().catch(() => "");
    return {
      status: "failed",
      latency,
      lastTested: new Date().toISOString(),
      category,
      errorMessage: `HTTP ${r.status} [${category}]: ${text.slice(0, 240)}`
    };
  } catch (e) {
    return {
      status: "failed",
      latency: Date.now() - start,
      lastTested: new Date().toISOString(),
      errorMessage: e.name === "AbortError" ? "Timeout after 20s" : (e.message || "Unknown error")
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ---- Public endpoints ---- */

export async function get(req, res) {
  const state = await getState();
  res.json({ ok: true, ...state, autoDisableThreshold: AUTO_DISABLE_THRESHOLD });
}

export async function allModels(req, res) {
  try {
    const byId = new Map();
    let warning = null;

    // Custom provider models always available (do not depend on Nine Router)
    try {
      const customs = await loadCustomProviders();
      for (const p of customs) {
        if (p.enabled === false) continue;
        for (const cat of ["chat", "image", "video", "audio"]) {
          for (const mid of (p.models?.[cat] || [])) {
            const raw = String(mid).trim();
            if (!raw) continue;
            const id = raw.includes("/") ? raw : `${p.id}/${raw}`;
            byId.set(id, {
              id,
              object: "model",
              owned_by: p.id,
              source: "custom",
              category: cat
            });
          }
        }
      }
    } catch (e) {
      warning = (warning ? warning + " · " : "") + "custom providers: " + (e.message || "error");
    }

    // Nine Router catalogue
    const key = await getNineRouterKey();
    const base = await getNineRouterBase();
    if (!key) {
      warning = (warning ? warning + " · " : "") + "Nine Router key missing — set it in Admin → API Settings";
    } else {
      try {
        const r = await fetch(`${base}/v1/models`, {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          signal: AbortSignal.timeout(45000)
        });
        if (!r.ok) {
          warning = (warning ? warning + " · " : "") + `Nine Router /v1/models HTTP ${r.status}`;
        } else {
          const j = await r.json();
          for (const m of (j.data || [])) {
            if (m && typeof m.id === "string" && !byId.has(m.id)) {
              byId.set(m.id, { ...m, source: "9router" });
            }
          }
        }
      } catch (e) {
        warning = (warning ? warning + " · " : "") + "Nine Router unreachable: " + (e.message || e.name || "error");
      }
    }

    const data = [...byId.values()];
    res.json({ ok: true, data, total: data.length, warning });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || "Unreachable" });
  }
}

export async function testOne(req, res) {
  const modelId = String((req.body || {}).modelId || "").trim();
  if (!modelId) return res.status(400).json({ ok: false, error: "modelId required" });

  const result = await testModelDirect(modelId);
  const state = await getState();
  const prev = state.results[modelId] || {};

  result.consecutiveFailures = result.status === "failed"
    ? (prev.consecutiveFailures || 0) + 1
    : 0;

  state.results[modelId] = result;

  let autoDisabled = false;
  if (result.status === "failed" && result.consecutiveFailures >= AUTO_DISABLE_THRESHOLD) {
    if (!state.disabledModels.includes(modelId)) {
      state.disabledModels.push(modelId);
      autoDisabled = true;
    }
  }

  await Promise.all([
    kvPut(RESULTS_KEY, state.results),
    autoDisabled ? kvPut(DISABLED_MODELS_KEY, state.disabledModels) : Promise.resolve()
  ]);

  res.json({ ok: true, result, autoDisabled });
}

export async function disableModel(req, res) {
  const id = String((req.body || {}).modelId || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "modelId required" });
  const state = await getState();
  if (!state.disabledModels.includes(id)) {
    state.disabledModels.push(id);
    await kvPut(DISABLED_MODELS_KEY, state.disabledModels);
  }
  res.json({ ok: true, disabledModels: state.disabledModels });
}

/* Bulk-disable a list of model IDs in a single KV write.
   Used by the "Disable all failing" toolbar action so we don't
   fire 200+ sequential requests against Redis. */
export async function disableBatch(req, res) {
  const raw = Array.isArray((req.body || {}).modelIds) ? req.body.modelIds : [];
  const clean = raw.map(x => String(x || "").trim()).filter(Boolean).slice(0, 500);
  if (!clean.length) {
    return res.status(400).json({ ok: false, error: "modelIds required" });
  }
  const state = await getState();
  const set = new Set(state.disabledModels);
  let added = 0;
  for (const id of clean) {
    if (!set.has(id)) { set.add(id); added++; }
  }
  state.disabledModels = [...set];
  await kvPut(DISABLED_MODELS_KEY, state.disabledModels);
  res.json({ ok: true, disabledModels: state.disabledModels, added });
}

/* Clear the entire disabled-models list and reset every failure
   counter so nothing immediately re-trips on the next test. */
export async function enableAll(req, res) {
  const state = await getState();
  state.disabledModels = [];
  for (const id of Object.keys(state.results || {})) {
    if (state.results[id]) state.results[id].consecutiveFailures = 0;
  }
  await Promise.all([
    kvPut(DISABLED_MODELS_KEY, []),
    kvPut(RESULTS_KEY, state.results)
  ]);
  res.json({ ok: true, disabledModels: [] });
}

export async function enableModel(req, res) {
  const id = String((req.body || {}).modelId || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "modelId required" });
  const state = await getState();
  state.disabledModels = state.disabledModels.filter(x => x !== id);
  // Clear auto-disable counter so it doesn't immediately re-trip.
  if (state.results[id]) state.results[id].consecutiveFailures = 0;
  await Promise.all([
    kvPut(DISABLED_MODELS_KEY, state.disabledModels),
    kvPut(RESULTS_KEY, state.results)
  ]);
  res.json({ ok: true, disabledModels: state.disabledModels });
}

export async function disableProvider(req, res) {
  const p = String((req.body || {}).provider || "").trim().toLowerCase();
  if (!p) return res.status(400).json({ ok: false, error: "provider required" });
  const state = await getState();
  if (!state.disabledProviders.includes(p)) {
    state.disabledProviders.push(p);
    await kvPut(DISABLED_PROVIDERS_KEY, state.disabledProviders);
  }
  res.json({ ok: true, disabledProviders: state.disabledProviders });
}

export async function enableProvider(req, res) {
  const p = String((req.body || {}).provider || "").trim().toLowerCase();
  if (!p) return res.status(400).json({ ok: false, error: "provider required" });
  const state = await getState();
  state.disabledProviders = state.disabledProviders.filter(x => x !== p);
  await kvPut(DISABLED_PROVIDERS_KEY, state.disabledProviders);
  res.json({ ok: true, disabledProviders: state.disabledProviders });
}


/** Drop health results + disabled entries for model IDs no longer in the live catalogue. */
export async function prune(req, res) {
  try {
    const r = await fetch(`${await getNineRouterBase()}/v1/models`, {
      headers: { Authorization: `Bearer ${await getNineRouterKey()}` }
    });
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: "Could not fetch live catalogue" });
    }
    const j = await r.json();
    const live = new Set(
      (Array.isArray(j.data) ? j.data : [])
        .map(m => m && m.id)
        .filter(Boolean)
    );
    const state = await getState();
    const beforeResults = Object.keys(state.results || {}).length;
    const beforeDisabled = (state.disabledModels || []).length;

    const nextResults = {};
    for (const [id, val] of Object.entries(state.results || {})) {
      if (live.has(id)) nextResults[id] = val;
    }
    const nextDisabled = (state.disabledModels || []).filter(id => live.has(id));

    state.results = nextResults;
    state.disabledModels = nextDisabled;
    _resultsCache = nextResults;

    await Promise.all([
      kvPut(RESULTS_KEY, nextResults),
      kvPut(DISABLED_MODELS_KEY, nextDisabled)
    ]);

    res.json({
      ok: true,
      liveCount: live.size,
      resultsBefore: beforeResults,
      resultsAfter: Object.keys(nextResults).length,
      resultsRemoved: beforeResults - Object.keys(nextResults).length,
      disabledBefore: beforeDisabled,
      disabledAfter: nextDisabled.length,
      disabledRemoved: beforeDisabled - nextDisabled.length,
      disabledModels: nextDisabled,
      results: nextResults
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || "Prune failed" });
  }
}

/* ---- Used by proxy.models to filter the upstream list ---- */

export async function getDisabledSnapshot() {
  const state = await getState();
  return {
    models: new Set(state.disabledModels || []),
    providers: new Set(state.disabledProviders || [])
  };
}

/* ============================================================
   COOLDOWN TRACKING
   ============================================================
   When a chat request fails against a variant, the variant goes
   on a short cooldown so the failover ladder skips it next time.
   Cooldowns self-expire via Redis TTL. */
const COOLDOWN_KEY_PREFIX = "health:cooldown:";
const COOLDOWN_SECONDS = {
  "429": 60,
  "5xx": 300,
  "timeout": 300,
  "network": 120
};

let _resultsCache = {};
export function getResultsSnapshot() {
  return _resultsCache;
}

export async function recordFailure(modelId, reason) {
  const secs = COOLDOWN_SECONDS[reason];
  if (!secs) return; // unknown reason — don't cooldown
  const until = new Date(Date.now() + secs * 1000).toISOString();
  try {
    await kvPut(COOLDOWN_KEY_PREFIX + modelId, { until, reason }, { expirationTtl: secs });
  } catch (e) {
    console.error("cooldown write failed:", e);
  }
}

export async function recordSuccess(modelId) {
  try {
    await kvDelete(COOLDOWN_KEY_PREFIX + modelId);
  } catch {}
}

export async function getCooldowns() {
  const out = {};
  try {
    let cursor;
    let pages = 0;
    do {
      const r = await kvList(COOLDOWN_KEY_PREFIX, 500, cursor);
      for (const item of r.keys) {
        const id = item.name.slice(COOLDOWN_KEY_PREFIX.length);
        const v = await kvGet(item.name, "json");
        if (v && v.until) {
          const t = Date.parse(v.until);
          if (Number.isFinite(t) && t > Date.now()) {
            out[id] = v;
          }
        }
      }
      if (r.list_complete) break;
      cursor = r.cursor;
      pages++;
    } while (cursor && pages < 4);
  } catch (e) {
    console.error("getCooldowns failed:", e);
  }
  return out;
}
