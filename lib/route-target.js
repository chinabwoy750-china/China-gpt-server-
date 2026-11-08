import { resolveForModel } from "./custom-providers.js";
import { getNineRouterKey, getNineRouterBase } from "./ninerouter-config.js";

const R9_PATHS = {
  chat: "/v1/chat/completions",
  image: "/v1/images/generations",
  video: "/v1/videos/generations",
  audio: "/v1/audio/speech"
};

export async function resolveTarget(modelId) {
  const custom = await resolveForModel(modelId);
  if (custom) {
    let apiKey = custom.provider.apiKey;
    const accounts = Array.isArray(custom.provider.accounts) ? custom.provider.accounts : [];
    if (custom.provider.roundRobin !== false && accounts.length > 1) {
      // sticky-ish RR by time bucket so a single request stays on one key
      const idx = Math.floor(Date.now() / 3000) % accounts.length;
      apiKey = accounts[idx].apiKey || apiKey;
    } else if (accounts.length === 1) {
      apiKey = accounts[0].apiKey || apiKey;
    }
    return {
      kind: "custom",
      providerId: custom.provider.id,
      baseUrl: custom.provider.baseUrl,
      apiKey,
      authStyle: custom.provider.authStyle,
      paths: custom.provider.paths,
      actualModelId: custom.actualModelId
    };
  }
  return {
    kind: "9router",
    providerId: null,
    baseUrl: await getNineRouterBase(),
    apiKey: await getNineRouterKey(),
    authStyle: "bearer",
    paths: R9_PATHS,
    actualModelId: modelId
  };
}

export function buildAuthHeaders(style, apiKey) {
  const h = { "Content-Type": "application/json" };
  if (style === "bearer" && apiKey) h.Authorization = `Bearer ${apiKey}`;
  else if (style === "x-api-key" && apiKey) h["x-api-key"] = apiKey;
  else if (style === "anthropic" && apiKey) {
    h["x-api-key"] = apiKey;
    h["anthropic-version"] = "2023-06-01";
  }
  return h;
}
