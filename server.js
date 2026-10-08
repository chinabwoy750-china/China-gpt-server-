import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initKv } from "./lib/kv.js";
import { generateRequestId } from "./lib/utils.js";
import * as auth from "./lib/auth.js";
import * as apikeys from "./lib/apikeys.js";
import * as admin from "./lib/admin.js";
import * as usage from "./lib/usage.js";
import * as proxy from "./lib/proxy.js";
import * as ratelimit from "./lib/ratelimit.js";
import * as providerIcons from "./lib/provider-icons.js";
import * as modelHealth from "./lib/model-health.js";
import * as searchConfig from "./lib/search-config.js";
import * as providerOverrides from "./lib/provider-overrides.js";
import * as siteLock from "./lib/site-lock.js";
import * as modelGroups from "./lib/model-groups.js";
import * as telegram from "./lib/telegram.js";
import * as online from "./lib/online.js";
import * as anthropic from "./lib/anthropic-compat.js";
import * as media from "./lib/media-proxy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));

app.use((req, res, next) => {
  req.requestId = generateRequestId(req);
  res.setHeader("X-Request-ID", req.requestId);
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(`[${req.requestId}] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
  });
  next();
});

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-China-GPT-Key");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, X-Request-ID, Retry-After");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ---- Always-open routes ----

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "China-GPT", status: "online", ts: Date.now() });
});

app.get("/stats/online", online.getStats);

app.get("/debug/auth", async (req, res) => {
  const raw =
    req.headers["x-china-gpt-key"] ||
    req.headers["authorization"] ||
    (req.headers.cookie && req.headers.cookie.match(/china_gpt_key=([^;]+)/)?.[1]) ||
    null;
  const stripped = raw ? String(raw).replace(/^Bearer\s+/i, "") : null;
  res.json({
    ok: true,
    sawHeader: !!req.headers["x-china-gpt-key"],
    sawAuth: !!req.headers["authorization"],
    sawCookie: !!(req.headers.cookie && req.headers.cookie.includes("china_gpt_key=")),
    valueFirst4: stripped ? decodeURIComponent(stripped).slice(0, 4) : null,
    valueLength: stripped ? decodeURIComponent(stripped).length : 0
  });
});


// Public lock status. Reports whether the caller is an admin so the
// frontend knows whether to show the takeover or the app-with-banner.
app.get("/site-lock", async (req, res) => {
  const lock = await siteLock.getLock();
  if (!lock) return res.json({ ok: true, locked: false });

  let isAdmin = false;
  try {
    const a = await auth.authenticate(req);
    isAdmin = !!(a.ok && a.role === "admin");
  } catch {}

  const remainingSeconds = lock.until
    ? Math.max(0, Math.floor((Date.parse(lock.until) - Date.now()) / 1000))
    : null;

  res.json({
    ok: true,
    locked: true,
    isAdmin,
    message: lock.message,
    lockedAt: lock.lockedAt,
    until: lock.until,
    remainingSeconds
  });
});

app.post("/auth/login", auth.login);
app.post("/auth/logout", auth.logout);

// ---- Site Lock middleware ----
// Only applies to API surface. Static files and the open routes
// above are never blocked, so the takeover page can always load.
// Admins always pass through. Fails CLOSED on Redis errors.

function isLockedPath(p) {
  if (p === "/health") return false;
  if (p === "/stats/online") return false;
  if (p === "/site-lock") return false;
  if (p === "/auth/login") return false;
  if (p === "/auth/logout") return false;
  if (p === "/debug/auth") return false;
  if (p === "/telegram/webhook") return false;
  if (p === "/auth/create") return true;
  const prefixes = ["/v1", "/admin", "/apikeys", "/account", "/usage",
                    "/provider-icons", "/search-config", "/provider-overrides", "/icon-proxy"];
  return prefixes.some(pre => p === pre || p.startsWith(pre + "/"));
}

app.use(async (req, res, next) => {
  if (req.method === "OPTIONS") return next();
  if (!isLockedPath(req.path)) return next();

  let lock;
  try {
    lock = await siteLock.getLock();
  } catch (err) {
    console.error("Site lock check failed:", err);
    return res.status(423).json({
      error: {
        type: "site_locked",
        code: "site_locked",
        message: "Site is locked. Try again shortly."
      }
    });
  }
  if (!lock) return next();

  try {
    const a = await auth.authenticate(req);
    if (a.ok && a.role === "admin") return next();
  } catch {}

  const retryAfter = lock.until
    ? Math.max(1, Math.ceil((Date.parse(lock.until) - Date.now()) / 1000))
    : 3600;
  res.setHeader("Retry-After", String(retryAfter));
  return res.status(423).json({
    error: {
      type: "site_locked",
      code: "site_locked",
      message: lock.message || "Site is temporarily locked",
      until: lock.until
    }
  });
});

// ---- Online presence tracking ----
// Fires after auth succeeds on any authenticated request. Fire-and-forget
// so it never blocks the request path.
app.use((req, res, next) => {
  res.on("finish", () => {
    if (req.auth && req.auth.accountId && res.statusCode < 400) {
      online.touch(req.auth.accountId).catch(() => {});
    }
  });
  next();
});

// ---- Public auth (create is behind the lock check above) ----

app.post("/auth/create", auth.createAccount);

// ---- Everything else ----

app.get("/account/prefs", auth.requireAuth, auth.prefsGet);
app.post("/account/prefs", auth.requireAuth, auth.prefsSave);

app.post("/apikeys/create", auth.requireAccessCode, apikeys.create);
app.get("/apikeys/list", auth.requireAccessCode, apikeys.list);
app.post("/apikeys/revoke", auth.requireAccessCode, apikeys.revoke);

app.get("/admin/status", auth.requireAdmin, admin.status);
app.get("/admin/accounts", auth.requireAdmin, admin.accounts);
app.post("/admin/keys/create", auth.requireAdmin, admin.createKey);
app.post("/admin/keys/revoke", auth.requireAdmin, admin.revokeKey);
app.post("/admin/keys/restore", auth.requireAdmin, admin.restoreKey);
app.get("/admin/apikeys", auth.requireAdmin, apikeys.adminList);
app.get("/admin/usage", auth.requireAdmin, usage.adminUsage);

// ---- Site Lock admin ----
app.get("/admin/site-lock", auth.requireAdmin, siteLock.adminGet);
app.post("/admin/site-lock/lock", auth.requireAdmin, siteLock.adminLock);
app.post("/admin/site-lock/unlock", auth.requireAdmin, siteLock.adminUnlock);
// ---- Telegram bot ----
app.post("/telegram/webhook", telegram.webhook);
app.get("/admin/telegram", auth.requireAdmin, telegram.adminGet);
app.post("/admin/telegram", auth.requireAdmin, telegram.adminSave);
app.post("/admin/telegram/set-webhook", auth.requireAdmin, telegram.adminSetWebhook);
app.post("/admin/telegram/delete-webhook", auth.requireAdmin, telegram.adminDeleteWebhook);
app.get("/admin/telegram/get-me", auth.requireAdmin, telegram.adminGetMe);


app.get("/provider-icons", auth.requireAuth, providerIcons.list);
app.get("/admin/provider-icons", auth.requireAdmin, providerIcons.adminList);
app.post("/admin/provider-icons", auth.requireAdmin, providerIcons.setIcon);

app.get("/admin/model-health", auth.requireAdmin, modelHealth.get);
app.get("/admin/model-health/all-models", auth.requireAdmin, modelHealth.allModels);
app.post("/admin/model-health/test", auth.requireAdmin, modelHealth.testOne);
app.post("/admin/model-health/disable-model", auth.requireAdmin, modelHealth.disableModel);
app.post("/admin/model-health/enable-model", auth.requireAdmin, modelHealth.enableModel);
app.post("/admin/model-health/disable-provider", auth.requireAdmin, modelHealth.disableProvider);
app.post("/admin/model-health/enable-provider", auth.requireAdmin, modelHealth.enableProvider);
app.post("/admin/model-health/disable-batch", auth.requireAdmin, modelHealth.disableBatch);
app.post("/admin/model-health/enable-all", auth.requireAdmin, modelHealth.enableAll);

// ---- Model groups (canonical grouping + admin pins) ----
app.get("/admin/model-groups", auth.requireAdmin, modelGroups.adminList);
app.post("/admin/model-groups/pin", auth.requireAdmin, modelGroups.adminPin);
app.post("/admin/model-groups/clear-cooldown", auth.requireAdmin, modelGroups.adminClearCooldown);

app.get("/search-config", auth.requireAuth, searchConfig.publicGet);
app.get("/admin/search-config", auth.requireAdmin, searchConfig.adminGet);
app.post("/admin/search-config", auth.requireAdmin, searchConfig.adminSave);

app.get("/provider-overrides", auth.requireAuth, providerOverrides.publicGet);
app.get("/admin/provider-overrides", auth.requireAdmin, providerOverrides.adminGet);
app.post("/admin/provider-overrides/pattern/add", auth.requireAdmin, providerOverrides.adminAddPattern);
app.post("/admin/provider-overrides/pattern/remove", auth.requireAdmin, providerOverrides.adminRemovePattern);
app.post("/admin/provider-overrides/model/add", auth.requireAdmin, providerOverrides.adminAddModelId);
app.post("/admin/provider-overrides/model/remove", auth.requireAdmin, providerOverrides.adminRemoveModelId);

app.get("/usage/me", auth.requireAuth, usage.me);

app.get("/v1/me", auth.requireAuth, auth.meEndpoint);
app.get("/v1/models", auth.requireAuth, ratelimit.check, proxy.models);
app.post("/v1/chat/completions", auth.requireAuth, ratelimit.check, proxy.chat);
app.post("/v1/search", auth.requireAuth, ratelimit.check, proxy.search);
app.post("/v1/web/fetch", auth.requireAuth, ratelimit.check, proxy.webFetch);

// ---- Anthropic-compatible endpoint ----
app.post("/v1/messages", auth.requireAuth, ratelimit.check, anthropic.handleMessages);

// ---- Media endpoints ----
app.post("/v1/image-generation", auth.requireAuth, ratelimit.check, media.imageGeneration);
app.post("/v1/video-generation", auth.requireAuth, ratelimit.check, media.videoGeneration);
app.post("/v1/audio",            auth.requireAuth, ratelimit.check, media.audio);

// ---- Web-fetch alias (dash variant of /v1/web/fetch) ----
app.post("/v1/web-fetch", auth.requireAuth, ratelimit.check, proxy.webFetch);

app.get("/icon-proxy", async (req, res) => {
  const url = String(req.query.url || "");
  if (!/^https?:\/\//i.test(url)) return res.status(400).end();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(r.status).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/svg+xml");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch {
    res.status(502).end();
  }
});

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
}));

app.use((req, res) => {
  res.status(404).json({ error: { message: "Endpoint not found", type: "not_found" } });
});

app.use((err, req, res, next) => {
  console.error(`[${req.requestId}] Unhandled error:`, err);
  res.status(500).json({ error: { message: "Internal server error", type: "internal_error" } });
});

(async () => {
  try {
    await initKv();
    app.listen(PORT, () => {
      console.log(`China-GPT listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Failed to initialise KV:", err);
    process.exit(1);
  }
})();
