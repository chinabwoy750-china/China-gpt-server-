import { getNineRouterKey, getNineRouterBase } from "./ninerouter-config.js";
import { isLikelyImageModel, isLikelyVideoModel, isLikelyAudioModel, guessCategory } from "./model-kind.js";
import * as modelCombos from "./model-combos.js";
import { loadAll as loadCustomProviders, stripProviderPrefix } from "./custom-providers.js";
import { loadAll as loadCategories } from "./model-categories.js";
import { getDisabledSnapshot } from "./model-health.js";

const NINEROUTER_BASE_DEFAULT = "https://ninerouter-china.onrender.com";

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
    const r = await fetch(`${(await getNineRouterBase()) || NINEROUTER_BASE_DEFAULT}${path}`, { headers, signal });
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
  const headers = { Authorization: `Bearer ${await getNineRouterKey()}` };
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


  // Keep categories exclusive + promote media-looking ids out of chat
  const mediaIds = new Set();
  for (const k of ["image", "video", "audio"]) {
    for (const m of result[k]) if (m?.id) mediaIds.add(m.id);
  }
  result.chat = (result.chat || []).filter(m => {
    if (!m?.id) return false;
    if (mediaIds.has(m.id)) return false;
    const cat = guessCategory(m.id, m.owned_by || m.ownedBy);
    if (cat !== "chat") {
      if (!result[cat].some(x => x.id === m.id)) {
        result[cat].push({ ...m, category: cat, source: m.source || "gateway" });
      }
      mediaIds.add(m.id);
      return false;
    }
    return true;
  });
  for (const k of Object.keys(result)) {
    const seen = new Set();
    result[k] = (result[k] || []).filter(m => {
      if (!m?.id || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }

  // Custom provider models (optional per-model meta from probe: p.modelsMeta)
  const custom = await loadCustomProviders();
  const customSeen = new Set();
  for (const p of custom) {
    if (p.enabled === false) continue;
    const metaMap = (p.modelsMeta && typeof p.modelsMeta === "object") ? p.modelsMeta : {};
    for (const cat of ["chat", "image", "video", "audio"]) {
      const list = p.models?.[cat] || [];
      for (const id of list) {
        const rawId = stripProviderPrefix(p.id, id);
        if (!rawId) continue;
        const fullId = `${p.id}/${rawId}`;
        const seenKey = fullId.toLowerCase();
        if (customSeen.has(seenKey)) continue;
        customSeen.add(seenKey);
        const meta = metaMap[rawId] || metaMap[fullId] || metaMap[id] || {};
        result[cat].push({
          id: fullId,
          name: meta.name || rawId,
          provider: p.id,
          providerLabel: p.label,
          source: "custom",
          category: cat,
          capabilities: cat === "chat"
            ? { tools: true, reasoning: true, ...(meta.capabilities || {}) }
            : { ...(meta.capabilities || {}) },
          type: meta.type || cat,
          aspect_ratios: meta.aspect_ratios || meta.supported_aspect_ratios,
          durations: meta.durations || meta.supported_durations,
          qualities: meta.qualities || meta.resolutions || meta.supported_qualities,
          max_duration: meta.max_duration,
          mode: meta.mode || meta.modality,
          description: meta.description
        });
      }
    }
  }

  // Final per-category id dedupe (case-insensitive)
  for (const cat of Object.keys(result)) {
    const seen = new Set();
    result[cat] = (result[cat] || []).filter(row => {
      if (!row?.id) return false;
      const k = String(row.id).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
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

  // Append admin model combos into the matching category tab
  try {
    for (const kind of ["chat", "image", "video", "audio"]) {
      const entries = await modelCombos.asModelEntries(kind);
      for (const e of entries) {
        if (!result[kind].some(m => m.id === e.id)) {
          result[kind].push({
            id: e.id,
            name: e.name,
            category: kind,
            source: "combo",
            combo: true,
            combo_models: e.combo_models,
            owned_by: "combo"
          });
        }
      }
    }
  } catch {}

  res.json({ ok: true, ...result });
}
