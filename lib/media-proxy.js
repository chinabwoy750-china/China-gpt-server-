import { resolveTarget, buildAuthHeaders } from "./route-target.js";

const TIMEOUT_MS = 180000; // image providers can be slow; 9Router itself may still cut at ~30s

const DEFAULT_PATHS = {
  // Only real 9Router paths — do not probe /v1/image/generations (returns "Endpoint not found")
  image: ["/v1/images/generations"],
  video: ["/v1/videos/generations"],
  audio: ["/v1/audio/speech"]
};

function candidatePaths(kind, target) {
  const envKey = `NINEROUTER_${kind.toUpperCase()}_PATH`;
  const envPath = process.env[envKey];
  const list = [];
  if (envPath) list.push(envPath);
  if (target.paths && target.paths[kind]) list.push(target.paths[kind]);
  for (const p of (DEFAULT_PATHS[kind] || [])) {
    if (!list.includes(p)) list.push(p);
  }
  // de-dupe while preserving order
  return [...new Set(list.filter(Boolean))];
}

/** Flatten nested error payloads so the UI sees one readable line. */
function extractUpstreamMessage(buf, status, path) {
  const raw = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
  let msg = "";
  try {
    let j = JSON.parse(raw);
    // Unwrap repeated {"error":{"message":"HTTP 503 — {...}"}} layers
    for (let i = 0; i < 4; i++) {
      const m = j?.error?.message ?? j?.error ?? j?.message;
      if (typeof m === "string") {
        msg = m;
        const inner = m.replace(/^HTTP\s+\d+\s*[—\-:]?\s*/i, "").trim();
        if (inner.startsWith("{")) {
          try { j = JSON.parse(inner); continue; } catch { break; }
        }
        break;
      }
      if (m && typeof m === "object") { j = m; continue; }
      break;
    }
  } catch {
    msg = raw.slice(0, 300);
  }
  msg = String(msg || `Upstream HTTP ${status}`).trim();
  if (status === 406 || /\[406\]/.test(msg) || /reset after/i.test(msg)) {
    msg += " — the image provider timed out or rejected the request. Try again, or pick another image model.";
  }
  return msg;
}

async function forwardMedia(req, res, kind) {
  const body = req.body || {};
  const modelId = String(body.model || "").trim();
  if (!modelId) {
    return res.status(400).json({
      error: { message: "A model must be specified.", type: "invalid_request_error", code: "model_required" }
    });
  }

  const target = await resolveTarget(modelId);
  // Safety: if a custom provider id collides with a 9Router prefix (e.g. "nb"),
  // still prefer 9Router when the custom base is empty/broken — resolveTarget
  // already only matches registered custom providers.

  const paths = candidatePaths(kind, target);
  if (!paths.length) {
    return res.status(502).json({
      error: { message: `No upstream path configured for ${kind}.`, type: "upstream_error" }
    });
  }

  // Forward body as-is; keep model id 9Router expects (nb/nanobanana-flash etc.)
  const forwardBody = { ...body, model: target.actualModelId };
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    // Single canonical path (no alternate probes that invent "Endpoint not found")
    const upstreamPath = paths[0];
    console.log(`[media:${kind}] ${modelId} → ${target.baseUrl}${upstreamPath} (${target.kind}) model=${target.actualModelId}`);

    const r = await fetch(target.baseUrl + upstreamPath, {
      method: "POST",
      headers: buildAuthHeaders(target.authStyle, target.apiKey),
      body: JSON.stringify(forwardBody),
      signal: ctrl.signal
    });
    clearTimeout(timer);

    const ct = r.headers.get("content-type") || "application/json";
    const buf = Buffer.from(await r.arrayBuffer());

    if (!r.ok) {
      const message = extractUpstreamMessage(buf, r.status, upstreamPath);
      console.warn(`[media:${kind}] upstream ${r.status}: ${message.slice(0, 200)}`);
      return res.status(r.status >= 400 && r.status < 600 ? r.status : 502).json({
        error: {
          message,
          type: "upstream_error",
          status: r.status,
          path: upstreamPath,
          model: target.actualModelId
        }
      });
    }

    // Success — pass through (JSON url / b64 or binary image)
    res.status(r.status).set("Content-Type", ct).send(buf);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      return res.status(504).json({
        error: {
          message: "Image generation timed out waiting for the provider. Try again or use a faster model.",
          type: "upstream_timeout"
        }
      });
    }
    res.status(502).json({
      error: { message: e.message || "Unable to reach the media provider.", type: "upstream_error" }
    });
  }
}

export async function imageGeneration(req, res) { return forwardMedia(req, res, "image"); }
export async function videoGeneration(req, res) { return forwardMedia(req, res, "video"); }
export async function audio(req, res) { return forwardMedia(req, res, "audio"); }
