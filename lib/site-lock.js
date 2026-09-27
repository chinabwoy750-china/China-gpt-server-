import { kvGet, kvPut, kvDelete } from "./kv.js";

const KEY = "site:lock";

/* Returns the active lock record, or null. Auto-cleans
   expired records in case Redis TTL hasn't fired. */
export async function getLock() {
  let lock;
  try {
    lock = await kvGet(KEY, "json");
  } catch (err) {
    console.error("site-lock: KV read failed:", err?.message || err);
    return null;
  }
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) return null;
  if (!lock.lockedAt) return null;                 // must be a real record
  if (lock.until) {
    const until = Date.parse(lock.until);
    if (!Number.isFinite(until) || until <= Date.now()) {
      try { await kvDelete(KEY); } catch {}
      return null;
    }
  }
  return lock;
}

export async function setLock({ durationSeconds, message, indefinite, lockedBy }) {
  const now = new Date();
  const until = indefinite ? null : new Date(now.getTime() + durationSeconds * 1000).toISOString();
  const record = {
    lockedAt: now.toISOString(),
    until,
    message: message || "Site is temporarily locked for maintenance.",
    lockedBy: lockedBy || null
  };
  if (!indefinite && durationSeconds > 0) {
    await kvPut(KEY, record, { expirationTtl: durationSeconds + 120 });
  } else {
    await kvPut(KEY, record);
  }
  return record;
}

export async function clearLock() {
  await kvDelete(KEY);
}

export async function isLocked() {
  return !!(await getLock());
}

function remaining(lock) {
  if (!lock.until) return null;
  return Math.max(0, Math.floor((Date.parse(lock.until) - Date.now()) / 1000));
}

/* ---- Endpoints ---- */

export async function publicGet(req, res) {
  const lock = await getLock();
  if (!lock) return res.json({ ok: true, locked: false });
  res.json({
    ok: true,
    locked: true,
    message: lock.message,
    lockedAt: lock.lockedAt,
    until: lock.until,
    remainingSeconds: remaining(lock)
  });
}

export async function adminGet(req, res) {
  const lock = await getLock();
  if (!lock) return res.json({ ok: true, locked: false });
  res.json({
    ok: true,
    locked: true,
    message: lock.message,
    lockedAt: lock.lockedAt,
    until: lock.until,
    remainingSeconds: remaining(lock),
    lockedBy: lock.lockedBy
  });
}

export async function adminLock(req, res) {
  const body = req.body || {};
  const indefinite = !!body.indefinite;
  const minutes = Math.min(Math.max(Number(body.durationMinutes) || 20, 1), 60 * 24 * 7);
  const message = String(body.message || "").trim().slice(0, 500) ||
    "Site is temporarily locked for maintenance.";
  const record = await setLock({
    durationSeconds: indefinite ? 0 : minutes * 60,
    message,
    indefinite,
    lockedBy: req.auth?.code ? "admin" : null
  });
  res.json({ ok: true, locked: true, ...record });
}

export async function adminUnlock(req, res) {
  await clearLock();
  res.json({ ok: true, locked: false });
}
