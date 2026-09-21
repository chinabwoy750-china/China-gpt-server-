import { kvGet, kvPut, kvList } from "./kv.js";
import { accountId, generateAccessKey, maskCode } from "./utils.js";

export async function status(req, res) {
  const initialized = await kvGet("system:initialized");
  res.json({
    ok: true,
    role: "admin",
    gateway: "9Router",
    apiKeyConfigured: Boolean(process.env.NINEROUTER_API_KEY),
    authSystemInitialized: Boolean(initialized),
  });
}

export async function accounts(req, res) {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 100);
  const cursor = req.query.cursor || undefined;
  const roleFilter = (req.query.role || "").trim().toLowerCase();
  const statusFilter = (req.query.status || "").trim().toLowerCase();
  const search = (req.query.search || "").trim().toLowerCase();

  const result = await kvList("code:", limit, cursor);
  const accounts = [];

  for (const item of result.keys) {
    const code = item.name.substring(5);
    const record = await kvGet(item.name, "json");
    if (!record) continue;

    const role = record.role || "user";
    const status = record.status || "active";
    const codeMasked = maskCode(code);

    if (roleFilter && role !== roleFilter) continue;
    if (statusFilter && status !== statusFilter) continue;
    if (
      search &&
      !codeMasked.toLowerCase().includes(search) &&
      !role.toLowerCase().includes(search) &&
      !status.toLowerCase().includes(search)
    ) continue;

    const id = await accountId(code);
    await kvPut(`account:${id}`, code);

    let apiKeyCount = 0;
    try {
      const kl = await kvList(`apikeyowner:${id}:`, 100);
      apiKeyCount = kl.keys.length;
    } catch {}

    accounts.push({
      id,
      codeMasked,
      role,
      status,
      createdAt: record.createdAt || null,
      lastLogin: record.lastLogin || null,
      revokedAt: record.revokedAt || null,
      revokedBy: record.revokedBy || null,
      apiKeyCount,
    });
  }

  const summary = {
    total: accounts.length,
    active: accounts.filter((a) => a.status === "active").length,
    revoked: accounts.filter((a) => a.status === "revoked").length,
    admins: accounts.filter((a) => a.role === "admin").length,
    users: accounts.filter((a) => a.role === "user").length,
  };

  res.json({
    ok: true,
    accounts,
    summary,
    nextCursor: result.list_complete ? null : result.cursor,
    listComplete: result.list_complete,
  });
}

export async function createKey(req, res) {
  const role = (req.body || {}).role === "admin" ? "admin" : "user";
  const key = generateAccessKey();
  const record = {
    role,
    status: "active",
    createdAt: new Date().toISOString(),
    lastLogin: null,
    createdBy: req.auth.code,
  };
  await kvPut(`code:${key}`, record);
  const id = await accountId(key);
  await kvPut(`account:${id}`, key);
  res.json({
    ok: true,
    key,
    role,
    status: "active",
    createdAt: record.createdAt,
    message: "New access key created. Save it securely.",
  });
}

async function resolveAccountId(id) {
  const mappedCode = await kvGet(`account:${id}`);
  if (mappedCode) return mappedCode;

  let cursor;
  do {
    const result = await kvList("code:", 100, cursor);
    for (const item of result.keys) {
      const code = item.name.substring(5);
      const currentId = await accountId(code);
      if (currentId === id) {
        await kvPut(`account:${id}`, code);
        return code;
      }
    }
    if (result.list_complete) break;
    cursor = result.cursor;
  } while (cursor);

  return null;
}

export async function revokeKey(req, res) {
  const id = String((req.body || {}).id || "").trim().toLowerCase();
  if (!id) return res.status(400).json({ ok: false, error: "Account ID required" });

  const code = await resolveAccountId(id);
  if (!code) return res.status(404).json({ ok: false, error: "Account not found" });

  if (code === req.auth.code) {
    return res.status(400).json({
      ok: false,
      error: "You cannot revoke the access key currently being used by yourself.",
    });
  }

  const keyName = `code:${code}`;
  const record = await kvGet(keyName, "json");
  if (!record) return res.status(404).json({ ok: false, error: "Account not found" });
  if (record.status === "revoked") return res.json({ ok: true, alreadyRevoked: true, id });

  record.status = "revoked";
  record.revokedAt = new Date().toISOString();
  record.revokedBy = req.auth.code;
  await kvPut(keyName, record);

  res.json({ ok: true, id, status: "revoked" });
}

export async function restoreKey(req, res) {
  const id = String((req.body || {}).id || "").trim().toLowerCase();
  if (!id) return res.status(400).json({ ok: false, error: "Account ID required" });

  const code = await resolveAccountId(id);
  if (!code) return res.status(404).json({ ok: false, error: "Account not found" });

  const keyName = `code:${code}`;
  const record = await kvGet(keyName, "json");
  if (!record) return res.status(404).json({ ok: false, error: "Account not found" });

  record.status = "active";
  record.revokedAt = null;
  record.revokedBy = null;
  await kvPut(keyName, record);

  res.json({ ok: true, id, status: "active" });
}
