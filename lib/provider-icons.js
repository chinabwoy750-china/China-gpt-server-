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
  const url = String((req.body || {}).url || "").trim();

  if (!provider) return res.status(400).json({ ok: false, error: "Provider required" });

  const icons = (await kvGet(STORE_KEY, "json")) || {};

  if (url) {
    let normalized = url;

    // Data URL — accept image/* only, cap at 2MB raw
    if (/^data:image\//i.test(normalized)) {
      if (!/^data:image\/(svg\+xml|png|jpeg|jpg|gif|webp|x-icon|vnd\.microsoft\.icon)/i.test(normalized)) {
        return res.status(400).json({ ok: false, error: "Only image data URLs are allowed" });
      }
      // Base64 length ≈ 1.37 × byte size. 2MB cap → ~2.8M chars.
      if (normalized.length > 2_800_000) {
        return res.status(413).json({ ok: false, error: "Image too large (2 MB max)" });
      }
    } else {
      // Regular URL — normalise protocol
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
    }

    icons[provider] = normalized;
  } else {
    delete icons[provider];
  }

  await kvPut(STORE_KEY, icons);
  res.json({ ok: true, icons });
}
