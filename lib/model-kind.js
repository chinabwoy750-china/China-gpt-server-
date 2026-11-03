/** Heuristic media-vs-chat classification for catalogue filtering. */

const IMAGE_RE = /flux|stable.?diffusion|sdxl|sd[\-_]?3|dall-?e|imagen|midjourney|nanobanana|seedream|playground|ideogram|recraft|gpt-image|qwen-image|image-gen|text2img|txt2img|img2img|@cf\/|black-forest|lucid.?origin|phoenix.?1|dreamshaper|kandinsky|wuerstchen|sd-v|sdxl|kolors|hunyuan-dit|cogview|nova-canvas|amazon\.titan-image|gemini.*image|gpt-image/i;

const VIDEO_RE = /veo|sora|runway|kling|seedance|hailuo|luma|pika|cogvideo|hunyuan-video|vivix|text-to-video|image-to-video|talknova-.*video|minimax-video|gen-3|gen3|mochi|wanx|vidu/i;

const AUDIO_RE = /tts|speech|melotts|bark|piper|xtts|kokoro|whisper|audio-speech|elevenlabs|fish-speech|styletts|f5-tts|gemini.*tts|openai.*tts/i;

const CHAT_KEEP_RE = /chat|instruct|coder|reason|vlm|vision-language|llm/i;

export function isLikelyImageModel(id) {
  const s = String(id || "");
  if (!s) return false;
  if (CHAT_KEEP_RE.test(s) && !/gpt-image|image-gen|img2img/i.test(s)) return false;
  return IMAGE_RE.test(s);
}

export function isLikelyVideoModel(id) {
  const s = String(id || "");
  if (!s) return false;
  return VIDEO_RE.test(s);
}

export function isLikelyAudioModel(id) {
  const s = String(id || "");
  if (!s) return false;
  if (/whisper/.test(s.toLowerCase()) && /chat|turbo-chat/i.test(s)) return false;
  return AUDIO_RE.test(s);
}

export function isLikelyMediaModel(id) {
  return isLikelyImageModel(id) || isLikelyVideoModel(id) || isLikelyAudioModel(id);
}

export function guessCategory(id) {
  if (isLikelyVideoModel(id)) return "video";
  if (isLikelyAudioModel(id)) return "audio";
  if (isLikelyImageModel(id)) return "image";
  return "chat";
}
