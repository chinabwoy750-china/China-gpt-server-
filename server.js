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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// JSON body parser with size cap
app.use(express.json({ limit: "20mb" }));

// Request ID + logging
app.use((req, res, next) => {
  req.requestId = generateRequestId(req);
  res.setHeader("X-Request-ID", req.requestId);
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(`[${req.requestId}] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
  });
  next();
});

// CORS (harmless when same-origin, useful for external API clients)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-China-GPT-Key");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, X-Request-ID");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Health check — the cron-job.org target
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "China-GPT", status: "online", ts: Date.now() });
});

// ---- Public auth ----
app.post("/auth/login", auth.login);
app.post("/auth/create", auth.createAccount);

// ---- Account preferences ----
app.get("/account/prefs", auth.requireAuth, auth.prefsGet);
app.post("/account/prefs", auth.requireAuth, auth.prefsSave);

// ---- API keys (access code only) ----
app.post("/apikeys/create", auth.requireAccessCode, apikeys.create);
app.get("/apikeys/list", auth.requireAccessCode, apikeys.list);
app.post("/apikeys/revoke", auth.requireAccessCode, apikeys.revoke);

// ---- Admin ----
app.get("/admin/status", auth.requireAdmin, admin.status);
app.get("/admin/accounts", auth.requireAdmin, admin.accounts);
app.post("/admin/keys/create", auth.requireAdmin, admin.createKey);
app.post("/admin/keys/revoke", auth.requireAdmin, admin.revokeKey);
app.post("/admin/keys/restore", auth.requireAdmin, admin.restoreKey);
app.get("/admin/apikeys", auth.requireAdmin, apikeys.adminList);
app.get("/admin/usage", auth.requireAdmin, usage.adminUsage);

// ---- Usage ----
app.get("/usage/me", auth.requireAuth, usage.me);

// ---- v1 (models + chat) ----
app.get("/v1/me", auth.requireAuth, auth.meEndpoint);
app.get("/v1/models", auth.requireAuth, ratelimit.check, proxy.models);
app.post("/v1/chat/completions", auth.requireAuth, ratelimit.check, proxy.chat);

// ---- Static HTML ----
app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
}));

// ---- 404 ----
app.use((req, res) => {
  res.status(404).json({ error: { message: "Endpoint not found", type: "not_found" } });
});

// ---- Error handler ----
app.use((err, req, res, next) => {
  console.error(`[${req.requestId}] Unhandled error:`, err);
  res.status(500).json({ error: { message: "Internal server error", type: "internal_error" } });
});

// ---- Boot ----
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
