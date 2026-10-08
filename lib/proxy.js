import { record } from "./usage.js";
import { getDisabledSnapshot, getCooldowns, getResultsSnapshot, recordFailure, recordSuccess } from "./model-health.js";
import { makerOf } from "./maker-detect.js";
import { getOverrides, applyOverrides } from "./provider-overrides.js";
import { loadPins } from "./model-groups.js";
import { canonicalKey, isFreeVariant, groupModels } from "./model-canonical.js";
import { executeTool } from "./tool-executor.js";
import { resolveTarget, buildAuthHeaders } from "./route-target.js";

const NINEROUTER_BASE = "https://ninerouter-china.onrender.com";
const MODELS_TIMEOUT_MS = 15000;

const HEADER_TIMEOUT_MS = 45000;
const FIRST_BYTE_TIMEOUT_MS = 60000;
const MAX_FAILOVER_ATTEMPTS = 4;

/* ============================================================
   Group cache
   ============================================================ */
let _groupsCache = null;
let _groupsCacheAt = 0;
const GROUPS_CACHE_MS = 5 * 60 * 1000;

function setGroupsCache(groups) {
  _groupsCache = groups;
  _groupsCacheAt = Date.now();
}
function getGroupsCache() {
  if (!_groupsCache) return null;
  if (Date.now() - _groupsCacheAt > GROUPS_CACHE_MS) return null;
  return _groupsCache;
}

function makePrimaryComparator(cooldowns = {}, health = {}) {
  const score = (id) => {
    let s = 0;
    if (!cooldowns[id]) s += 1000;
    const h = health[id];
    if (h?.status === "ok") s += 100;
    else if (!h) s += 50;
    const lat = h?.latency;
    if (Number.isFinite(lat)) s += Math.max(0, 100 - Math.min(lat, 100));
    return s;
  };
  return (a, b) => {
    const sa = score(a.id);
    const sb = score(b.id);
    if (sa !== sb) return sb - sa;
    if (a.id.length !== b.id.length) return a.id.length - b.id.length;
    return a.id.localeCompare(b.id);
  };
}

