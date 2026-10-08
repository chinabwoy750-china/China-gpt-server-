import { resolveTarget, buildAuthHeaders } from "./route-target.js";

const TIMEOUT_MS = 120000;

async function forwardMedia(req, res, kind) {
  const body = req.body || {};
  const modelId = String(body.model || "").trim();
  if (!modelId) {
    return res.status(400).json({
      error: { message: "A model must be specified.", type: "invalid_request_error", code: "model_required" }
    });
  }

  const target = await resolveTarget(modelId);

  // For 9Router, keep the historical path (allows env override); for
  // custom providers, use the provider's configured path for this kind.
  let upstreamPath;
  if (target.kind === "9router") {
    upstreamPath = process.env[`NINEROUTER_${kind.toUpperCase()}_PATH`] || target.paths[kind];
  } else {
    upstreamPath = target.paths[kind];
  }

  console.log(`[media:${kind}] ${modelId} → ${target.baseUrl}${upstreamPath} (${target.kind})`);

  const forwardBody = { ...body, model: target.actualModelId };
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(target.baseUrl + upstreamPath, {
      method: "POST",
      headers: buildAuthHeaders(target.authStyle, target.apiKey),
      body: JSON.stringify(forwardBody),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const ct = r.headers.get("content-type") || "application/json";
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status).set("Content-Type", ct).send(buf);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      return res.status(504).json({
        error: { message: "Media generation timed out.", type: "upstream_timeout" }
      });
    }
    res.status(502).json({
      error: { message: "Unable to reach the media provider.", type: "upstream_error" }
    });
  }
}

export async function imageGeneration(req, res) { return forwardMedia(req, res, "image"); }
export async function videoGeneration(req, res) { return forwardMedia(req, res, "video"); }
export async function audio(req, res) { return forwardMedia(req, res, "audio"); }
