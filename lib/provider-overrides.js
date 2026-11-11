import { kvGet, kvPut } from "./kv.js";

const KEY = "provider:overrides";

async function load() {
  let stored = await kvGet(KEY, "json");
  // Handle accidental double-encoding from older writes
  if (typeof stored === "string") {
    try { stored = JSON.parse(stored); } catch { stored = null; }
  }
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
  if (stored.byModelId && typeof stored.byModelId === "object" && !Array.isArray(stored.byModelId)) {
    for (const [k, v] of Object.entries(stored.byModelId)) {
      const id = String(k || "").slice(0, 200);
      const provider = String(v || "").trim().toLowerCase().slice(0, 40);
      if (id && provider) byModelId[id] = provider;
    }
  }

  return { byPattern, byModelId };
}

async function save(overrides) {
  const payload = {
    byPattern: Array.isArray(overrides.byPattern) ? overrides.byPattern : [],
    byModelId: (overrides.byModelId && typeof overrides.byModelId === "object") ? overrides.byModelId : {},
    updatedAt: new Date().toISOString()
  };
  await kvPut(KEY, payload);
  // Read-back verify
  const check = await load();
  return check;
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
  const saved = await save(overrides);
  res.json({ ok: true, ...saved });
}

export async function adminRemovePattern(req, res) {
  const pattern = String((req.body || {}).pattern || "").trim().toLowerCase();
  if (!pattern) return res.status(400).json({ ok: false, error: "pattern is required" });
  const overrides = await load();
  overrides.byPattern = overrides.byPattern.filter(x => x.pattern !== pattern);
  const saved = await save(overrides);
  res.json({ ok: true, ...saved });
}

export async function adminAddModelId(req, res) {
  const modelId = String((req.body || {}).modelId || "").trim().slice(0, 200);
  const provider = String((req.body || {}).provider || "").trim().toLowerCase().slice(0, 40);
  if (!modelId || !provider) return res.status(400).json({ ok: false, error: "modelId and provider are required" });
  const overrides = await load();
  overrides.byModelId[modelId] = provider;
  const saved = await save(overrides);
  res.json({ ok: true, ...saved });
}

export async function adminRemoveModelId(req, res) {
  const modelId = String((req.body || {}).modelId || "").trim();
  if (!modelId) return res.status(400).json({ ok: false, error: "modelId is required" });
  const overrides = await load();
  delete overrides.byModelId[modelId];
  const saved = await save(overrides);
  res.json({ ok: true, ...saved });
}

/** Move an entire provider label → another. Rewrites pattern rules and byModelId values. */
export async function adminMoveProvider(req, res) {
  const from = String((req.body || {}).from || "").trim().toLowerCase().slice(0, 40);
  const to = String((req.body || {}).to || "").trim().toLowerCase().slice(0, 40);
  if (!from || !to) {
    return res.status(400).json({ ok: false, error: "from and to providers are required" });
  }
  if (from === to) {
    return res.status(400).json({ ok: false, error: "from and to must be different" });
  }

  const overrides = await load();

  // 1) Pattern: models whose id contains the old provider key (and from/ prefix)
  for (const pattern of [from, from + "/"]) {
    overrides.byPattern = overrides.byPattern.filter(x => x.pattern !== pattern);
    overrides.byPattern.push({ pattern, provider: to });
  }

  // 2) Any existing patterns that pointed AT `from` now point to `to`
  overrides.byPattern = overrides.byPattern.map(x =>
    x.provider === from ? { ...x, provider: to } : x
  );

  // 3) Per-model overrides that targeted `from`
  let modelCount = 0;
  for (const [mid, prov] of Object.entries(overrides.byModelId)) {
    if (prov === from) {
      overrides.byModelId[mid] = to;
      modelCount++;
    }
  }

  // Cap patterns
  overrides.byPattern = overrides.byPattern.slice(0, 100);

  const saved = await save(overrides);
  res.json({
    ok: true,
    from,
    to,
    modelCount,
    ...saved
  });
}
