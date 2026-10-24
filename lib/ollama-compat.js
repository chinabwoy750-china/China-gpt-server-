import { runCompletion, streamCompletion, extractTextFromOpenAI } from "./compat-shared.js";
import * as modelCatalog from "./model-catalog.js";
import * as proxy from "./proxy.js";

export async function handleTags(req, res) {
  try {
    const ids = new Set();
    // Categorized catalogue (includes custom providers)
    try {
      const fakeRes = {
        status() { return this; },
        json(o) { this._j = o; }
      };
      await modelCatalog.getAllCategorized(req, fakeRes);
      const cats = fakeRes._j || {};
      for (const k of ["chat", "image", "video", "audio"]) {
        for (const m of cats[k] || []) {
          if (m?.id) ids.add(m.id);
        }
      }
    } catch {}
    // Flat OpenAI-style list
    try {
      const captured = { body: null };
      const fakeRes = {
        status() { return this; },
        set() { return this; },
        json(obj) { captured.body = obj; return this; },
        send(t) { try { captured.body = JSON.parse(t); } catch {} return this; }
      };
      await proxy.models(req, fakeRes);
      for (const m of captured.body?.data || []) {
        if (m?.id) ids.add(m.id);
      }
    } catch {}

    const modelsOut = [...ids].sort().map(name => ({
      name,
      model: name,
      modified_at: new Date().toISOString(),
      size: 0,
      digest: "",
      details: {
        parent_model: "",
        format: "china-gpt",
        family: String(name).split("/")[0] || "unknown",
        parameter_size: "",
        quantization_level: ""
      }
    }));
    return res.json({ models: modelsOut });
  } catch (e) {
    return res.status(502).json({ error: e.message || "Failed to list models" });
  }
}

function ollamaMessagesToOpenAI(messages) {
  if (!Array.isArray(messages)) return [{ role: "user", content: "" }];
  return messages.map(m => ({
    role: m.role === "system" || m.role === "assistant" || m.role === "user" ? m.role : "user",
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")
  }));
}

export async function handleChat(req, res) {
  const body = req.body || {};
  const model = String(body.model || "").trim();
  if (!model) return res.status(400).json({ error: "model is required" });

  const openaiBody = {
    model,
    messages: ollamaMessagesToOpenAI(body.messages),
    stream: !!body.stream,
    temperature: body.options?.temperature,
    top_p: body.options?.top_p,
    max_tokens: body.options?.num_predict
  };
  Object.keys(openaiBody).forEach(k => openaiBody[k] === undefined && delete openaiBody[k]);

  if (openaiBody.stream) {
    try {
      await streamCompletion(req, res, openaiBody, {
        contentType: "application/x-ndjson",
        onChunk(line) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return false;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            res.write(JSON.stringify({
              model,
              created_at: new Date().toISOString(),
              message: { role: "assistant", content: "" },
              done: true
            }) + "\n");
            return false;
          }
          try {
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta?.content || "";
            if (delta) {
              res.write(JSON.stringify({
                model,
                created_at: new Date().toISOString(),
                message: { role: "assistant", content: delta },
                done: false
              }) + "\n");
            }
          } catch {}
          return false;
        }
      });
    } catch (e) {
      if (!res.headersSent) res.status(e.status || 502).json({ error: e.message });
    }
    return;
  }

  try {
    const { json } = await runCompletion(req, openaiBody);
    const text = extractTextFromOpenAI(json);
    return res.json({
      model,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: text },
      done: true,
      total_duration: 0,
      eval_count: json?.usage?.completion_tokens
    });
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message || "Upstream failure" });
  }
}

export async function handleGenerate(req, res) {
  const body = req.body || {};
  const model = String(body.model || "").trim();
  if (!model) return res.status(400).json({ error: "model is required" });
  const prompt = body.prompt != null ? String(body.prompt) : "";
  const system = body.system ? String(body.system) : "";
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const openaiBody = {
    model,
    messages,
    stream: !!body.stream,
    temperature: body.options?.temperature,
    max_tokens: body.options?.num_predict
  };
  Object.keys(openaiBody).forEach(k => openaiBody[k] === undefined && delete openaiBody[k]);

  if (openaiBody.stream) {
    try {
      await streamCompletion(req, res, openaiBody, {
        contentType: "application/x-ndjson",
        onChunk(line) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return false;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            res.write(JSON.stringify({ model, created_at: new Date().toISOString(), response: "", done: true }) + "\n");
            return false;
          }
          try {
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta?.content || "";
            if (delta) {
              res.write(JSON.stringify({
                model,
                created_at: new Date().toISOString(),
                response: delta,
                done: false
              }) + "\n");
            }
          } catch {}
          return false;
        }
      });
    } catch (e) {
      if (!res.headersSent) res.status(e.status || 502).json({ error: e.message });
    }
    return;
  }

  try {
    const { json } = await runCompletion(req, openaiBody);
    const text = extractTextFromOpenAI(json);
    return res.json({
      model,
      created_at: new Date().toISOString(),
      response: text,
      done: true
    });
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message || "Upstream failure" });
  }
}