export async function buildGroups() {
  const cached = getGroupsCache();
  if (cached) return cached;

  const r = await fetch(`${NINEROUTER_BASE}/v1/models`, {
    headers: { Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`, Accept: "application/json" }
  });
  if (!r.ok) throw new Error(`Upstream HTTP ${r.status}`);
  const j = await r.json();
  const raw = Array.isArray(j.data) ? j.data : [];

  const [disabled, overrides, cooldowns, health, pins] = await Promise.all([
    getDisabledSnapshot(),
    getOverrides(),
    getCooldowns().catch(() => ({})),
    Promise.resolve(getResultsSnapshot()),
    loadPins()
  ]);

  const visible = raw.filter(m => {
    if (disabled.models.has(m.id)) return false;
    const auto = makerOf(m.id).key;
    const effective = applyOverrides(m.id, overrides) || auto;
    if (disabled.providers.has(effective)) return false;
    return true;
  });

  const groups = groupModels(visible, makePrimaryComparator(cooldowns, health));

  for (const g of groups) {
    const pin = pins[g.canonical];
    if (pin) {
      const found = g.variants.find(v => v.id === pin);
      if (found) g.primary = found;
    }
    if (!g.primary) g.primary = g.variants[0];
  }

  setGroupsCache(groups);
  return groups;
}

function classifyStatus(status) {
  if (status === 429) return "429";
  if (status >= 500 && status < 600) return "5xx";
  return null;
}
function isRetryableStatus(status) {
  return status === 429 || status === 404 || (status >= 500 && status < 600);
}

async function buildLadder(requestedModel) {
  const groups = getGroupsCache();
  if (!groups) return [requestedModel];

  const key = canonicalKey(requestedModel);
  const g = groups.find(x => x.canonical === key);
  if (!g || g.variants.length <= 1) return [requestedModel];

  const free = isFreeVariant(requestedModel);
  const siblings = g.variants
    .map(v => v.id)
    .filter(id => id !== requestedModel && isFreeVariant(id) === free);
  if (!siblings.length) return [requestedModel];

  const [cooldowns, health] = await Promise.all([
    getCooldowns().catch(() => ({})),
    Promise.resolve(getResultsSnapshot())
  ]);

  const score = (id) => {
    let s = 0;
    if (!cooldowns[id]) s += 1000;
    const h = health[id];
    if (h?.status === "ok") s += 100;
    else if (!h) s += 50;
    const lat = h?.latency;
    if (Number.isFinite(lat)) s += Math.max(0, 100 - Math.min(lat, 100));
    return s;
  };

  siblings.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  return [requestedModel, ...siblings].slice(0, MAX_FAILOVER_ATTEMPTS);
}

async function raceFirstByte(reader, ms) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
  });
  const read = reader.read()
    .then(r => ({ ok: !r.done && !!r.value, value: r.value }))
    .catch(() => ({ ok: false }));
  const result = await Promise.race([read, timeout]);
  clearTimeout(timer);
  return result;
}

async function attemptOnce({ bodyJson, variant, clientSignal }) {
  const ctrl = new AbortController();
  const onClient = () => ctrl.abort();
  if (clientSignal) {
    if (clientSignal.aborted) throw Object.assign(new Error("client aborted"), { name: "AbortError" });
    clientSignal.addEventListener("abort", onClient, { once: true });
  }
  const cleanup = () => {
    if (clientSignal) clientSignal.removeEventListener("abort", onClient);
  };

  const streaming = bodyJson && bodyJson.stream === true;

  try {
    const t1 = setTimeout(() => ctrl.abort(), HEADER_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${NINEROUTER_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        body: JSON.stringify({ ...bodyJson, model: variant }),
        signal: ctrl.signal
      });
    } catch (e) {
      if (clientSignal?.aborted) throw e;
      const err = Object.assign(
        new Error(e.name === "AbortError" ? "upstream header timeout" : (e.message || "network")),
        { retryable: true, reason: e.name === "AbortError" ? "timeout" : "network" }
      );
      throw err;
    } finally {
      clearTimeout(t1);
    }

    if (!res.ok) {
      const reason = classifyStatus(res.status);
      let bodyText = "";
      try { bodyText = await res.text(); } catch {}
      const err = Object.assign(new Error(`HTTP ${res.status}${bodyText ? " — " + bodyText.slice(0, 200) : ""}`), {
        status: res.status,
        retryable: isRetryableStatus(res.status),
        reason
      });
      throw err;
    }

    if (!streaming) {
      await recordSuccess(variant).catch(() => {});
      return { response: res, variant, streaming: false, reader: null, firstChunk: null };
    }

    const reader = res.body.getReader();
    const first = await raceFirstByte(reader, FIRST_BYTE_TIMEOUT_MS);
    if (!first.ok) {
      try { await reader.cancel(); } catch {}
      throw Object.assign(new Error("first-byte timeout"), { retryable: true, reason: "timeout" });
    }
    await recordSuccess(variant).catch(() => {});
    return { response: res, reader, firstChunk: first.value, variant, streaming: true };
  } catch (e) {
    if (e.reason) {
      await recordFailure(variant, e.reason).catch(() => {});
    }
    throw e;
  } finally {
    cleanup();
  }
}

async function attemptWithFailover(opts) {
  const ladder = opts.ladder && opts.ladder.length ? opts.ladder : [opts.bodyJson.model];
  let lastErr = null;
  for (let i = 0; i < ladder.length; i++) {
    const variant = ladder[i];
    try {
      return await attemptOnce({ ...opts, variant });
    } catch (e) {
      if (e.name === "AbortError" && opts.clientSignal?.aborted) throw e;
      lastErr = e;
      if (!e.retryable) throw e;
    }
  }
  throw lastErr || new Error("All variants failed");
}

/* ============================================================
   /v1/models
   ============================================================ */
export async function models(req, res) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  req.on("close", () => controller.abort());

  try {
    const upstream = await fetch(`${NINEROUTER_BASE}/v1/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    const body = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return res.status(upstream.status).set("Content-Type", "application/json").send(body);
    }

    if (payload && Array.isArray(payload.data)) {
      const [disabled, overrides, cooldowns, health, pins] = await Promise.all([
        getDisabledSnapshot(),
        getOverrides(),
        getCooldowns().catch(() => ({})),
        Promise.resolve(getResultsSnapshot()),
        loadPins()
      ]);

      const visible = payload.data.filter(m => {
        if (!m || typeof m.id !== "string") return false;
        if (disabled.models.has(m.id)) return false;
        const auto = makerOf(m.id).key;
        const effective = applyOverrides(m.id, overrides) || auto;
        if (disabled.providers.has(effective)) return false;
        return true;
      });

      const groups = groupModels(visible, makePrimaryComparator(cooldowns, health));
      for (const g of groups) {
        const pin = pins[g.canonical];
        if (pin) {
          const found = g.variants.find(v => v.id === pin);
          if (found) g.primary = found;
        }
        if (!g.primary) g.primary = g.variants[0];
      }
      setGroupsCache(groups);

      // Flat data[] still present for compatibility; groups[] for the UI.
      payload.data = visible;
      payload.groups = groups.map(g => ({
        canonical: g.canonical,
        primary: g.primary.id,
        variants: g.variants.map(v => ({ id: v.id, context_length: v.context_length || v.contextWindow || null })),
        hasFree: g.hasFree,
        providers: g.providers,
        pinned: pins[g.canonical] || null
      }));
    }

    return res.status(upstream.status).json(payload);
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") {
      return res.status(504).json({ error: { message: "Models request timed out.", type: "upstream_timeout" } });
    }
    return res.status(502).json({ error: { message: "Unable to reach the model provider.", type: "upstream_error" } });
  }
}

