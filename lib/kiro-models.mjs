import { toAnthropicModelId } from "./kiro-model-resolver.mjs";

const CACHE_TTL_MS = 60 * 60 * 1000;

export const FALLBACK_MODELS = [
  { modelId: "auto", displayName: "Auto" },
  { modelId: "claude-sonnet-4", displayName: "Claude Sonnet 4" },
  { modelId: "claude-sonnet-4.5", displayName: "Claude Sonnet 4.5" },
  { modelId: "claude-sonnet-4.6", displayName: "Claude Sonnet 4.6" },
  { modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
  { modelId: "claude-haiku-4.5", displayName: "Claude Haiku 4.5" },
  { modelId: "claude-opus-4.5", displayName: "Claude Opus 4.5" },
  { modelId: "claude-opus-4.6", displayName: "Claude Opus 4.6" },
  { modelId: "claude-opus-4.7", displayName: "Claude Opus 4.7" },
  { modelId: "claude-opus-4.8", displayName: "Claude Opus 4.8" },
  { modelId: "deepseek-3.2", displayName: "DeepSeek 3.2" },
  { modelId: "glm-5", displayName: "GLM-5" },
  { modelId: "minimax-m2.1", displayName: "MiniMax M2.1" },
  { modelId: "minimax-m2.5", displayName: "MiniMax M2.5" },
  { modelId: "qwen3-coder-next", displayName: "Qwen3 Coder Next" },
];

const MODEL_ALIASES = { "auto-kiro": "auto" };
const HIDDEN_FROM_LIST = new Set(["auto"]);

function normalizeEntry(raw) {
  const id = raw.modelId || raw.id;
  if (!id) return null;
  const maxInput = raw.tokenLimits?.maxInputTokens || raw.maxInputTokens || 200000;
  return {
    id,
    object: "model",
    owned_by: "anthropic",
    display_name: raw.modelName || raw.displayName || raw.description || id,
    context_window: maxInput,
    source: raw.source || "unknown",
  };
}

function mergeModels(entries) {
  const map = new Map();
  for (const entry of entries) {
    const normalized = normalizeEntry(entry);
    if (normalized) map.set(normalized.id, normalized);
  }

  for (const fb of FALLBACK_MODELS) {
    if (!map.has(fb.modelId)) {
      map.set(fb.modelId, {
        id: fb.modelId,
        object: "model",
        owned_by: "anthropic",
        display_name: fb.displayName,
        context_window: 200000,
        source: "fallback",
      });
    }
  }

  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    if (!map.has(alias) && map.has(target)) {
      const base = map.get(target);
      map.set(alias, {
        ...base,
        id: alias,
        display_name: `${base.display_name} (alias)`,
        source: "alias",
      });
    }
  }

  for (const model of [...map.values()]) {
    const anthropicId = toAnthropicModelId(model.id);
    if (anthropicId && anthropicId !== model.id && !map.has(anthropicId)) {
      map.set(anthropicId, {
        ...model,
        id: anthropicId,
        display_name: `${model.display_name || model.id} (Anthropic)`,
        source: "alias",
      });
    }
  }

  const list = [...map.values()].filter((m) => !HIDDEN_FROM_LIST.has(m.id));
  list.sort((a, b) => a.id.localeCompare(b.id));
  return list;
}

async function fetchListAvailableModels(auth, host) {
  const token = await auth.getAccessToken();
  const params = new URLSearchParams({ origin: "AI_EDITOR" });
  if (auth.profileArn) params.set("profileArn", auth.profileArn);

  const url = `${host}/ListAvailableModels?${params}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-amz-target": "AmazonCodeWhispererService.ListAvailableModels",
      "User-Agent": auth.getKiroHeaders(token)["User-Agent"],
    },
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 403) {
    await auth.handleUnauthorized();
    const retryToken = await auth.getAccessToken();
    const retry = await fetch(url, {
      headers: {
        Authorization: `Bearer ${retryToken}`,
        "Content-Type": "application/json",
        "x-amz-target": "AmazonCodeWhispererService.ListAvailableModels",
        "User-Agent": auth.getKiroHeaders(retryToken)["User-Agent"],
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!retry.ok) return null;
    const data = await retry.json();
    return (data.models || []).map((m) => ({ ...m, source: "api" }));
  }

  if (!res.ok) return null;
  const data = await res.json();
  return (data.models || []).map((m) => ({ ...m, source: "api" }));
}

export class ModelRegistry {
  constructor(auth) {
    this.auth = auth;
    this.cache = [];
    this.source = "fallback";
    this.updatedAt = 0;
    this.loading = null;
  }

  isStale() {
    return !this.cache.length || Date.now() - this.updatedAt > CACHE_TTL_MS;
  }

  async refresh({ force = false } = {}) {
    if (!force && !this.isStale()) return this.cache;
    if (this.loading) return this.loading;

    this.loading = this.loadModels()
      .then((models) => {
        this.cache = models;
        this.updatedAt = Date.now();
        return models;
      })
      .finally(() => {
        this.loading = null;
      });

    return this.loading;
  }

  async loadModels() {
    const hosts = [
      this.auth.apiHost,
      `https://q.${this.auth.apiRegion}.amazonaws.com`,
      `https://runtime.${this.auth.apiRegion}.kiro.dev`,
    ];
    const uniqueHosts = [...new Set(hosts)];

    for (const host of uniqueHosts) {
      try {
        const apiModels = await fetchListAvailableModels(this.auth, host);
        if (apiModels?.length) {
          this.source = `api:${host}`;
          console.log(`[kiro-models] 从 ${host} 加载 ${apiModels.length} 个模型`);
          return mergeModels(apiModels);
        }
      } catch (e) {
        console.warn(`[kiro-models] ${host} 拉取失败: ${e.message}`);
      }
    }

    this.source = "fallback";
    console.log(`[kiro-models] 使用内置模型列表 (${FALLBACK_MODELS.length} 个)`);
    return mergeModels(FALLBACK_MODELS);
  }

  async listAnthropicModels({ force = false } = {}) {
    const models = await this.refresh({ force });
    return models.map(({ id, object, owned_by, display_name, context_window, source }) => ({
      id,
      object,
      owned_by,
      display_name,
      context_window,
      source,
    }));
  }

  async listDetailedModels() {
    return this.refresh();
  }

  getStatus() {
    return {
      count: this.cache.length,
      source: this.source,
      updatedAt: this.updatedAt ? new Date(this.updatedAt).toISOString() : null,
    };
  }
}

export function toModelCatalog(models) {
  return {
    models: models.map((m) => ({
      id: m.id,
      display_name: `${m.display_name || m.id} (Kiro)`,
      context_window: m.context_window || 200000,
    })),
  };
}
