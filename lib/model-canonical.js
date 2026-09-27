/* Canonical grouping for model IDs. Multiple routers expose the same
   underlying model under different prefixes. This collapses them into
   a single key so the frontend shows one row per real model, with
   variants selectable underneath.

   Rules — deliberately strict so genuinely different models never merge:
     1. Take the last path segment (after the final "/")
     2. Lowercase
     3. Strip a trailing ":free"
     4. Normalise separators: "." and "_" → "-"
     5. Collapse repeated "-" into one, trim edges
*/

export function canonicalKey(modelId) {
  const raw = String(modelId || "");
  const lastSeg = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  return lastSeg
    .toLowerCase()
    .replace(/:free$/i, "")
    .replace(/[._]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function isFreeVariant(modelId) {
  return /:free$/i.test(String(modelId || "").trim());
}

/* Group upstream model objects.
   choosePrimary(a, b) → number; lower sorts first (i.e., becomes primary).
   Returns an array of groups. Each group is:
     {
       canonical: string,
       variants:  Model[],   // full objects from upstream
       hasFree:   boolean,
       providers: string[]
     }
*/
export function groupModels(models, choosePrimary) {
  const map = new Map();
  for (const m of models) {
    if (!m || typeof m.id !== "string") continue;
    const key = canonicalKey(m.id);
    if (!key) continue;
    let b = map.get(key);
    if (!b) {
      b = { canonical: key, variants: [], hasFree: false, providers: new Set() };
      map.set(key, b);
    }
    b.variants.push(m);
    if (isFreeVariant(m.id)) b.hasFree = true;
    const prov = (m.id.split("/")[0] || "").toLowerCase();
    if (prov) b.providers.add(prov);
  }

  const cmp = typeof choosePrimary === "function" ? choosePrimary : defaultPrimary;
  const out = [];
  for (const b of map.values()) {
    const sorted = [...b.variants].sort(cmp);
    out.push({
      canonical: b.canonical,
      variants: sorted,
      hasFree: b.hasFree,
      providers: [...b.providers].sort()
    });
  }
  return out;
}

function defaultPrimary(a, b) {
  const af = isFreeVariant(a.id) ? 0 : 1;
  const bf = isFreeVariant(b.id) ? 0 : 1;
  if (af !== bf) return af - bf;
  if (a.id.length !== b.id.length) return a.id.length - b.id.length;
  return a.id.localeCompare(b.id);
}
