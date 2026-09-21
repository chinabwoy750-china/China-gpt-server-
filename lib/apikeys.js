import { kvGet, kvPut, kvList } from "./kv.js";
import { accountId, generateApiKey, maskApiKey, maskCode, randomChars } from "./utils.js";

export async function create(req, res) {
  const auth = req.auth;
  const label = String((req.body || {}).label || "").trim().slice(0, 80) || "Unnamed key";

  const fullKey = generateApiKey();
  const normalized = fullKey.toUpperCase();
  const hash = await accountId(normalized);
  const id = "ak_" + randomChars(10);
  const maskedKey = maskApiKey(fullKey);

  const record = {
    id,
    label,
    maskedKey,
    ownerAccountId: auth.accountId,
    ownerCode: auth.code,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revoked: false,
    revokedAt: null,
    revokedBy: null,
  };

  await kvPut(`apikey:${hash}`, record);
  await kvPut(`apikeyowner:${auth.accountId}:${id}`, hash);

  res.json({ ok: true, key: fullKey, id, label, maskedKey, createdAt: record.createdAt });
}

export async function list(req, res) {
  const auth = req.auth;
  const keys = [];
  let cursor;
  let pages = 0;

  do {
    const result = await kvList(`apikeyowner:${auth.accountId}:`, 100, cursor);
    for (const item of result.keys) {
      const hash = await kvGet(item.name);
      if (!hash) continue;
      const record = await kvGet(`apikey:${hash}`, "json");
      if (!record) continue;
      keys.push({
        id: record.id,
        label: record.label,
        maskedKey: record.maskedKey,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        revoked: !!record.revoked,
        revokedAt: record.revokedAt || null,
      });
    }
    if (result.list_complete) break;
    cursor = result.cursor;
    pages++;
  } while (cursor && pages < 10);

  keys.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  res.json({ ok: true, keys });
}

export async function revoke(req, res) {
  const auth = req.auth;
  const id = String((req.body || {}).id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "Key ID required" });

  const hash = await kvGet(`apikeyowner:${auth.accountId}:${id}`);
  if (!hash) return res.status(404).json({ ok: false, error: "Key not found" });

  const record = await kvGet(`apikey:${hash}`, "json");
  if (!record) return res.status(404).json({ ok: false, error: "Key not found" });

  if (record.revoked) return res.json({ ok: true, alreadyRevoked: true, id });

  record.revoked = true;
  record.revokedAt = new Date().toISOString();
  record.revokedBy = auth.code;
  await kvPut(`apikey:${hash}`, record);

  res.json({ ok: true, id, revoked: true });
}

export async function adminList(req, res) {
  const filterAccountId = req.query.accountId;
  const keys = [];
  let cursor;
  let pages = 0;

  do {
    const result = await kvList("apikey:", 1000, cursor);
    for (const item of result.keys) {
      const record = await kvGet(item.name, "json");
      if (!record) continue;
      if (filterAccountId && record.ownerAccountId !== filterAccountId) continue;
      keys.push({
        id: record.id,
        label: record.label,
        maskedKey: record.maskedKey,
        ownerAccountId: record.ownerAccountId,
        ownerCodeMasked: maskCode(record.ownerCode),
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        revoked: !!record.revoked,
        revokedAt: record.revokedAt || null,
      });
    }
    if (result.list_complete) break;
    cursor = result.cursor;
    pages++;
  } while (cursor && pages < 10);

  res.json({ ok: true, keys });
}
