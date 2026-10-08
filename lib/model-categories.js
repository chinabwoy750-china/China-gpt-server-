import { kvGet, kvPut } from "./kv.js";

const KEY = "model:categories";
const VALUES = ["chat", "image", "video", "audio"];

export async function loadAll() {
  const m = await kvGet(KEY, "json");
  return (m && typeof m === "object" && !Array.isArray(m)) ? m : {};
}

export async function categoryOf(modelId) {
  const m = await loadAll();
  return m[String(modelId || "")] || "chat";
}

export async function adminGet(req, res) {
  res.json({ ok: true, categories: await loadAll(), values: VALUES });
}

export async function adminSet(req, res) {
  const modelId = String(req.body?.modelId || "").trim();
  const category = String(req.body?.category || "").trim().toLowerCase();
  if (!modelId) return res.status(400).json({ ok: false, error: "modelId required" });
  if (!VALUES.includes(category)) return res.status(400).json({ ok: false, error: "Invalid category" });
  const m = await loadAll();
  if (category === "chat") delete m[modelId];
  else m[modelId] = category;
  await kvPut(KEY, m);
  res.json({ ok: true, categories: m });
}

export async function adminBulkSet(req, res) {
  const updates = (req.body || {}).updates;
  if (!updates || typeof updates !== "object") {
    return res.status(400).json({ ok: false, error: "updates object required" });
  }
  const m = await loadAll();
  for (const [modelId, category] of Object.entries(updates)) {
    const c = String(category || "").trim().toLowerCase();
    if (!VALUES.includes(c)) continue;
    if (c === "chat") delete m[modelId];
    else m[modelId] = c;
  }
  await kvPut(KEY, m);
  res.json({ ok: true, categories: m });
}
