/* Server-side maker detection. Keep in sync with index.html makerOf. */
const MAKERS = [
  { re:/(^|\/)(gpt|gpt-oss|gpt-6|gpt-5|o1|o3|o4)[-\d]/i, key:"openai", label:"OpenAI" },
  { re:/(^|\/)(claude|fable)/i, key:"anthropic", label:"Anthropic" },
  { re:/(^|\/)(gemini|gemma|lyria)/i, key:"google", label:"Google" },
  { re:/(^|\/)deepseek/i, key:"deepseek", label:"DeepSeek" },
  { re:/(^|\/)(qwen|qwq)/i, key:"qwen", label:"Qwen" },
  { re:/(^|\/)kimi/i, key:"moonshot", label:"Moonshot AI" },
  { re:/(^|\/)glm/i, key:"zai", label:"Z.AI" },
  { re:/(^|\/)grok/i, key:"xai", label:"xAI" },
  { re:/(^|\/)(llama|muse-spark)/i, key:"meta", label:"Meta" },
  { re:/(^|\/)(mistral|ministral|codestral|devstral)/i, key:"mistral", label:"Mistral" },
  { re:/(^|\/)minimax/i, key:"minimax", label:"MiniMax" },
  { re:/(^|\/)(nemotron|parakeet)/i, key:"nvidia", label:"NVIDIA" },
  { re:/(^|\/)north(-mini-code)/i, key:"cohere", label:"Cohere" },
  { re:/(^|\/)(seedream|doubao|seed)/i, key:"bytedance", label:"ByteDance" },
  { re:/(^|\/)mimo/i, key:"xiaomi", label:"Xiaomi" },
  { re:/(^|\/)(hy\d|hunyuan)/i, key:"tencent", label:"Tencent" },
  { re:/(^|\/)longcat/i, key:"meituan", label:"Meituan" },
  { re:/(^|\/)sensenova/i, key:"sensetime", label:"SenseTime" },
  { re:/(^|\/)(flux|stable-diffusion|sdxl|dreamshaper)/i, key:"image", label:"Image" },
  { re:/(cloudflare|@cf)/i, key:"cloudflare", label:"Cloudflare" },
  { re:/(^|\/)(hf|huggingface)\b/i, key:"huggingface", label:"Hugging Face" }
];

/** Normalize noisy aggregator prefixes into one provider key. */
export function normalizeProviderKey(raw) {
  let k = String(raw || "").toLowerCase().trim();
  if (!k) return "other";
  k = k.replace(/^@/, "");
  // strip common gateway suffixes that create duplicate chips
  k = k.replace(/-web$/i, "").replace(/-free$/i, "").replace(/-ai$/i, "");
  k = k.replace(/_web$/i, "").replace(/_free$/i, "");
  if (k === "hf" || k.startsWith("hf-") || k === "huggingface") return "huggingface";
  if (k.startsWith("cloudflare") || k === "cf" || k === "cf-ai") return "cloudflare";
  if (k === "maxai" || k === "max-ai") return "maxai";
  if (k === "innerai" || k === "inner-ai" || k === "inner") return "inner";
  if (k === "hyperagent" || k === "hyper-agent") return "hyperagent";
  if (k === "arena" || k === "arena-ai") return "arena";
  if (k === "blackbox" || k === "blackbox-web") return "blackbox";
  if (k === "conol" || k === "conol-web") return "conol";
  if (k === "adapta" || k === "adapta-web") return "adapta";
  if (k === "logfare" || k === "log.fare") return "logfare";
  return k || "other";
}

export function makerOf(modelId) {
  const id = String(modelId || "");
  for (const m of MAKERS) if (m.re.test(id)) return { key: m.key, label: m.label };

  // Prefer first path segment when present (aggregator/provider/model)
  if (id.includes("/")) {
    const agg = normalizeProviderKey(id.split("/")[0]);
    const label = agg.charAt(0).toUpperCase() + agg.slice(1);
    return { key: agg || "other", label: label || "Other" };
  }

  // Bare model id (no provider prefix) — do NOT treat the model name as a provider
  return { key: "other", label: "Other" };
}
