/**
 * Shared helpers for Responses / Gemini / Ollama compatibility layers.
 * Converts to OpenAI chat.completions, runs via the same upstream path as proxy.
 */
import { resolveTarget, buildAuthHeaders } from "./route-target.js";
import { buildLadder, attemptWithFailover } from "./proxy.js";

const NINEROUTER_BASE = "https://ninerouter-china.onrender.com";

export function extractTextFromOpenAI(resp) {
  if (!resp || typeof resp !== "object") return "";
  const choice = Array.isArray(resp.choices) ? resp.choices[0] : null;
  const msg = choice?.message || choice?.delta || {};
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(p => (typeof p === "string" ? p : p?.text || "")).join("");
  }
  if (typeof choice?.text === "string") return choice.text;
  return "";
}

export function extractReasoningFromOpenAI(resp) {
  const choice = Array.isArray(resp?.choices) ? resp.choices[0] : null;
  const msg = choice?.message || {};
  return msg.reasoning_content || msg.reasoning || resp?.reasoning || "";
}

/** Run a non-streaming OpenAI-style chat completion and return { status, json, headers }. */
export async function runCompletion(req, openaiBody) {
  const model = String(openaiBody.model || "").trim();
  if (!model) {
    const err = new Error("A model must be specified.");
    err.status = 400;
    throw err;
  }

  const body = { ...openaiBody, stream: false };
  const target = await resolveTarget(model);

  if (target.kind === "custom") {
    const path = (target.paths && target.paths.chat) || "/v1/chat/completions";
    const upstreamModel = target.actualModelId || model;
    const r = await fetch(target.baseUrl + path, {
      method: "POST",
      headers: {
        ...buildAuthHeaders(target.authStyle, target.apiKey),
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ ...body, model: upstreamModel }),
      signal: AbortSignal.timeout(180000)
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { error: { message: text.slice(0, 400) } }; }
    if (!r.ok) {
      const err = new Error(json?.error?.message || json?.message || `Upstream HTTP ${r.status}`);
      err.status = r.status;
      err.json = json;
      throw err;
    }
    return { status: r.status, json, variant: model };
  }

  let ladder = [model];
  try { ladder = await buildLadder(model); } catch {}

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const attempt = await attemptWithFailover({
    bodyJson: body,
    ladder,
    clientSignal: controller.signal
  });

  if (attempt.streaming) {
    // Should not happen with stream:false — drain as text
    const text = await attempt.response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { error: { message: text.slice(0, 400) } }; }
    return { status: attempt.response.status, json, variant: attempt.variant };
  }

  const json = await attempt.response.json();
  return { status: attempt.response.status, json, variant: attempt.variant };
}

/** Stream OpenAI SSE from upstream; yields parsed data objects / raw lines. */
export async function streamCompletion(req, res, openaiBody, { onChunk, contentType = "text/event-stream" } = {}) {
  const model = String(openaiBody.model || "").trim();
  if (!model) {
    res.status(400).json({ error: { message: "A model must be specified." } });
    return;
  }

  const body = { ...openaiBody, stream: true };
  const target = await resolveTarget(model);
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  let reader = null;
  let firstChunk = null;

  if (target.kind === "custom") {
    const path = (target.paths && target.paths.chat) || "/v1/chat/completions";
    const upstreamModel = target.actualModelId || model;
    const upstream = await fetch(target.baseUrl + path, {
      method: "POST",
      headers: {
        ...buildAuthHeaders(target.authStyle, target.apiKey),
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify({ ...body, model: upstreamModel }),
      signal: controller.signal
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      let msg = text.slice(0, 400);
      try { msg = JSON.parse(text)?.error?.message || msg; } catch {}
      return res.status(upstream.status).json({ error: { message: msg || "Upstream error" } });
    }
    reader = upstream.body?.getReader?.() || null;
  } else {
    let ladder = [model];
    try { ladder = await buildLadder(model); } catch {}
    const attempt = await attemptWithFailover({
      bodyJson: body,
      ladder,
      clientSignal: controller.signal
    });
    res.setHeader("X-China-GPT-Variant", attempt.variant || model);
    if (attempt.streaming) {
      reader = attempt.reader;
      firstChunk = attempt.firstChunk;
    } else {
      // Unexpected non-stream — dump JSON as one chunk
      const json = await attempt.response.json();
      const fake = `data: ${JSON.stringify(json)}\n\ndata: [DONE]\n\n`;
      res.status(200);
      res.setHeader("Content-Type", contentType);
      if (onChunk) {
        for (const line of fake.split("\n")) onChunk(line);
      } else res.write(fake);
      return res.end();
    }
  }

  res.status(200);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const decoder = new TextDecoder();
  let buffer = "";

  const handleLine = (line) => {
    if (onChunk) {
      const out = onChunk(line);
      if (out != null && out !== false) res.write(typeof out === "string" ? out : line + "\n");
    } else {
      res.write(line + "\n");
    }
  };

  if (firstChunk) {
    buffer += decoder.decode(firstChunk, { stream: true });
  }

  if (!reader) {
    return res.end();
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() || "";
    for (const line of parts) handleLine(line);
  }
  if (buffer) handleLine(buffer);
  res.end();
}
