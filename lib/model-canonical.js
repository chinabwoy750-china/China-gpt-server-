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

function normalizeSeg(seg) {
  let key = String(seg || "")
    .toLowerCase()
    .replace(/:free$/i, "")
    .replace(/[._]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!key || key.length < 2 || /^(chat|model|default|latest|v\d+|text|completion)$/i.test(key)) {
    return "";
  }
  return key;
}

/**
 * Collapse router variants of the *same* underlying model.
 * @param {string} modelId
 * @param {Set<string>|string[]|null} customPrefixes - custom provider ids (kiro, talknova, …).
 *   Prefixed models from these providers stay in their own group so they don't
 *   appear as duplicates of bare gateway ids (claude-opus-4.5 vs kiro/claude-opus-4.5).
 */
export function canonicalKey(modelId, customPrefixes = null) {
  const raw = String(modelId || "").trim();
  if (!raw) return "unknown";
  const prefixSet = customPrefixes
    ? (customPrefixes instanceof Set ? customPrefixes : new Set([...customPrefixes].map(s => String(s).toLowerCase())))
    : null;

  if (raw.includes("/")) {
    const slash = raw.indexOf("/");
    const prefix = raw.slice(0, slash).toLowerCase();
    const rest = raw.slice(slash + 1);
    const restKey = normalizeSeg(rest.includes("/") ? rest.slice(rest.lastIndexOf("/") + 1) : rest)
      || normalizeSeg(rest)
      || rest.toLowerCase().replace(/[\/._]+/g, "-");
    // Custom provider namespace → unique group key
    if (prefixSet && prefixSet.has(prefix)) {
      return prefix + "::" + restKey;
    }
    return restKey || "unknown";
  }

  const key = normalizeSeg(raw);
  if (key) return key;
  return raw.toLowerCase().replace(/[._]+/g, "-").replace(/-+/g, "-") || "unknown";
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
export function groupModels(models, choosePrimary, customPrefixes = null) {
  const map = new Map();
  for (const m of models) {
    if (!m || typeof m.id !== "string") continue;
    const key = canonicalKey(m.id, customPrefixes);
    if (!key) continue;
    let b = map.get(key);
    if (!b) {
      b = { canonical: key, variants: [], hasFree: false, providers: new Set() };
      map.set(key, b);
    }
    // Skip exact duplicate variant ids inside a group
    if (b.variants.some(v => String(v.id).toLowerCase() === String(m.id).toLowerCase())) {
      continue;
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
