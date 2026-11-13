/** Heuristic media-vs-chat classification for catalogue filtering. */

const IMAGE_RE = new RegExp([
  // well-known generators
  "flux", "stable.?diffusion", "sdxl", "sd[\\-_]?3", "sd[\\-_]?v?\\d",
  "dall-?e", "imagen", "midjourney", "niji", "nanobanana", "seedream",
  "playground", "ideogram", "recraft", "gpt-image", "qwen-image",
  "image-gen", "text2img", "txt2img", "img2img", "text-?to-?image", "t2i",
  "@cf\\/", "black-forest", "lucid.?origin", "phoenix.?1", "dreamshaper",
  "kandinsky", "wuerstchen", "kolors", "hunyuan-dit", "cogview",
  "nova-canvas", "amazon\\.titan-image", "gemini.*image",
  // proxy / community image backends
  "perchance", "veo-image", "openjourney", "proteus", "pixart",
  "aura.?flow", "cascade", "juggernaut", "deliberate", "epic.?realism",
  "realistic.?vision", "counterfeit", "chilloutmix", "anything.?v",
  // shape / mode suffixes common on image proxies
  "portrait", "landscape", "square",
  // generic tokens (word boundary-ish)
  "(^|[/\\-_])(image|img|draw|paint|photo)([/\\-_]|$)"
].join("|"), "i");

const VIDEO_RE = /veo(?!-image)|sora|runway|kling|seedance|hailuo|luma|pika|cogvideo|hunyuan-video|vivix|text-to-video|image-to-video|talknova-.*video|minimax-video|gen-3|gen3|mochi|wanx|vidu|t2v|i2v/i;

const AUDIO_RE = /tts|speech|melotts|bark|piper|xtts|kokoro|whisper|audio-speech|elevenlabs|fish-speech|styletts|f5-tts|gemini.*tts|openai.*tts/i;

// Chat models that mention vision but are still chat (keep in chat)
const CHAT_KEEP_RE = /chat|instruct|coder|reason|vlm|vision-language|llm|gpt-4o|gpt-4\.1|claude|gemini-(?!.*image)|deepseek|kimi|mistral|llama|qwen(?!-image)/i;

/** owned_by / publisher hints that almost always mean image */
const IMAGE_OWNERS = /perchance|black-forest|stability|midjourney|ideogram|recraft|leonardo|playground|flux|nanobanana|seedream/i;

export function isLikelyImageModel(id, ownedBy) {
  const s = String(id || "");
  if (!s) return false;
  if (IMAGE_OWNERS.test(String(ownedBy || ""))) return true;
  // Don't steal real chat models that happen to contain a weak token
  if (CHAT_KEEP_RE.test(s) && !/gpt-image|image-gen|img2img|perchance|t2i/i.test(s)) return false;
  return IMAGE_RE.test(s);
}

export function isLikelyVideoModel(id) {
  const s = String(id || "");
  if (!s) return false;
  if (/veo-image/i.test(s)) return false; // image variant of veo naming
  return VIDEO_RE.test(s);
}

export function isLikelyAudioModel(id) {
  const s = String(id || "");
  if (!s) return false;
  if (/whisper/.test(s.toLowerCase()) && /chat|turbo-chat/i.test(s)) return false;
  return AUDIO_RE.test(s);
}

export function isLikelyMediaModel(id, ownedBy) {
  return isLikelyImageModel(id, ownedBy) || isLikelyVideoModel(id) || isLikelyAudioModel(id);
}

export function guessCategory(id, ownedBy) {
  if (isLikelyVideoModel(id)) return "video";
  if (isLikelyAudioModel(id)) return "audio";
  if (isLikelyImageModel(id, ownedBy)) return "image";
  return "chat";
}
