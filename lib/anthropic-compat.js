import { buildLadder, attemptWithFailover } from "./proxy.js";

const NINEROUTER_BASE = "https://ninerouter-china.onrender.com";

/* ============================================================
   Main route handler for POST /v1/messages
   ============================================================ */
export async function handleMessages(req, res) {
  let openaiBody;
  try {
    openaiBody = anthropicToOpenAIBody(req.body);
  } catch (e) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: e.message }
    });
  }

  const wantsStream = openaiBody.stream === true;
  const requestedModel = openaiBody.model;

  // Build the failover ladder for the requested model.
  let ladder = [requestedModel];
  try {
    ladder = await buildLadder(requestedModel);
  } catch {}

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  let attempt;
  try {
    attempt = await attemptWithFailover({
      url: `${NINEROUTER_BASE}/v1/chat/completions`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`,
        "Content-Type": "application/json",
        Accept: wantsStream ? "text/event-stream" : "application/json"
      },
      bodyJson: openaiBody,
      ladder,
      clientSignal: controller.signal
    });
  } catch (e) {
    if (e.name === "AbortError" && controller.signal.aborted) return res.status(499).end();
    const status = Number.isFinite(e.status) ? e.status : 502;
    return res.status(status).json({
      type: "error",
      error: { type: "api_error", message: e.message || "Upstream failure" }
    });
  }

  res.setHeader("X-China-GPT-Variant", attempt.variant);
  res.setHeader("X-China-GPT-Requested", requestedModel);
  res.setHeader("X-China-GPT-Routing",
    attempt.variant === requestedModel ? "passthrough" : "failover");

  // ---- Non-streaming ----
  if (!attempt.streaming) {
    try {
      const openaiResp = await attempt.response.json();
      const anthropicResp = openAIToAnthropicResponse(openaiResp, requestedModel);
      return res.json(anthropicResp);
    } catch (e) {
      return res.status(502).json({
        type: "error",
        error: { type: "api_error", message: "Failed to parse upstream response" }
      });
    }
  }

  // ---- Streaming ----
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // If we got a first chunk during the failover race, prepend it.
  if (attempt.firstChunk) {
    let preChunk = new TextDecoder().decode(attempt.firstChunk, { stream: true });
    const wrappedReader = {
      async read() {
        if (preChunk) {
          const val = new TextEncoder().encode(preChunk);
          preChunk = "";
          return { value: val, done: false };
        }
        return attempt.reader.read();
      },
      cancel: () => attempt.reader.cancel()
    };
    await streamOpenAIToAnthropic(wrappedReader, res, requestedModel);
  } else {
    await streamOpenAIToAnthropic(attempt.reader, res, requestedModel);
  }
  res.end();
}

/* ============================================================
   ANTHROPIC → OPENAI REQUEST TRANSLATION
   ============================================================ */

function anthropicContentToOpenAI(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      parts.push({ type: "text", text: String(block.text || "") });
    } else if (block.type === "image") {
      const src = block.source || {};
      if (src.type === "base64" && src.data) {
        const mime = src.media_type || "image/jpeg";
        parts.push({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${src.data}` }
        });
      } else if (src.type === "url" && src.url) {
        parts.push({ type: "image_url", image_url: { url: src.url } });
      }
    } else if (block.type === "tool_result") {
      parts.push({
        __tool_result: true,
        tool_use_id: block.tool_use_id,
        content: typeof block.content === "string"
          ? block.content
          : (Array.isArray(block.content)
              ? block.content.map(x => x.text || "").join("")
              : "")
      });
    } else if (block.type === "tool_use") {
      parts.push({
        __tool_use: true,
        id: block.id,
        name: block.name,
        input: block.input || {}
      });
    }
  }
  if (parts.every(p => p.type === "text")) {
    return parts.map(p => p.text).join("");
  }
  return parts;
}

export function anthropicToOpenAIBody(reqBody) {
  const body = reqBody || {};
  const out = {};

  out.model = String(body.model || "").trim();
  if (!out.model) throw new Error("model is required");

  const maxTokens = Number(body.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) out.max_tokens = maxTokens;

  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    out.stop = body.stop_sequences;
  }

  const messages = [];
  if (body.system) {
    messages.push({ role: "system", content: String(body.system) });
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || !m.role) continue;
      const converted = anthropicContentToOpenAI(m.content);

      if (Array.isArray(converted) && converted.some(p => p.__tool_result)) {
        for (const part of converted) {
          if (part.__tool_result) {
            messages.push({
              role: "tool",
              tool_call_id: part.tool_use_id,
              content: part.content || ""
            });
          }
        }
        const textParts = converted.filter(p => p.type === "text" || p.type === "image_url");
        if (textParts.length) {
          messages.push({ role: m.role, content: textParts });
        }
      } else if (Array.isArray(converted) && converted.some(p => p.__tool_use)) {
        const toolUses = converted.filter(p => p.__tool_use);
        const textParts = converted.filter(p => p.type === "text");
        messages.push({
          role: "assistant",
          content: textParts.length ? textParts.map(p => p.text).join("") : null,
          tool_calls: toolUses.map(tu => ({
            id: tu.id,
            type: "function",
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input || {})
            }
          }))
        });
      } else {
        messages.push({ role: m.role, content: converted });
      }
    }
  }
  out.messages = messages;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter(t => t && t.name)
      .map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.input_schema || { type: "object", properties: {} }
        }
      }));
    if (body.tool_choice) {
      if (body.tool_choice.type === "auto") out.tool_choice = "auto";
      else if (body.tool_choice.type === "any") out.tool_choice = "required";
      else if (body.tool_choice.type === "tool" && body.tool_choice.name) {
        out.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
      }
    }
  }

  out.stream = body.stream === true;
  return out;
}