/* ============================================================
   /v1/chat/completions
   ============================================================ */
export async function chat(req, res) {
  const parsed = req.body;
  if (!parsed || typeof parsed !== "object") {
    return res.status(400).json({
      error: { message: "Request body must be valid JSON.", type: "invalid_request_error", code: "invalid_json" }
    });
  }
  if (!parsed.model) {
    return res.status(400).json({
      error: { message: "A model must be specified.", type: "invalid_request_error", code: "model_required" }
    });
  }

  // ---- Custom provider fast path ----
  const target = await resolveTarget(parsed.model);
  if (target.kind === "custom") {
    return forwardCustomChat(req, res, target, parsed);
  }

  const wantsTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;

  if (!wantsTools) {
    return chatSingleTurn(req, res, parsed);
  }
  return chatWithTools(req, res, parsed);
}

/* ---- Single-turn path with automatic failover ---- */
async function chatSingleTurn(req, res, parsed) {
  const forwardBody = { ...parsed };
  if (forwardBody.stream === true) {
    if (!forwardBody.stream_options || typeof forwardBody.stream_options !== "object") {
      forwardBody.stream_options = { include_usage: true };
    } else if (forwardBody.stream_options.include_usage === undefined) {
      forwardBody.stream_options.include_usage = true;
    }
  }

  const clientCtrl = new AbortController();
  req.on("close", () => clientCtrl.abort());

  // Ensure groups are warm for ladder building
  try { await buildGroups(); } catch {}

  const ladder = await buildLadder(forwardBody.model);
  const requested = forwardBody.model;

  let attempt;
  try {
    attempt = await attemptWithFailover({
      bodyJson: forwardBody,
      ladder,
      clientSignal: clientCtrl.signal
    });
  } catch (e) {
    if (e.name === "AbortError") return res.status(499).end();
    const status = e.status || 502;
    return res.status(status).json({
      error: {
        message: e.message || "Unable to reach the model provider.",
        type: "upstream_error"
      }
    });
  }

  const routing = attempt.variant !== requested ? "failover" : "passthrough";
  res.setHeader("X-China-GPT-Variant", attempt.variant);
  res.setHeader("X-China-GPT-Requested", parsed.model);
  res.setHeader("X-China-GPT-Routing", routing);
  res.setHeader("Access-Control-Expose-Headers", "X-China-GPT-Variant, X-China-GPT-Requested, X-China-GPT-Routing, X-Request-ID, Retry-After");

  if (!attempt.streaming) {
    const data = await attempt.response.json();
    if (data && data.usage) {
      record(null, req.auth, attempt.variant || data.model, data.usage).catch(() => {});
    }
    return res.json(data);
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // Write the first chunk we already consumed for first-byte race
  if (attempt.firstChunk) {
    res.write(Buffer.from(attempt.firstChunk));
  }

  // Tee remaining stream for usage + client
  // We only have a reader (not the full body), so stream directly
  const reader = attempt.reader;
  const decoder = new TextDecoder();
  let buffer = "", usage = null, model = attempt.variant;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const chunk = JSON.parse(raw);
          if (chunk.model) model = chunk.model;
          if (chunk.usage) usage = chunk.usage;
        } catch {}
      }
    }
  } catch {}
  res.end();
  if (usage) {
    record(null, req.auth, model, usage).catch(() => {});
  }
}


