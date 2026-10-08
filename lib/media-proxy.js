/* ============================================================
   Media endpoints — image / video / audio
   ============================================================
   Upstream paths are configurable via env vars so we don't
   hard-code guesses about 9Router's actual contract. Set the
   correct path once you've confirmed it, no code changes needed.
   ============================================================ */

const NINEROUTER_BASE = "https://ninerouter-china.onrender.com";

const IMAGE_PATH  = process.env.NINEROUTER_IMAGE_PATH  || "/v1/images/generations";
const VIDEO_PATH  = process.env.NINEROUTER_VIDEO_PATH  || "/v1/videos/generations";
const AUDIO_PATH  = process.env.NINEROUTER_AUDIO_PATH  || "/v1/audio/transcriptions";

const TIMEOUT_MS = 120000; // 2 min — media generation is slow

async function forwardJson(req, res, upstreamPath, extraHeaders = {}) {
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(`${NINEROUTER_BASE}${upstreamPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}`,
        "Content-Type": "application/json",
        ...extraHeaders
      },
      body: JSON.stringify(req.body || {}),
      signal: ctrl.signal
    });
    clearTimeout(timer);

    // Pass status + body through verbatim.
    const text = await upstream.text();
    const ct = upstream.headers.get("content-type") || "application/json";
    res.status(upstream.status).set("Content-Type", ct).send(text);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      return res.status(504).json({
        error: { message: "Media generation timed out.", type: "upstream_timeout" }
      });
    }
    console.error(`[media-proxy] ${upstreamPath} failed:`, e.message);
    res.status(502).json({
      error: { message: "Unable to reach the media provider.", type: "upstream_error" }
    });
  }
}

export async function imageGeneration(req, res) {
  console.log(`[image-generation] forwarding to ${IMAGE_PATH}`);
  return forwardJson(req, res, IMAGE_PATH);
}

export async function videoGeneration(req, res) {
  console.log(`[video-generation] forwarding to ${VIDEO_PATH}`);
  return forwardJson(req, res, VIDEO_PATH);
}

export async function audio(req, res) {
  console.log(`[audio] forwarding to ${AUDIO_PATH}`);
  return forwardJson(req, res, AUDIO_PATH);
}
