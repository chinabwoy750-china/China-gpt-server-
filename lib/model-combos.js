/**
 * Model combos — ordered fallback chains (Nine-Router style).
 * Virtual model id: combo/{id}
 * When requested, the gateway tries models[0], then models[1], … on errors/limits.
 */
import { kvGet, kvPut } from "./kv.js";
import { getDisabledSnapshot } from "./model-health.js";

const KV_KEY = "model-combos:v1";
export const COMBO_KINDS = ["chat", "image", "video", "audio", "search", "fetch"];

async function loadAll() {
  const data = await kvGet(KV_KEY, "json");
  return Array.isArray(data) ? data : [];
}

async function saveAll(list) {
  await kvPut(KV_KEY, list);
}

export function comboModelId(id) {
  const slug = String(id || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `combo/${slug}` : "";
}

export function parseComboId(modelId) {
  const s = String(modelId || "");
  if (!s.toLowerCase().startsWith("combo/")) return null;
  return s.slice(6).trim() || null;
}

export async function listCombos() {
  return loadAll();
}

export async function getCombo(idOrModelId) {
  const slug = parseComboId(idOrModelId) || String(idOrModelId || "").trim().toLowerCase();
  if (!slug) return null;
  const all = await loadAll();
  return all.find(c => c.id === slug) || null;
}

/** Return ordered model ids for a combo request, or null if not a combo. */
export async function ladderFor(modelId) {
  const c = await getCombo(modelId);
  if (!c || c.enabled === false) return null;
  let models = (c.models || []).map(m => String(m).trim()).filter(Boolean);
  try {
    const disabled = await getDisabledSnapshot();
    models = models.filter(mid => {
      if (disabled.models.has(mid)) return false;
      const prov = mid.split("/")[0].toLowerCase();
      if (prov && disabled.providers.has(prov)) return false;
      return true;
    });
  } catch {}
  return models.length ? models : null;
}

export function validateCombo(input = {}) {
  let id = String(input.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Combo id required (letters, numbers, dash, underscore)");
  if (id.length > 64) throw new Error("Combo id too long");
  const name = String(input.name || "").trim().slice(0, 80) || id;
  const kind = COMBO_KINDS.includes(input.kind) ? input.kind : "chat";
  const models = Array.isArray(input.models)
    ? [...new Set(input.models.map(m => String(m).trim()).filter(Boolean))].slice(0, 20)
    : [];
  if (models.length < 1) throw new Error("Add at least one model to the combo");
  // Prevent recursive combos for now
  if (models.some(m => parseComboId(m))) {
    throw new Error("Combos cannot nest other combos");
  }
  return {
    id,
    name,
    kind,
    models,
    enabled: input.enabled !== false,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export async function adminList(req, res) {
  const list = await loadAll();
  res.json({ ok: true, combos: list });
}

export async function adminUpsert(req, res) {
  try {
    const body = req.body || {};
    const all = await loadAll();
    const existing = all.find(c => c.id === String(body.id || "").trim().toLowerCase());
    const validated = validateCombo({
      ...body,
      createdAt: existing?.createdAt
    });

    // Enforce model-health disabled rules
    const disabled = await getDisabledSnapshot();
    for (const mid of validated.models) {
      if (disabled.models.has(mid)) {
        throw new Error(`Model is disabled and cannot be used in a combo: ${mid}`);
      }
      const prov = String(mid).split("/")[0].toLowerCase();
      if (prov && disabled.providers.has(prov)) {
        throw new Error(`Provider "${prov}" is disabled — remove models from it`);
      }
    }

    const next = all.filter(c => c.id !== validated.id);
    next.push(validated);
    next.sort((a, b) => a.name.localeCompare(b.name));
    await saveAll(next);
    res.json({ ok: true, combo: validated, modelId: comboModelId(validated.id) });
  } catch (e) {
    res.status(400).json({ error: { message: e.message || "Invalid combo" } });
  }
}

export async function adminDelete(req, res) {
  const id = String((req.body || {}).id || "").trim().toLowerCase();
  if (!id) return res.status(400).json({ error: { message: "id required" } });
  const all = await loadAll();
  const next = all.filter(c => c.id !== id);
  await saveAll(next);
  res.json({ ok: true, deleted: id });
}

/** Models list entries for catalogue / /v1/models */
export async function asModelEntries(kindFilter = null) {
  const all = await loadAll();
  return all
    .filter(c => c.enabled !== false && (!kindFilter || c.kind === kindFilter))
    .map(c => ({
      id: comboModelId(c.id),
      object: "model",
      created: Math.floor(new Date(c.createdAt || Date.now()).getTime() / 1000),
      owned_by: "combo",
      category: c.kind === "search" || c.kind === "fetch" ? "chat" : c.kind,
      combo: true,
      combo_kind: c.kind,
      combo_models: c.models,
      name: c.name
    }));
}
