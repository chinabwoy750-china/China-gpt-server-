import { loadAll as loadCustomProviders } from "./custom-providers.js";
import { loadAll as loadCategories } from "./model-categories.js";
import { getDisabledSnapshot } from "./model-health.js";

const NINEROUTER_BASE = "https://ninerouter-china.onrender.com";

/**
 * 9Router splits the catalogue by capability:
 *   GET /v1/models          → chat/LLM
 *   GET /v1/models/image    → image generation
 *   GET /v1/models/video    → video generation (if enabled)
 *   GET /v1/models/tts      → text-to-speech / audio
 * China-GPT used to only call /v1/models and default everything to "chat",
 * so image providers never appeared under the Images tab.
 */
const KIND_PATHS = {
  chat:  "/v1/models",
  image: "/v1/models/image",
  video: "/v1/models/video",
  audio: "/v1/models/tts"
};

async function fetchKindList(kind, path, headers, signal) {
  try {
    const r = await fetch(`${NINEROUTER_BASE}${path}`, { headers, signal });
    if (!r.ok) return [];
    const j = await r.json();
    const data = Array.isArray(j.data) ? j.data : [];
    return data
      .filter(m => m && typeof m.id === "string")
      .map(m => ({ ...m, source: "9router", category: kind }));
  } catch {
    return [];
  }
}

export async function getAllCategorized(req, res) {
  const result = { chat: [], image: [], video: [], audio: [] };
  const headers = { Authorization: `Bearer ${process.env.NINEROUTER_API_KEY}` };
  const signal = AbortSignal.timeout(15000);

  // Parallel fetch of each 9Router capability list
  const lists = await Promise.all(
    Object.entries(KIND_PATHS).map(async ([kind, path]) => {
      const items = await fetchKindList(kind, path, headers, signal);
      return [kind, items];
    })
  );

  for (const [kind, items] of lists) {
    result[kind].push(...items);
  }

  // Admin overrides: model:categories can move a model into another bucket
  // (e.g. force a chat id into "image" if the upstream list is wrong).
  try {
    const cats = await loadCategories();
    const byId = new Map();
    for (const kind of Object.keys(result)) {
      for (const m of result[kind]) byId.set(m.id, { kind, model: m });
    }
    for (const [modelId, category] of Object.entries(cats || {})) {
      if (!result[category]) continue;
      const existing = byId.get(modelId);
      if (existing) {
        if (existing.kind === category) continue;
        result[existing.kind] = result[existing.kind].filter(m => m.id !== modelId);
        result[category].push({ ...existing.model, category });
        byId.set(modelId, { kind: category, model: existing.model });
      }
      // If not in any upstream list, leave it — overrides only re-bucket known ids.
    }
  } catch {}

  // Custom provider models
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
          category: cat,
          capabilities: cat === "chat" ? { tools: true, reasoning: true } : {}
        });
      }
    }
  }

  // Hide health-disabled models/providers from everyone (UI + quick switch)
  try {
    const disabled = await getDisabledSnapshot();
    for (const cat of Object.keys(result)) {
      result[cat] = (result[cat] || []).filter(m => {
        if (!m || !m.id) return false;
        if (disabled.models.has(m.id)) return false;
        const prov = String(m.id).split("/")[0].toLowerCase();
        if (disabled.providers.has(prov)) return false;
        return true;
      });
    }
  } catch {}

  res.json({ ok: true, ...result });
}
