import { resolveForModel } from "./custom-providers.js";

const NINEROUTER_BASE = "https://ninerouter-china.onrender.com";

const R9_PATHS = {
  chat: "/v1/chat/completions",
  image: "/v1/images/generations",
  video: "/v1/videos/generations",
  audio: "/v1/audio/speech"
};

export async function resolveTarget(modelId) {
  const custom = await resolveForModel(modelId);
  if (custom) {
    return {
      kind: "custom",
      providerId: custom.provider.id,
      baseUrl: custom.provider.baseUrl,
      apiKey: custom.provider.apiKey,
      authStyle: custom.provider.authStyle,
      paths: custom.provider.paths,
      actualModelId: custom.actualModelId
    };
  }
  return {
    kind: "9router",
    providerId: null,
    baseUrl: NINEROUTER_BASE,
    apiKey: process.env.NINEROUTER_API_KEY,
    authStyle: "bearer",
    paths: R9_PATHS,
    actualModelId: modelId
  };
}

export function buildAuthHeaders(style, apiKey) {
  const h = { "Content-Type": "application/json" };
  if (style === "bearer" && apiKey) h.Authorization = `Bearer ${apiKey}`;
  else if (style === "x-api-key" && apiKey) h["x-api-key"] = apiKey;
  return h;
}
