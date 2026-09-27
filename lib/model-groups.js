import { kvGet, kvPut } from "./kv.js";
import { canonicalKey } from "./model-canonical.js";

const PINS_KEY = "model:groups:pins";

/* Pins are stored as { canonical: variantId }. Absence means "auto". */
export async function loadPins() {
  try {
    const v = await kvGet(PINS_KEY, "json");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const clean = {};
    for (const [k, val] of Object.entries(v)) {
      const c = String(k || "").trim();
      const id = String(val || "").trim();
      if (c && id) clean[c] = id;
    }
    return clean;
  } catch {
    return {};
  }
}

async function savePins(pins) {
  await kvPut(PINS_KEY, pins);
}

/* ---- Admin routes ---- */

export async function adminList(req, res) {
  try {
    // Pull the freshly-grouped model catalogue via proxy's builder.
    const proxy = await import("./proxy.js");
    const groups = await proxy.buildGroups();
    const { getCooldowns, getResultsSnapshot } = await import("./model-health.js");
    const [pins, cooldowns, health] = await Promise.all([
      loadPins(),
      getCooldowns().catch(() => ({})),
      Promise.resolve(getResultsSnapshot()).catch(() => ({}))
    ]);

    const payload = groups.map(g => {
      const pinned = pins[g.canonical] || null;
      const primary = (pinned && g.variants.some(v => v.id === pinned))
        ? pinned
        : (g.primary ? g.primary.id : g.variants[0].id);
      return {
        canonical: g.canonical,
        primary,
        pinned,
        variantCount: g.variants.length,
        hasFree: g.hasFree,
        providers: g.providers,
        variants: g.variants.map(v => {
          const h = health[v.id] || {};
          const cd = cooldowns[v.id] || null;
          return {
            id: v.id,
            cooling: !!cd,
            cooldownUntil: cd ? cd.until : null,
            cooldownReason: cd ? cd.reason : null,
            status: h.status || "untested",
            latency: Number.isFinite(h.latency) ? h.latency : null,
            errorMessage: h.errorMessage || null
          };
        })
      };
    });

    res.json({ ok: true, groups: payload });
  } catch (err) {
    console.error("adminList model-groups failed:", err);
    res.status(502).json({ ok: false, error: err?.message || "Could not build groups" });
  }
}

export async function adminPin(req, res) {
  const canonical = String((req.body || {}).canonical || "").trim();
  const variant = String((req.body || {}).variant || "").trim();
  if (!canonical) return res.status(400).json({ ok: false, error: "canonical required" });

  try {
    const pins = await loadPins();
    if (variant) {
      // Guard: verify the variant actually belongs to this canonical key.
      const ck = canonicalKey(variant);
      if (ck !== canonical) {
        return res.status(400).json({
          ok: false,
          error: `Variant "${variant}" belongs to group "${ck}", not "${canonical}"`
        });
      }
      pins[canonical] = variant;
    } else {
      delete pins[canonical];
    }
    await savePins(pins);
    res.json({ ok: true, canonical, pinned: variant || null });
  } catch (err) {
    console.error("adminPin failed:", err);
    res.status(500).json({ ok: false, error: "Could not save pin" });
  }
}

export async function adminClearCooldown(req, res) {
  const variant = String((req.body || {}).variant || "").trim();
  if (!variant) return res.status(400).json({ ok: false, error: "variant required" });
  try {
    const { recordSuccess } = await import("./model-health.js");
    await recordSuccess(variant);
    res.json({ ok: true, variant });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Could not clear cooldown" });
  }
}
