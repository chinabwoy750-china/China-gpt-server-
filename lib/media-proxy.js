import { resolveTarget, buildAuthHeaders } from "./route-target.js";

const TIMEOUT_MS = 120000;

const DEFAULT_PATHS = {
  image: ["/v1/images/generations", "/v1/image/generations"],
  video: ["/v1/videos/generations", "/v1/video/generations"],
  audio: ["/v1/audio/speech", "/v1/audio"]
};

function candidatePaths(kind, target) {
  const envKey = `NINEROUTER_${kind.toUpperCase()}_PATH`;
  const envPath = process.env[envKey];
  const list = [];
  if (target.kind === "9router") {
    if (envPath) list.push(envPath);
    if (target.paths && target.paths[kind]) list.push(target.paths[kind]);
    for (const p of (DEFAULT_PATHS[kind] || [])) {
      if (!list.includes(p)) list.push(p);
    }
  } else {
    if (target.paths && target.paths[kind]) list.push(target.paths[kind]);
    for (const p of (DEFAULT_PATHS[kind] || [])) {
      if (!list.includes(p)) list.push(p);
    }
  }
  return list;
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
  const paths = candidatePaths(kind, target);
  if (!paths.length) {
    return res.status(502).json({
      error: { message: `No upstream path configured for ${kind}.`, type: "upstream_error" }
    });
  }

  const forwardBody = { ...body, model: target.actualModelId };
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let lastStatus = 502;
  let lastBody = null;
  let lastCt = "application/json";
  let lastPath = paths[0];

  try {
    for (const upstreamPath of paths) {
      lastPath = upstreamPath;
      console.log(`[media:${kind}] ${modelId} → ${target.baseUrl}${upstreamPath} (${target.kind})`);
      let r;
      try {
        r = await fetch(target.baseUrl + upstreamPath, {
          method: "POST",
          headers: buildAuthHeaders(target.authStyle, target.apiKey),
          body: JSON.stringify(forwardBody),
          signal: ctrl.signal
        });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        lastStatus = 502;
        lastBody = Buffer.from(JSON.stringify({
          error: { message: e.message || "network error", type: "upstream_error" }
        }));
        continue;
      }

      const ct = r.headers.get("content-type") || "application/json";
      const buf = Buffer.from(await r.arrayBuffer());
      lastStatus = r.status;
      lastBody = buf;
      lastCt = ct;

      // Retry alternate paths only on clear "not found" style failures
      if (r.status === 404 || r.status === 405) continue;

      // Some gateways return 200/400 JSON with "Endpoint not found"
      if (ct.includes("json")) {
        try {
          const j = JSON.parse(buf.toString("utf8"));
          const msg = String(j?.error?.message || j?.error || j?.message || "").toLowerCase();
          if (msg.includes("endpoint not found") || msg.includes("not found") && msg.includes("endpoint")) {
            continue;
          }
        } catch {}
      }

      clearTimeout(timer);
      return res.status(r.status).set("Content-Type", ct).send(buf);
    }

    clearTimeout(timer);
    // All candidates failed — surface last response, or a helpful 404
    if (lastBody) {
      return res.status(lastStatus).set("Content-Type", lastCt).send(lastBody);
    }
    return res.status(404).json({
      error: {
        message: `Upstream ${kind} endpoint not found (tried ${paths.join(", ")} on ${target.baseUrl}).`,
        type: "upstream_error",
        code: "endpoint_not_found"
      }
    });
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