/* ============================================================
   OPENAI → ANTHROPIC RESPONSE TRANSLATION
   ============================================================ */

function finishReasonToStopReason(fr) {
  if (fr === "length") return "max_tokens";
  if (fr === "tool_calls" || fr === "function_call") return "tool_use";
  if (fr === "content_filter") return "stop_sequence";
  return "end_turn";
}

export function openAIToAnthropicResponse(openaiResp, requestedModel) {
  const choice = openaiResp?.choices?.[0] || {};
  const msg = choice.message || {};
  const blocks = [];

  if (typeof msg.content === "string" && msg.content.length) {
    blocks.push({ type: "text", text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      blocks.push({
        type: "tool_use",
        id: tc.id || ("toolu_" + Math.random().toString(36).slice(2, 12)),
        name: tc.function?.name || "unknown",
        input
      });
    }
  }
  if (!blocks.length) blocks.push({ type: "text", text: "" });

  const usage = openaiResp?.usage || {};
  return {
    id: "msg_" + Math.random().toString(36).slice(2, 14),
    type: "message",
    role: "assistant",
    model: openaiResp?.model || requestedModel,
    content: blocks,
    stop_reason: finishReasonToStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens) || 0,
      output_tokens: Number(usage.completion_tokens) || 0
    }
  };
}

/* ============================================================
   SSE STREAM TRANSLATION (OpenAI chunks → Anthropic events)
   ============================================================ */

export async function streamOpenAIToAnthropic(reader, res, requestedModel) {
  const decoder = new TextDecoder();

  let buf = "";
  let messageStarted = false;
  let contentBlockStarted = false;
  let contentBlockIndex = 0;
  let stopReason = "end_turn";
  let modelName = requestedModel;
  let inputTokens = 0;
  let outputTokens = 0;
  const toolCallsByIndex = {};
  let messageId = "msg_" + Math.random().toString(36).slice(2, 14);

  function send(eventType, payload) {
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function startMessage() {
    messageStarted = true;
    send("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: modelName,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  function startTextBlock() {
    if (contentBlockStarted) return;
    contentBlockStarted = true;
    send("content_block_start", {
      type: "content_block_start",
      index: contentBlockIndex,
      content_block: { type: "text", text: "" }
    });
  }

  function emitTextDelta(text) {
    if (!text) return;
    startTextBlock();
    send("content_block_delta", {
      type: "content_block_delta",
      index: contentBlockIndex,
      delta: { type: "text_delta", text }
    });
  }

  function stopTextBlock() {
    if (!contentBlockStarted) return;
    send("content_block_stop", {
      type: "content_block_stop",
      index: contentBlockIndex
    });
    contentBlockStarted = false;
    contentBlockIndex++;
  }

  function processLine(line) {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    let j;
    try { j = JSON.parse(raw); } catch { return; }
    if (j.model) modelName = j.model;
    if (j.usage) {
      inputTokens = Number(j.usage.prompt_tokens) || inputTokens;
      outputTokens = Number(j.usage.completion_tokens) || outputTokens;
    }

    const choice = j.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (choice.finish_reason) {
      stopReason = finishReasonToStopReason(choice.finish_reason);
    }

    if (!messageStarted) startMessage();

    if (delta.content) {
      emitTextDelta(delta.content);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        if (!toolCallsByIndex[idx]) {
          toolCallsByIndex[idx] = { id: "", name: "", argsJson: "" };
        }
        if (tc.id) toolCallsByIndex[idx].id = tc.id;
        if (tc.function?.name) toolCallsByIndex[idx].name = tc.function.name;
        if (tc.function?.arguments) toolCallsByIndex[idx].argsJson += tc.function.arguments;
      }
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) processLine(line);
    }
    if (buf) processLine(buf);
  } catch (e) {
    // Stream error — best effort close.
  }

  if (!messageStarted) startMessage();
  stopTextBlock();

  for (const idx of Object.keys(toolCallsByIndex).sort()) {
    const tc = toolCallsByIndex[idx];
    if (!tc.name) continue;
    let input = {};
    try { input = JSON.parse(tc.argsJson || "{}"); } catch {}
    const blockIndex = contentBlockIndex++;
    send("content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: tc.id || ("toolu_" + Math.random().toString(36).slice(2, 12)),
        name: tc.name,
        input: {}
      }
    });
    send("content_block_delta", {
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) }
    });
    send("content_block_stop", { type: "content_block_stop", index: blockIndex });
  }

  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens }
  });
  send("message_stop", { type: "message_stop" });
  res.write("data: [DONE]\n\n");
}
