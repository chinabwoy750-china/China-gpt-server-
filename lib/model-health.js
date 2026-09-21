import { kvGet, kvPut } from "./kv.js";

const NINEROUTER_BASE = "https://ninerouter-china.onrender.com";
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
  return {
    disabledModels: Array.isArray(dm) ? dm : [],
    disabledProviders: Array.isArray(dp) ? dp : [],
    results: (rs && typeof rs === "object") ? rs : {}
  };
}

async function testModelDirect(modelId) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const r = await fetch(`${NINEROUTER_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false
      }),
      signal: controller.signal
    });
    const latency = Date.now() - start;
    if (r.ok) {
      return { status: "ok", latency, lastTested: new Date().toISOString(), errorMessage: null };
    }
    const text = await r.text().catch(() => "");
    return {
      status: "failed",
      latency,
      lastTested: new Date().toISOString(),
      errorMessage: `HTTP ${r.status}: ${text.slice(0, 240)}`
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
    const r = await fetch(`${NINEROUTER_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}` }
    });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: "Upstream error" });
    const j = await r.json();
    res.json({ ok: true, data: j.data || [] });
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

/* ---- Used by proxy.models to filter the upstream list ---- */

export async function getDisabledSnapshot() {
  const state = await getState();
  return {
    models: new Set(state.disabledModels || []),
    providers: new Set(state.disabledProviders || [])
  };
}
