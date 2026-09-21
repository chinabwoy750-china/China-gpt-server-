import { record } from "./usage.js";

const NINEROUTER_BASE = "https://ninerouter-china.onrender.com";
const MODELS_TIMEOUT_MS = 15000;

export async function models(req, res) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  req.on("close", () => controller.abort());

  try {
    const upstream = await fetch(`${NINEROUTER_BASE}/v1/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const body = await upstream.text();
    res.status(upstream.status).set("Content-Type", "application/json").send(body);
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") {
      return res.status(504).json({
        error: { message: "The model provider took too long to respond.", type: "upstream_timeout" },
      });
    }
    res.status(502).json({
      error: { message: "Unable to reach the model provider.", type: "upstream_error" },
    });
  }
}

export async function chat(req, res) {
  const parsed = req.body;
  if (!parsed || typeof parsed !== "object") {
    return res.status(400).json({
      error: { message: "Request body must be valid JSON.", type: "invalid_request_error", code: "invalid_json" },
    });
  }
  if (!parsed.model) {
    return res.status(400).json({
      error: { message: "A model must be specified.", type: "invalid_request_error", code: "model_required" },
    });
  }

  const forwardBody = { ...parsed };
  if (forwardBody.stream === true) {
    if (!forwardBody.stream_options || typeof forwardBody.stream_options !== "object") {
      forwardBody.stream_options = { include_usage: true };
    } else if (forwardBody.stream_options.include_usage === undefined) {
      forwardBody.stream_options.include_usage = true;
    }
  }

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(`${NINEROUTER_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`,
        "Content-Type": "application/json",
        Accept: req.headers["accept"] || "text/event-stream",
      },
      body: JSON.stringify(forwardBody),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") return res.status(499).end();
    return res.status(502).json({
      error: { message: "Unable to reach the model provider.", type: "upstream_error" },
    });
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return res.status(upstream.status).set("Content-Type", "application/json").send(text);
  }

  const isStreaming = forwardBody.stream === true;

  if (!isStreaming) {
    const data = await upstream.json();
    if (data && data.usage) {
      record(null, req.auth, forwardBody.model || data.model, data.usage).catch(() => {});
    }
    return res.json(data);
  }

  // Streaming — tee the body so one branch streams to the client
  // and the other is read for usage accounting.
  const [clientStream, usageStream] = upstream.body.tee();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // Background usage parser
  (async () => {
    const reader = usageStream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage = null;
    let model = forwardBody.model || "unknown";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
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
      if (usage) await record(null, req.auth, model, usage);
    } catch (e) {
      console.error("Streaming usage collection failed:", e);
    }
  })();

  // Forward the client branch
  const reader = clientStream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (e) {
    // client disconnected — nothing to do
  } finally {
    res.end();
  }
}
