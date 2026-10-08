import { loadAll as loadCustomProviders } from "./custom-providers.js";
import { loadAll as loadCategories } from "./model-categories.js";

const NINEROUTER_BASE = "https://ninerouter-china.onrender.com";

export async function getAllCategorized(req, res) {
  const result = { chat: [], image: [], video: [], audio: [] };

  // 1. 9Router models (categorized via the model:categories map; default chat)
  try {
    const r = await fetch(`${NINEROUTER_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}` },
      signal: AbortSignal.timeout(15000)
    });
    if (r.ok) {
      const j = await r.json();
      const data = Array.isArray(j.data) ? j.data : [];
      const cats = await loadCategories();
      for (const m of data) {
        if (!m || typeof m.id !== "string") continue;
        const cat = cats[m.id] || "chat";
        if (!result[cat]) continue;
        result[cat].push({ ...m, source: "9router" });
      }
    }
  } catch {}

  // 2. Custom provider models
  const custom = await loadCustomProviders();
  for (const p of custom) {
    if (p.enabled === false) continue;
    for (const cat of ["chat", "image", "video", "audio"]) {
      const list = p.models?.[cat] || [];
      for (const id of list) {
        result[cat].push({
          id: `${p.id}/${id}`,
          name: id,
          provider: p.id,
          providerLabel: p.label,
          source: "custom",
          capabilities: cat === "chat" ? { tools: true, reasoning: true } : {}
        });
      }
    }
  }

  res.json({ ok: true, ...result });
}
