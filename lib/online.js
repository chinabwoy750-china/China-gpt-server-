import { kvGet, kvPut, kvList } from "./kv.js";

const PREFIX = "online:";
const TTL_SECONDS = 90;

/* Called on every authenticated request. Upsert with a fresh TTL. */
export async function touch(accountId) {
  if (!accountId) return;
  try {
    await kvPut(PREFIX + accountId, Date.now(), { expirationTtl: TTL_SECONDS });
  } catch (e) {
    // Never let online tracking break a real request
    console.error("online.touch failed:", e?.message || e);
  }
}

/* Count active accounts (keys with non-expired TTL). */
export async function count() {
  try {
    let cursor;
    let total = 0;
    let pages = 0;
    do {
      const r = await kvList(PREFIX, 500, cursor);
      total += r.keys.length;
      if (r.list_complete) break;
      cursor = r.cursor;
      pages++;
    } while (cursor && pages < 20);
    return total;
  } catch (e) {
    console.error("online.count failed:", e?.message || e);
    return 0;
  }
}

/* Public endpoint */
export async function getStats(req, res) {
  const online = await count();
  res.json({ ok: true, online, ts: Date.now() });
}