async function chatWithTools(req, res, parsed) {
  const MAX_ROUNDS = 5;
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const messages = Array.isArray(parsed.messages) ? [...parsed.messages] : [];
  const baseForward = {
    model: parsed.model,
    tools: parsed.tools,
    tool_choice: parsed.tool_choice || "auto",
    temperature: parsed.temperature,
    max_tokens: parsed.max_tokens,
    top_p: parsed.top_p,
    stream: true,
    stream_options: { include_usage: true }
  };

  let totalPrompt = 0, totalCompletion = 0, totalTokens = 0;
  let lastModel = parsed.model;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const forwardBody = { ...baseForward, messages };

    let upstream;
    try {
      upstream = await fetch(`${NINEROUTER_BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        body: JSON.stringify(forwardBody),
        signal: controller.signal
      });
    } catch (e) {
      if (e.name === "AbortError") return res.end();
      res.write(`data: ${JSON.stringify({ type: "error", message: "Unable to reach the model provider." })}\n\n`);
      res.end();
      return;
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      res.write(`data: ${JSON.stringify({ type: "error", message: text, status: upstream.status })}\n\n`);
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let assistantContent = "";
    const toolCallsByIndex = {};
    let usage = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;

        let j;
        try { j = JSON.parse(raw); } catch { continue; }

        if (j.model) lastModel = j.model;
        if (j.usage) usage = j.usage;

        const choice = j.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        if (delta.content) {
          assistantContent += delta.content;
          res.write(`data: ${JSON.stringify(j)}\n\n`);
        }

        const rc = delta.reasoning_content || delta.reasoning;
        if (rc) res.write(`data: ${JSON.stringify(j)}\n\n`);

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            if (!toolCallsByIndex[idx]) {
              toolCallsByIndex[idx] = { id: "", name: "", argsJson: "" };
            }
            if (tc.id) toolCallsByIndex[idx].id = tc.id;
            if (tc.function && tc.function.name) toolCallsByIndex[idx].name = tc.function.name;
            if (tc.function && tc.function.arguments) toolCallsByIndex[idx].argsJson += tc.function.arguments;
          }
        }
      }
    }

    if (usage) {
      totalPrompt += Number(usage.prompt_tokens) || 0;
      totalCompletion += Number(usage.completion_tokens) || 0;
      totalTokens += Number(usage.total_tokens) || 0;
    }

    const calls = Object.values(toolCallsByIndex).filter(tc => tc.name);

    if (calls.length === 0) {
      // Model finished without calling tools
      break;
    }

    // Append assistant's tool_call message
    messages.push({
      role: "assistant",
      content: assistantContent || null,
      tool_calls: calls.map(tc => ({
        id: tc.id || ("call_" + Math.random().toString(36).slice(2, 10)),
        type: "function",
        function: { name: tc.name, arguments: tc.argsJson || "{}" }
      }))
    });

    // Execute each tool and stream events
    for (let i = 0; i < calls.length; i++) {
      const tc = calls[i];
      const callId = messages[messages.length - 1].tool_calls[i].id;

      let args = {};
      try { args = JSON.parse(tc.argsJson || "{}"); } catch {}

      res.write(`data: ${JSON.stringify({
        type: "tool_start",
        id: callId,
        name: tc.name,
        args
      })}\n\n`);

      let result;
      let ok = true;
      try {
        result = await executeTool(tc.name, args);
      } catch (e) {
        ok = false;
        result = { ok: false, error: e.message || "Tool failed" };
      }

      res.write(`data: ${JSON.stringify({
        type: "tool_result",
        id: callId,
        name: tc.name,
        ok,
        result,
        error: ok ? null : result.error
      })}\n\n`);

      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: JSON.stringify(result)
      });
    }
  }

  res.write(`data: ${JSON.stringify({
    type: "done",
    usage: {
      prompt_tokens: totalPrompt,
      completion_tokens: totalCompletion,
      total_tokens: totalTokens
    },
    model: lastModel
  })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();

  if (totalTokens > 0) {
    record(null, req.auth, lastModel, {
      prompt_tokens: totalPrompt,
      completion_tokens: totalCompletion,
      total_tokens: totalTokens
    }).catch(() => {});
  }
}


export async function search(req, res) {
  const body = req.body || {};

  const query = String(body.query || "").trim();
  if (!query) {
    return res.status(400).json({
      error: { message: "A query is required.", type: "invalid_request_error" }
    });
  }

  const controller = new AbortController();
  req.on("close", () => controller.abort());
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const upstream = await fetch(`${NINEROUTER_BASE}/v1/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: body.model || "gemini",
        query,
        search_type: body.search_type || "web",
        max_results: Math.min(Math.max(Number(body.max_results) || 5, 1), 10)
      }),
      signal: controller.signal
    });

    clearTimeout(timer);
    const text = await upstream.text();
    res.status(upstream.status).set("Content-Type", "application/json").send(text);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      return res.status(504).json({
        error: { message: "Search timed out.", type: "upstream_timeout" }
      });
    }
    res.status(502).json({
      error: { message: "Unable to reach the search provider.", type: "upstream_error" }
    });
  }
}

export async function webFetch(req, res) {
  const body = req.body || {};
  const url = String(body.url || "").trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({
      error: { message: "A valid URL is required.", type: "invalid_request_error" }
    });
  }

  const controller = new AbortController();
  req.on("close", () => controller.abort());
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const upstream = await fetch(`${NINEROUTER_BASE}/v1/web/fetch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: String(body.model || "jina-reader"),
        url,
        format: body.format || "markdown",
        max_characters: Math.max(0, Number(body.max_characters) || 0)
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await upstream.text();
    res.status(upstream.status).set("Content-Type", "application/json").send(text);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      return res.status(504).json({ error: { message: "Fetch timed out.", type: "upstream_timeout" } });
    }
    res.status(502).json({ error: { message: "Unable to reach the fetch provider.", type: "upstream_error" } });
  }
}


async function forwardCustomChat(req, res, target, parsed) {
  const forwardBody = { ...parsed, model: target.actualModelId };
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  const timer = setTimeout(() => controller.abort(), 90000);

  let upstream;
  try {
    upstream = await fetch(target.baseUrl + target.paths.chat, {
      method: "POST",
      headers: {
        ...buildAuthHeaders(target.authStyle, target.apiKey),
        Accept: req.headers["accept"] || "text/event-stream"
      },
      body: JSON.stringify(forwardBody),
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError" && controller.signal.aborted) return res.status(499).end();
    return res.status(502).json({
      error: { message: `Could not reach custom provider "${target.providerId}".`, type: "upstream_error" }
    });
  }

  res.setHeader("X-China-GPT-Variant", parsed.model);
  res.setHeader("X-China-GPT-Requested", parsed.model);
  res.setHeader("X-China-GPT-Routing", "custom:" + target.providerId);

  if (!upstream.ok) {
    const text = await upstream.text();
    return res.status(upstream.status).set("Content-Type", "application/json").send(text);
  }

  const ct = upstream.headers.get("content-type") || "application/json";
  if (!ct.includes("text/event-stream")) {
    const text = await upstream.text();
    return res.status(upstream.status).set("Content-Type", ct).send(text);
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {}
  res.end();
}

/* Re-exported for the Anthropic-compatible layer.
   These are the same functions the OpenAI path uses internally. */
export { buildLadder, attemptWithFailover };
