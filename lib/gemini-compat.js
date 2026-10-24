import { runCompletion, streamCompletion, extractTextFromOpenAI } from "./compat-shared.js";

function geminiContentsToMessages(body = {}) {
  const messages = [];
  const system =
    body.systemInstruction?.parts?.map(p => p.text || "").join("") ||
    body.system_instruction?.parts?.map(p => p.text || "").join("") ||
    body.systemInstruction?.text ||
    "";
  if (system) messages.push({ role: "system", content: system });

  const contents = Array.isArray(body.contents) ? body.contents : [];
  for (const c of contents) {
    const roleRaw = String(c.role || "user").toLowerCase();
    const role = roleRaw === "model" ? "assistant" : roleRaw === "function" ? "assistant" : "user";
    const parts = Array.isArray(c.parts) ? c.parts : [];
    const contentParts = [];
    let text = "";
    for (const p of parts) {
      if (p.text != null) text += p.text;
      else if (p.inlineData || p.inline_data) {
        const d = p.inlineData || p.inline_data;
        const mime = d.mimeType || d.mime_type || "image/png";
        const data = d.data || "";
        contentParts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${data}` } });
      }
    }
    if (contentParts.length) {
      if (text) contentParts.unshift({ type: "text", text });
      messages.push({ role, content: contentParts });
    } else {
      messages.push({ role, content: text });
    }
  }
  if (!messages.length) messages.push({ role: "user", content: "" });
  return messages;
}

function geminiToOpenAI(model, body = {}) {
  const gen = body.generationConfig || body.generation_config || {};
  const out = {
    model,
    messages: geminiContentsToMessages(body),
    temperature: gen.temperature,
    top_p: gen.topP ?? gen.top_p,
    max_tokens: gen.maxOutputTokens ?? gen.max_output_tokens,
    stream: false
  };
  Object.keys(out).forEach(k => out[k] === undefined && delete out[k]);
  return out;
}

function openAIToGemini(openaiResp) {
  const text = extractTextFromOpenAI(openaiResp);
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text }]
        },
        finishReason: "STOP",
        index: 0
      }
    ],
    usageMetadata: openaiResp?.usage
      ? {
          promptTokenCount: openaiResp.usage.prompt_tokens,
          candidatesTokenCount: openaiResp.usage.completion_tokens,
          totalTokenCount: openaiResp.usage.total_tokens
        }
      : undefined
  };
}

function modelFromParams(req) {
  // /v1beta/models/{model}:generateContent
  const raw = req.params?.model || req.params?.[0] || "";
  return decodeURIComponent(String(raw).replace(/:generateContent$/i, "").replace(/:streamGenerateContent$/i, ""));
}

export async function handleGenerateContent(req, res) {
  const model = modelFromParams(req) || req.body?.model;
  if (!model) {
    return res.status(400).json({ error: { message: "model is required in path", status: "INVALID_ARGUMENT" } });
  }
  try {
    const openaiBody = geminiToOpenAI(model, req.body || {});
    const { json, variant } = await runCompletion(req, openaiBody);
    res.setHeader("X-China-GPT-Variant", variant || model);
    return res.json(openAIToGemini(json));
  } catch (e) {
    return res.status(e.status || 502).json({
      error: { message: e.message || "Upstream failure", status: "INTERNAL" }
    });
  }
}

export async function handleStreamGenerateContent(req, res) {
  const model = modelFromParams(req) || req.body?.model;
  if (!model) {
    return res.status(400).json({ error: { message: "model is required in path", status: "INVALID_ARGUMENT" } });
  }
  try {
    const openaiBody = geminiToOpenAI(model, req.body || {});
    openaiBody.stream = true;
    await streamCompletion(req, res, openaiBody, {
      contentType: "text/event-stream",
      onChunk(line) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return false;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          res.write("data: [DONE]\n\n");
          return false;
        }
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content || "";
          if (delta) {
            const gem = {
              candidates: [{ content: { role: "model", parts: [{ text: delta }] }, index: 0 }]
            };
            res.write(`data: ${JSON.stringify(gem)}\n\n`);
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
}
