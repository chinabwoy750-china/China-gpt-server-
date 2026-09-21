import { kvGet, kvPut } from "./kv.js";

const KEY = "provider:overrides";

async function load() {
  const stored = await kvGet(KEY, "json");
  if (!stored || typeof stored !== "object") return { byPattern: [], byModelId: {} };

  const byPattern = Array.isArray(stored.byPattern)
    ? stored.byPattern
        .map(x => ({
          pattern: String(x?.pattern || "").trim().toLowerCase().slice(0, 80),
          provider: String(x?.provider || "").trim().toLowerCase().slice(0, 40)
        }))
        .filter(x => x.pattern && x.provider)
        .slice(0, 100)
    : [];

  const byModelId = {};
  if (stored.byModelId && typeof stored.byModelId === "object") {
    for (const [k, v] of Object.entries(stored.byModelId)) {
      const id = String(k || "").slice(0, 200);
      const provider = String(v || "").trim().toLowerCase().slice(0, 40);
      if (id && provider) byModelId[id] = provider;
    }
  }

  return { byPattern, byModelId };
}

export async function getOverrides() { return load(); }

export function applyOverrides(modelId, overrides) {
  const id = String(modelId || "");
  const { byModelId, byPattern } = overrides;
  if (byModelId[id]) return byModelId[id];
  const low = id.toLowerCase();
  let bestLen = -1, bestProvider = null;
  for (const { pattern, provider } of byPattern) {
    if (low.includes(pattern) && pattern.length > bestLen) {
      bestLen = pattern.length;
      bestProvider = provider;
    }
  }
  return bestProvider;
}

export async function publicGet(req, res) {
  res.json({ ok: true, ...(await load()) });
}
export async function adminGet(req, res) {
  res.json({ ok: true, ...(await load()) });
}

export async function adminAddPattern(req, res) {
  const pattern = String((req.body || {}).pattern || "").trim().toLowerCase().slice(0, 80);
  const provider = String((req.body || {}).provider || "").trim().toLowerCase().slice(0, 40);
  if (!pattern || !provider) return res.status(400).json({ ok: false, error: "pattern and provider are required" });

  const overrides = await load();
  overrides.byPattern = overrides.byPattern.filter(x => x.pattern !== pattern);
  overrides.byPattern.push({ pattern, provider });
  await kvPut(KEY, overrides);
  res.json({ ok: true, ...overrides });
}

export async function adminRemovePattern(req, res) {
  const pattern = String((req.body || {}).pattern || "").trim().toLowerCase();
  if (!pattern) return res.status(400).json({ ok: false, error: "pattern is required" });
  const overrides = await load();
  overrides.byPattern = overrides.byPattern.filter(x => x.pattern !== pattern);
  await kvPut(KEY, overrides);
  res.json({ ok: true, ...overrides });
}

export async function adminAddModelId(req, res) {
  const modelId = String((req.body || {}).modelId || "").trim().slice(0, 200);
  const provider = String((req.body || {}).provider || "").trim().toLowerCase().slice(0, 40);
  if (!modelId || !provider) return res.status(400).json({ ok: false, error: "modelId and provider are required" });
  const overrides = await load();
  overrides.byModelId[modelId] = provider;
  await kvPut(KEY, overrides);
  res.json({ ok: true, ...overrides });
}

export async function adminRemoveModelId(req, res) {
  const modelId = String((req.body || {}).modelId || "").trim();
  if (!modelId) return res.status(400).json({ ok: false, error: "modelId is required" });
  const overrides = await load();
  delete overrides.byModelId[modelId];
  await kvPut(KEY, overrides);
  res.json({ ok: true, ...overrides });
}
