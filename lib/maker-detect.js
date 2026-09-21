/* Server-side duplicate of the frontend maker detection, needed so
   the /v1/models filter can hide whole providers without trusting
   client input. Keep the regex list in sync with index.html. */
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
  { re:/(^|\/)sensenova/i, key:"sensetime", label:"SenseTime" }
];

export function makerOf(modelId) {
  const id = String(modelId || "");
  for (const m of MAKERS) if (m.re.test(id)) return { key: m.key, label: m.label };
  const agg = (id.split("/")[0] || "").toLowerCase();
  return { key: agg || "other", label: agg || "Other" };
}
