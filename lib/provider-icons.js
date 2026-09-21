import { kvGet, kvPut } from "./kv.js";

const STORE_KEY = "providericons";

/* Public read: any signed-in user gets the icon map so the
   frontend can resolve provider marks before models load. */
export async function list(req, res) {
  const icons = (await kvGet(STORE_KEY, "json")) || {};
  res.json({ ok: true, icons });
}

/* Admin read: identical payload but rate-limited through the
   admin middleware chain. Kept as a separate route so the admin
   panel doesn't have to guess at auth. */
export async function adminList(req, res) {
  const icons = (await kvGet(STORE_KEY, "json")) || {};
  res.json({ ok: true, icons });
}

/* Admin write: set or clear an override for a provider key.
   Empty url means "remove override, go back to auto-resolution". */
export async function setIcon(req, res) {
  const provider = String((req.body || {}).provider || "")
    .trim()
    .toLowerCase()
    .slice(0, 60);
  const url = String((req.body || {}).url || "").trim().slice(0, 600);

  if (!provider) return res.status(400).json({ ok: false, error: "Provider required" });

  const icons = (await kvGet(STORE_KEY, "json")) || {};

  if (url) {
    // Accept only http(s) URLs, and default to https if protocol is missing.
    let normalized = url;
    if (!/^https?:\/\//i.test(normalized)) normalized = "https://" + normalized;
    try {
      const u = new URL(normalized);
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        return res.status(400).json({ ok: false, error: "URL must be http(s)" });
      }
      icons[provider] = normalized;
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid URL" });
    }
  } else {
    delete icons[provider];
  }

  await kvPut(STORE_KEY, icons);
  res.json({ ok: true, icons });
}
