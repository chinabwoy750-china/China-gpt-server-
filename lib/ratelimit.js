import { kvGet, kvPut } from "./kv.js";
import { toNonNegativeInt } from "./utils.js";

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 60;

export async function check(req, res, next) {
  const auth = req.auth;
  if (!auth || !auth.accountId) return next();
  if (auth.role === "admin") return next();

  const windowId = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  const key = `ratelimit:${auth.accountId}:${windowId}`;

  try {
    const current = toNonNegativeInt(await kvGet(key));
    if (current >= MAX_REQUESTS) {
      const retryAfter = WINDOW_SECONDS - (Math.floor(Date.now() / 1000) % WINDOW_SECONDS);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: {
          message: "Rate limit exceeded",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
        requestId: req.requestId,
      });
    }
    await kvPut(key, String(current + 1), { expirationTtl: WINDOW_SECONDS * 2 });
  } catch (e) {
    // Fail open — a bookkeeping failure must never block a real request.
    console.error("Rate limit check failed:", e);
  }

  next();
}
