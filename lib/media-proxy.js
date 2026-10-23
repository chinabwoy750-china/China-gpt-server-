import { resolveTarget, buildAuthHeaders } from "./route-target.js";

const TIMEOUT_MS = 180000;
const VIDEO_POLL_MS = 2500;
const VIDEO_POLL_MAX = 90; // ~3.75 min

const DEFAULT_PATHS = {
  image: ["/v1/images/generations"],
  // TalkNova: POST /v1/video ; OpenAI-compat gateways: /v1/videos/generations
  video: ["/v1/video", "/v1/videos/generations", "/v1/video/generations"],
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
  return [...new Set(list.filter(Boolean))];
}

function extractUpstreamMessage(buf, status, path) {
  const raw = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
  let msg = "";
  try {
    let j = JSON.parse(raw);
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
  if (status === 404 || /not found/i.test(msg)) {
    msg = path
      ? `Not found at ${path}. Check the provider video path (TalkNova uses /v1/video).`
      : "Not found.";
  }
  if (status === 406 || /\[406\]/.test(msg) || /reset after/i.test(msg)) {
    msg += " — the media provider timed out or rejected the request. Try again, or pick another model.";
  }
  if (/response modalities|modalities \(TEXT\)|not supported by/i.test(msg)) {
    msg += " — this TTS model needs AUDIO modality (not TEXT).";
  }
  return msg;
}

function shapeVideoBody(body) {
  const out = { ...body };
  delete out.background;
  delete out.image_detail;
  delete out.n;
  // duration / length
  if (out.duration == null && out.length != null) {
    out.duration = Number(out.length) || 5;
  }
  if (out.duration != null) out.duration = Number(out.duration) || 5;
  // aspect ratio aliases
  if (out.aspect && !out.aspect_ratio) out.aspect_ratio = out.aspect;
  if (out.aspect_ratio) {
    const ar = String(out.aspect_ratio);
    // Some gateways want size like 1280x720
    if (!out.size && ar === "16:9") out.size = "1280x720";
    else if (!out.size && ar === "9:16") out.size = "720x1280";
    else if (!out.size && ar === "1:1") out.size = "1024x1024";
  }
  if (out.quality && !out.resolution) out.resolution = out.quality;
  return out;
}

function pickVideoUrl(j) {
  if (!j || typeof j !== "object") return null;
  if (typeof j.url === "string" && /^https?:\/\//i.test(j.url)) return j.url;
  if (typeof j.video_url === "string") return j.video_url;
  if (typeof j.content_url === "string") return j.content_url;
  if (j.output && typeof j.output.url === "string") return j.output.url;
  if (Array.isArray(j.data)) {
    for (const item of j.data) {
      if (item?.url) return item.url;
      if (item?.video_url) return item.video_url;
    }
  }
  if (Array.isArray(j.videos)) {
    for (const item of j.videos) {
      if (typeof item === "string") return item;
      if (item?.url) return item.url;
    }
  }
  return null;
}

function isAsyncJob(j) {
  if (!j || typeof j !== "object") return false;
  if (pickVideoUrl(j)) return false;
  const id = j.id || j.job_id || j.task_id;
  if (!id) return false;
  const status = String(j.status || j.state || "pending").toLowerCase();
  if (/fail|error|cancel/.test(status)) return false;
  return true;
}

async function pollVideoJob(target, jobId, signal) {
  const base = String(target.baseUrl || "").replace(/\/+$/, "");
  const candidates = [
    `${base}/v1/video/${jobId}`,
    `${base}/v1/videos/${jobId}`,
    `${base}/v1/video/jobs/${jobId}`,
    `${base}/v1/videos/generations/${jobId}`
  ];
  for (let i = 0; i < VIDEO_POLL_MAX; i++) {
    if (signal.aborted) throw new Error("Aborted");
    await new Promise(r => setTimeout(r, VIDEO_POLL_MS));
    for (const url of candidates) {
      try {
        const r = await fetch(url, {
          headers: buildAuthHeaders(target.authStyle, target.apiKey),
          signal
        });
        if (!r.ok) continue;
        const j = await r.json().catch(() => null);
        if (!j) continue;
        const status = String(j.status || j.state || "").toLowerCase();
        if (/fail|error|cancel/.test(status)) {
          throw new Error(j.error?.message || j.message || `Video job ${status}`);
        }
        let urlOut = pickVideoUrl(j);
        if (!urlOut && /complete|success|done|ready|succeeded/.test(status)) {
          // content endpoint
          const contentUrls = [
            `${base}/v1/video/${jobId}/content`,
            `${base}/v1/videos/${jobId}/content`
          ];
          for (const cu of contentUrls) {
            try {
              const cr = await fetch(cu, {
                headers: buildAuthHeaders(target.authStyle, target.apiKey),
                signal,
                redirect: "follow"
              });
              if (cr.ok) {
                const ct = (cr.headers.get("content-type") || "").toLowerCase();
                if (ct.includes("video") || ct.includes("octet")) {
                  const buf = Buffer.from(await cr.arrayBuffer());
                  const b64 = buf.toString("base64");
                  const mime = ct.includes("webm") ? "video/webm" : "video/mp4";
                  return { data: [{ url: `data:${mime};base64,${b64}` }] };
                }
                const loc = cr.headers.get("location");
                if (loc) urlOut = loc;
                else {
                  const cj = await cr.json().catch(() => null);
                  urlOut = pickVideoUrl(cj);
                }
              }
            } catch {}
          }
        }
        if (urlOut) return { data: [{ url: urlOut }], id: jobId, status: "completed" };
      } catch (e) {
        if (e.message && /fail|error|cancel/i.test(e.message)) throw e;
      }
    }
  }
  throw new Error("Video generation timed out. Try a shorter duration or another model.");
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

  const upstreamModel = target.kind === "9router" ? modelId : target.actualModelId;
  let forwardBody = { ...body, model: upstreamModel };

  if (kind === "audio") {
    if (!forwardBody.input && forwardBody.prompt) {
      forwardBody.input = String(forwardBody.prompt).slice(0, 4096);
    }
    delete forwardBody.prompt;
    delete forwardBody.n;
    delete forwardBody.size;
    delete forwardBody.quality;
    delete forwardBody.background;
    delete forwardBody.image_detail;
    delete forwardBody.output_format;
    delete forwardBody.duration;
    delete forwardBody.aspect_ratio;
    delete forwardBody.aspect;
    if (!forwardBody.response_format) forwardBody.response_format = "mp3";

    const mid = String(upstreamModel || modelId).toLowerCase();
    const isGeminiTts = /gemini/i.test(mid) && /tts|speech|audio/i.test(mid);
    if (isGeminiTts) {
      if (!forwardBody.voice || forwardBody.voice === "alloy") forwardBody.voice = "Kore";
      forwardBody.response_modalities = ["AUDIO"];
      forwardBody.modalities = ["audio"];
      forwardBody.generationConfig = {
        ...(forwardBody.generationConfig && typeof forwardBody.generationConfig === "object"
          ? forwardBody.generationConfig : {}),
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: String(forwardBody.voice || "Kore") }
          }
        }
      };
      if (!forwardBody.contents) {
        forwardBody.contents = [{
          role: "user",
          parts: [{ text: String(forwardBody.input || "") }]
        }];
      }
    } else if (!forwardBody.voice) {
      forwardBody.voice = "alloy";
    }
  }

  if (kind === "video") {
    forwardBody = shapeVideoBody(forwardBody);
  }

  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    let lastErr = null;
    let successBuf = null;
    let successCt = "application/json";
    let successStatus = 200;
    let usedPath = paths[0];

    for (const upstreamPath of paths) {
      usedPath = upstreamPath;
      console.log(`[media:${kind}] ${modelId} → ${target.baseUrl}${upstreamPath} (${target.kind}) model=${upstreamModel}`);
      try {
        const r = await fetch(target.baseUrl + upstreamPath, {
          method: "POST",
          headers: buildAuthHeaders(target.authStyle, target.apiKey),
          body: JSON.stringify(forwardBody),
          signal: ctrl.signal
        });
        const ct = r.headers.get("content-type") || "application/json";
        const buf = Buffer.from(await r.arrayBuffer());
        if (!r.ok) {
          const message = extractUpstreamMessage(buf, r.status, upstreamPath);
          console.warn(`[media:${kind}] upstream ${r.status} @ ${upstreamPath}: ${message.slice(0, 200)}`);
          lastErr = { status: r.status, message, path: upstreamPath };
          // Try next path on 404 / not found
          if (r.status === 404 || /not found/i.test(message)) continue;
          return res.status(r.status >= 400 && r.status < 600 ? r.status : 502).json({
            error: { message, type: "upstream_error", status: r.status, path: upstreamPath, model: upstreamModel }
          });
        }
        successBuf = buf;
        successCt = ct;
        successStatus = r.status;
        break;
      } catch (e) {
        if (e.name === "AbortError") throw e;
        lastErr = { status: 502, message: e.message || "Upstream fetch failed", path: upstreamPath };
        continue;
      }
    }

    if (!successBuf) {
      clearTimeout(timer);
      return res.status(lastErr?.status || 502).json({
        error: {
          message: lastErr?.message || "Video endpoint not found. Set the custom provider video path to /v1/video.",
          type: "upstream_error",
          path: lastErr?.path
        }
      });
    }

    // Async video job (TalkNova-style)
    if (kind === "video" && /json/i.test(successCt)) {
      try {
        const j = JSON.parse(successBuf.toString("utf8"));
        if (isAsyncJob(j)) {
          const jobId = j.id || j.job_id || j.task_id;
          console.log(`[media:video] polling job ${jobId}`);
          const finalJ = await pollVideoJob(target, jobId, ctrl.signal);
          clearTimeout(timer);
          return res.json(finalJ);
        }
        // Already has a URL
        if (pickVideoUrl(j) && !j.data) {
          clearTimeout(timer);
          return res.json({ data: [{ url: pickVideoUrl(j) }], ...j });
        }
      } catch (e) {
        if (e.message && !/JSON/.test(e.message)) {
          clearTimeout(timer);
          return res.status(502).json({ error: { message: e.message, type: "upstream_error" } });
        }
      }
    }

    clearTimeout(timer);
    res.status(successStatus).set("Content-Type", successCt).send(successBuf);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      return res.status(504).json({ error: { message: "Media request timed out.", type: "timeout" } });
    }
    console.error(`[media:${kind}]`, e);
    res.status(502).json({ error: { message: e.message || "Media proxy failed", type: "upstream_error" } });
  }
}

export async function imageGeneration(req, res) { return forwardMedia(req, res, "image"); }
export async function videoGeneration(req, res) { return forwardMedia(req, res, "video"); }
export async function audioSpeech(req, res) { return forwardMedia(req, res, "audio"); }
