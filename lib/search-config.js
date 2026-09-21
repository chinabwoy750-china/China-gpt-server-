import { kvGet, kvPut } from "./kv.js";

const CONFIG_KEY = "search:config";
const DEFAULTS = { providers: ["gemini"], defaultProvider: "gemini" };

async function getConfig() {
  const stored = await kvGet(CONFIG_KEY, "json");
  if (!stored || typeof stored !== "object") return { ...DEFAULTS };

  const providers = Array.isArray(stored.providers)
    ? [...new Set(stored.providers.map(p => String(p || "").trim().toLowerCase()).filter(Boolean))].slice(0, 20)
    : DEFAULTS.providers;

  let defaultProvider = String(stored.defaultProvider || "").trim().toLowerCase();
  if (!defaultProvider || !providers.includes(defaultProvider)) {
    defaultProvider = providers[0] || DEFAULTS.defaultProvider;
  }

  return { providers: providers.length ? providers : DEFAULTS.providers, defaultProvider };
}

export async function publicGet(req, res) {
  res.json({ ok: true, ...(await getConfig()) });
}
export async function adminGet(req, res) {
  res.json({ ok: true, ...(await getConfig()) });
}
export async function adminSave(req, res) {
  const body = req.body || {};
  let providers = Array.isArray(body.providers)
    ? body.providers.map(p => String(p || "").trim().toLowerCase()).filter(Boolean)
    : [];
  providers = [...new Set(providers)].slice(0, 20);
  if (!providers.length) return res.status(400).json({ ok: false, error: "Add at least one provider" });

  let defaultProvider = String(body.defaultProvider || "").trim().toLowerCase();
  if (!defaultProvider || !providers.includes(defaultProvider)) defaultProvider = providers[0];

  const config = { providers, defaultProvider };
  await kvPut(CONFIG_KEY, config);
  res.json({ ok: true, ...config });
}
