import { kvGet, kvPut } from "./kv.js";
import {
  accountId,
  normalizeCode,
  generateAccessKey,
  maskCode,
  toNonNegativeInt,
} from "./utils.js";

const API_KEY_PREFIX_UPPER = "CRK_LIVE_";
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_REQUESTS = 60;
const API_KEY_LAST_USED_THROTTLE_MS = 60 * 60 * 1000;

function extractKey(req) {
  const h = req.headers["x-china-gpt-key"];
  if (h) return normalizeCode(h);
  const auth = req.headers["authorization"];
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return normalizeCode(m[1]);
  }
  return null;
}

async function authenticateAccessCode(code) {
  const record = await kvGet(`code:${code}`, "json");
  if (!record) return { kind: "invalid" };
  const status = record.status || "active";
  if (status !== "active") return { kind: "revoked", reason: "access_key_revoked" };
  const id = await accountId(code);
  return {
    kind: "ok",
    code,
    accountId: id,
    role: record.role || "user",
    status,
    viaApiKey: false,
    apiKeyId: null,
    apiKeyLabel: null,
  };
}

async function authenticateApiKey(normalizedKey) {
  const hash = await accountId(normalizedKey);
  const record = await kvGet(`apikey:${hash}`, "json");
  if (!record) return { kind: "invalid" };
  if (record.revoked) return { kind: "revoked", reason: "api_key_revoked" };

  const ownerRecord = await kvGet(`code:${record.ownerCode}`, "json");
  if (!ownerRecord) return { kind: "invalid" };
  if ((ownerRecord.status || "active") !== "active") {
    return { kind: "revoked", reason: "access_key_revoked" };
  }

  const now = Date.now();
  const lastUsed = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
  if (!lastUsed || now - lastUsed > API_KEY_LAST_USED_THROTTLE_MS) {
    record.lastUsedAt = new Date(now).toISOString();
    kvPut(`apikey:${hash}`, record).catch(() => {});
  }

  return {
    kind: "ok",
    code: record.ownerCode,
    accountId: record.ownerAccountId,
    role: ownerRecord.role || "user",
    status: ownerRecord.status || "active",
    viaApiKey: true,
    apiKeyId: record.id,
    apiKeyLabel: record.label || null,
  };
}

export async function authenticate(req) {
  const key = extractKey(req);
  if (!key) return { ok: false, status: 401, error: "authentication_required", message: "Login required" };
  const result = key.startsWith(API_KEY_PREFIX_UPPER)
    ? await authenticateApiKey(key)
    : await authenticateAccessCode(key);

  if (result.kind === "invalid") {
    return { ok: false, status: 401, error: "invalid_access_key", message: "Invalid access key" };
  }
  if (result.kind === "revoked") {
    return { ok: false, status: 401, error: result.reason, message: "Access key is revoked" };
  }
  return { ok: true, ...result };
}

export async function requireAuth(req, res, next) {
  const auth = await authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: { message: auth.message, type: auth.error, code: auth.error } });
  }
  req.auth = auth;
  next();
}

export async function requireAdmin(req, res, next) {
  const auth = await authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: { message: auth.message, type: auth.error } });
  }
  if (auth.role !== "admin") {
    return res.status(403).json({ error: { message: "Administrator access required", type: "forbidden" } });
  }
  req.auth = auth;
  next();
}

export async function requireAccessCode(req, res, next) {
  const auth = await authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: { message: auth.message, type: auth.error } });
  }
  if (auth.viaApiKey) {
    return res.status(403).json({
      error: {
        message: "This endpoint requires your access code, not an API key.",
        type: "forbidden",
        code: "access_code_required",
      },
    });
  }
  req.auth = auth;
  next();
}

// ---- Public endpoints ----

export async function login(req, res) {
  const body = req.body || {};
  const normalized = normalizeCode(body.code);
  if (!normalized) return res.status(400).json({ ok: false, error: "Access key required" });

  const record = await kvGet(`code:${normalized}`, "json");
  if (!record) return res.status(401).json({ ok: false, error: "Invalid access key" });

  const status = record.status || "active";
  if (status !== "active") {
    return res.status(401).json({ ok: false, error: "Access key is revoked", type: "access_key_revoked" });
  }

  record.lastLogin = new Date().toISOString();
  await kvPut(`code:${normalized}`, record);

  const id = await accountId(normalized);
  await kvPut(`account:${id}`, normalized);

  res.json({ ok: true, authenticated: true, role: record.role, status: record.status, code: normalized });
}

export async function createAccount(req, res) {
  const initialized = await kvGet("system:initialized");
  if (!initialized) {
    const adminKeys = [];
    for (let i = 0; i < 3; i++) {
      const key = generateAccessKey();
      const record = { role: "admin", status: "active", createdAt: new Date().toISOString(), lastLogin: null };
      await kvPut(`code:${key}`, record);
      const id = await accountId(key);
      await kvPut(`account:${id}`, key);
      adminKeys.push(key);
    }
    await kvPut("system:initialized", { initializedAt: new Date().toISOString() });
    return res.json({
      ok: true,
      firstAccount: true,
      role: "admin",
      keys: adminKeys,
      message: "Initial administrator keys created. Save these keys securely.",
    });
  }

  const key = generateAccessKey();
  const record = { role: "user", status: "active", createdAt: new Date().toISOString(), lastLogin: null };
  await kvPut(`code:${key}`, record);
  const id = await accountId(key);
  await kvPut(`account:${id}`, key);
  res.json({ ok: true, firstAccount: false, role: "user", status: "active", key });
}

// ---- Preferences ----

export async function prefsGet(req, res) {
  // Anyone can read the global base URL.
  const prefs = (await kvGet("prefs:global", "json")) || {};
  res.json({ ok: true, apiBaseUrl: prefs.apiBaseUrl || "", updatedAt: prefs.updatedAt || null });
}

export async function prefsSave(req, res) {
  // Only admins can write it.
  if (req.auth.role !== "admin") {
    return res.status(403).json({ error: { message: "Admin only", type: "forbidden" } });
  }
  const apiBaseUrl = String((req.body || {}).apiBaseUrl || "").trim().slice(0, 500);
  const prefs = (await kvGet("prefs:global", "json")) || {};
  prefs.apiBaseUrl = apiBaseUrl;
  prefs.updatedAt = new Date().toISOString();
  await kvPut("prefs:global", prefs);
  res.json({ ok: true, apiBaseUrl });
}

// ---- /v1/me ----

export async function meEndpoint(req, res) {
  const auth = req.auth;
  const isAdmin = auth.role === "admin";
  const windowId = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const used = isAdmin ? 0 : toNonNegativeInt(await kvGet(`ratelimit:${auth.accountId}:${windowId}`));
  const resetAt = new Date((windowId + 1) * RATE_LIMIT_WINDOW_SECONDS * 1000).toISOString();

  res.json({
    ok: true,
    accountId: auth.accountId,
    role: auth.role,
    viaApiKey: !!auth.viaApiKey,
    apiKeyId: auth.apiKeyId || null,
    apiKeyLabel: auth.apiKeyLabel || null,
    rateLimit: {
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
      limit: isAdmin ? null : RATE_LIMIT_MAX_REQUESTS,
      used: isAdmin ? 0 : used,
      remaining: isAdmin ? null : Math.max(0, RATE_LIMIT_MAX_REQUESTS - used),
      resetAt,
      exempt: isAdmin,
    },
  });
}
