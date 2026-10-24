import { runCompletion, streamCompletion, extractTextFromOpenAI, extractReasoningFromOpenAI } from "./compat-shared.js";

function inputToMessages(input, instructions) {
  const messages = [];
  if (instructions) messages.push({ role: "system", content: String(instructions) });

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    // Already a message { role, content }
    if (item.role && (item.content != null || item.parts)) {
      let content = item.content;
      if (Array.isArray(content)) {
        content = content.map(p => {
          if (typeof p === "string") return p;
          if (p?.type === "input_text" || p?.type === "text") return p.text || "";
          if (p?.type === "input_image" || p?.type === "image_url") {
            return { type: "image_url", image_url: { url: p.image_url?.url || p.url || p.image } };
          }
          return p?.text || "";
        });
        // flatten pure text arrays
        if (content.every(c => typeof c === "string")) content = content.join("\n");
      }
      messages.push({ role: item.role, content: content ?? "" });
      continue;
    }
    // Responses item types
    if (item.type === "message" && item.role) {
      messages.push({ role: item.role, content: typeof item.content === "string" ? item.content : JSON.stringify(item.content) });
    } else if (item.type === "input_text") {
      messages.push({ role: "user", content: item.text || "" });
    }
  }
  if (!messages.length) messages.push({ role: "user", content: "" });
  return messages;
}

function responsesToOpenAI(body = {}) {
  const model = String(body.model || "").trim();
  if (!model) throw new Error("model is required");
  const messages = inputToMessages(body.input, body.instructions);
  const out = {
    model,
    messages,
    stream: !!body.stream,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_output_tokens || body.max_tokens
  };
  if (body.tools) out.tools = body.tools;
  if (body.tool_choice) out.tool_choice = body.tool_choice;
  // Strip undefined
  Object.keys(out).forEach(k => out[k] === undefined && delete out[k]);
  return out;
}

function openAIToResponses(openaiResp, requestedModel) {
  const text = extractTextFromOpenAI(openaiResp);
  const reasoning = extractReasoningFromOpenAI(openaiResp);
  const id = openaiResp?.id || `resp_${Date.now().toString(36)}`;
  const output = [];
  if (reasoning) {
    output.push({
      type: "reasoning",
      id: `rs_${id}`,
      summary: [{ type: "summary_text", text: String(reasoning) }]
    });
  }
  output.push({
    type: "message",
    id: `msg_${id}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }]
  });
  return {
    id,
    object: "response",
    created_at: openaiResp?.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel || openaiResp?.model,
    output,
    usage: openaiResp?.usage || undefined,
    // Convenience for simple clients
    output_text: text
  };
}

export async function handleResponses(req, res) {
  let openaiBody;
  try {
    openaiBody = responsesToOpenAI(req.body || {});
  } catch (e) {
    return res.status(400).json({
      error: { message: e.message, type: "invalid_request_error" }
    });
  }

  const requestedModel = openaiBody.model;

  if (openaiBody.stream) {
    try {
      let full = "";
      await streamCompletion(req, res, openaiBody, {
        contentType: "text/event-stream",
        onChunk(line) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return false;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`);
            return false;
          }
          try {
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta?.content || "";
            if (delta) {
              full += delta;
              res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`);
            }
          } catch {}
          return false;
        }
      });
    } catch (e) {
      if (!res.headersSent) {
        res.status(e.status || 502).json({ error: { message: e.message || "Upstream failure" } });
      }
    }
    return;
  }

  try {
    const { json, variant } = await runCompletion(req, openaiBody);
    res.setHeader("X-China-GPT-Variant", variant || requestedModel);
    return res.json(openAIToResponses(json, requestedModel));
  } catch (e) {
    return res.status(e.status || 502).json({
      error: { message: e.message || "Upstream failure", type: "api_error" },
      ...(e.json ? { upstream: e.json } : {})
    });
  }
}
