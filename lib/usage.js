import { kvGet, kvPut, kvList } from "./kv.js";
import { randomChars, toNonNegativeInt } from "./utils.js";

export async function record(_, auth, model, usage) {
  if (!auth || !auth.accountId || !usage) return;

  const promptTokens = toNonNegativeInt(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = toNonNegativeInt(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = toNonNegativeInt(usage.total_tokens ?? (promptTokens + completionTokens));

  const timestamp = new Date().toISOString();
  const eventId = randomChars(10);

  const event = {
    timestamp,
    accountId: auth.accountId,
    role: auth.role || "user",
    model: model || "unknown",
    promptTokens,
    completionTokens,
    totalTokens,
    viaApiKey: !!auth.viaApiKey,
    apiKeyId: auth.apiKeyId || null,
  };

  try {
    await kvPut(`usage:event:${auth.accountId}:${Date.now()}:${eventId}`, event, {
      expirationTtl: 60 * 60 * 24 * 91,
    });
  } catch (e) {
    console.error("Usage write failed:", e);
  }
}

async function collect(prefix, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const events = [];
  let cursor;
  let pages = 0;

  do {
    const result = await kvList(prefix, 1000, cursor);
    for (const item of result.keys) {
      const event = await kvGet(item.name, "json");
      if (!event || !event.timestamp) continue;
      const time = Date.parse(event.timestamp);
      if (!Number.isFinite(time) || time < cutoff) continue;
      events.push(event);
    }
    if (result.list_complete) break;
    cursor = result.cursor;
    pages++;
  } while (cursor && pages < 10);

  return events;
}

function summarize(events) {
  const summary = {
    requests: events.length,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    byModel: [],
    byAccount: [],
  };

  const models = new Map();
  const accounts = new Map();

  for (const e of events) {
    const prompt = toNonNegativeInt(e.promptTokens);
    const completion = toNonNegativeInt(e.completionTokens);
    const total = toNonNegativeInt(e.totalTokens);

    summary.promptTokens += prompt;
    summary.completionTokens += completion;
    summary.totalTokens += total;

    const model = e.model || "unknown";
    const m = models.get(model) || { model, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    m.requests++;
    m.promptTokens += prompt;
    m.completionTokens += completion;
    m.totalTokens += total;
    models.set(model, m);

    const accountId = e.accountId || "unknown";
    const a = accounts.get(accountId) || { accountId, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    a.requests++;
    a.promptTokens += prompt;
    a.completionTokens += completion;
    a.totalTokens += total;
    accounts.set(accountId, a);
  }

  summary.byModel = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  summary.byAccount = [...accounts.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return summary;
}

function daysFromQuery(req) {
  const n = Number(req.query.days);
  if (!Number.isFinite(n)) return 30;
  return Math.min(Math.max(Math.floor(n), 1), 90);
}

export async function me(req, res) {
  const days = daysFromQuery(req);
  const events = await collect(`usage:event:${req.auth.accountId}:`, days);
  const summary = summarize(events);
  delete summary.byAccount;
  res.json({ ok: true, days, ...summary });
}

export async function adminUsage(req, res) {
  const days = daysFromQuery(req);
  const events = await collect("usage:event:", days);
  const summary = summarize(events);
  res.json({ ok: true, days, ...summary });
}
