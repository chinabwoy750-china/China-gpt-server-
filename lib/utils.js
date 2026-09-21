export function randomChars(length) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export async function accountId(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateRequestId(req) {
  const incoming = req.headers["x-request-id"];
  if (incoming && /^[A-Za-z0-9._-]{1,64}$/.test(incoming)) return incoming;
  return crypto.randomUUID();
}

export function normalizeCode(code) {
  if (!code || typeof code !== "string") return null;
  return code.trim().toUpperCase();
}

export function normalizeId(id) {
  if (!id || typeof id !== "string") return null;
  return id.trim().toLowerCase();
}

export function maskCode(code) {
  if (!code || code.length < 8) return "••••••••";
  const parts = code.split("-");
  if (parts.length === 4) return `•••••-•••••-••••-${parts[3]}`;
  return `••••••••${code.slice(-4)}`;
}

export function maskApiKey(fullKey) {
  if (!fullKey || fullKey.length < 12) return "crk_live_••••••••";
  return "crk_live_" + "••••••••" + fullKey.slice(-4);
}

export function generateAccessKey() {
  return [randomChars(5), randomChars(5), randomChars(4), randomChars(4)].join("-");
}

export function generateApiKey() {
  return "crk_live_" + randomChars(32);
}

export function toNonNegativeInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
