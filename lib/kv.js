import { Redis } from "@upstash/redis";

let redis;

export async function initKv() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set");
  }
  redis = new Redis({ url, token });
  await redis.ping();
}

function client() {
  if (!redis) throw new Error("KV not initialised. Did you call initKv()?");
  return redis;
}

export async function kvGet(key, type) {
  const raw = await client().get(key);
  if (raw === null || raw === undefined) return null;
  if (type === "json") {
    if (typeof raw === "object") return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

export async function kvPut(key, value, opts) {
  const toStore = typeof value === "string" ? value : JSON.stringify(value);
  if (opts && opts.expirationTtl) {
    await client().set(key, toStore, { ex: opts.expirationTtl });
  } else {
    await client().set(key, toStore);
  }
}

export async function kvDelete(key) {
  await client().del(key);
}

/**
 * Mimics Cloudflare KV's list() response shape so ported
 * endpoint logic doesn't have to change.
 * Returns { keys: [{name}], list_complete: bool, cursor: string|undefined }
 */
export async function kvList(prefix, limit, cursor) {
  const [nextCursor, names] = await client().scan(cursor || "0", {
    match: prefix + "*",
    count: limit || 1000,
  });
  return {
    keys: names.map((name) => ({ name })),
    list_complete: nextCursor === "0",
    cursor: nextCursor === "0" ? undefined : nextCursor,
  };
}
