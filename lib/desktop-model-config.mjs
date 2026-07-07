import { toAnthropicModelId } from "./kiro-model-resolver.mjs";

export const MODEL_CONFIG_VERSION = 1;
export const DEFAULT_CONTEXT_WINDOW = 200000;

const DEFAULT_MODELS = [
  { id: "claude-haiku-4-5", upstreamId: "claude-haiku-4.5", displayName: "Claude Haiku 4.5" },
  { id: "claude-sonnet-4-5", upstreamId: "claude-sonnet-4.5", displayName: "Claude Sonnet 4.5" },
  { id: "claude-opus-4-8", upstreamId: "claude-opus-4.8", displayName: "Claude Opus 4.8" },
];

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanContextWindow(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CONTEXT_WINDOW;
  return Math.max(4096, Math.min(2_000_000, Math.floor(parsed)));
}

function displayNameFor(models, modelId) {
  return models.find((model) => model.id === modelId)?.displayName || modelId || "";
}

function modelVersionScore(modelId) {
  const id = cleanString(modelId);
  const numbers = [...id.matchAll(/\d+/g)].map((match) => Number(match[0]));
  if (!numbers.length) return 0;
  return numbers.slice(0, 4).reduce((score, value) => score * 1000 + value, 0);
}

function bestFamilyModel(models, family, { enabledOnly = true } = {}) {
  const word = cleanString(family).toLowerCase();
  const candidates = models
    .filter((model) => (!enabledOnly || model.enabled !== false) && model.id.toLowerCase().includes(word))
    .sort((a, b) => modelVersionScore(b.id) - modelVersionScore(a.id) || a.id.localeCompare(b.id));
  return candidates[0]?.id || "";
}

function pickModel(models, preferred, fallbackWords = []) {
  const enabled = models.filter((model) => model.enabled !== false);
  if (!enabled.length) return "";
  const preferredId = cleanString(preferred);
  if (preferredId && enabled.some((model) => model.id === preferredId)) return preferredId;

  for (const word of fallbackWords) {
    const match = enabled.find((model) => model.id.includes(word));
    if (match) return match.id;
  }
  return enabled[0].id;
}

function pickFamilyModel(models, preferred, family, fallbackWords = []) {
  const enabled = models.filter((model) => model.enabled !== false);
  if (!enabled.length) return "";

  const word = cleanString(family).toLowerCase();
  const preferredId = cleanString(preferred);
  if (
    preferredId &&
    preferredId.toLowerCase().includes(word) &&
    enabled.some((model) => model.id === preferredId)
  ) {
    return preferredId;
  }

  const exactFamily = bestFamilyModel(enabled, word, { enabledOnly: false });
  if (exactFamily) return exactFamily;

  return pickModel(models, "", fallbackWords);
}

function pickRoleModel(models, preferred, fallbackFamily, fallbackWords = []) {
  const enabled = models.filter((model) => model.enabled !== false);
  const preferredId = cleanString(preferred);
  if (preferredId && enabled.some((model) => model.id === preferredId)) return preferredId;
  return pickFamilyModel(models, preferredId, fallbackFamily, fallbackWords);
}

function roleDisplayName(models, selectedId, preferredId, preferredName) {
  if (selectedId && selectedId === cleanString(preferredId)) {
    return cleanString(preferredName) || displayNameFor(models, selectedId);
  }
  return displayNameFor(models, selectedId);
}

function normalizeModelEntry(raw = {}) {
  const upstreamId = cleanString(raw.upstreamId) || cleanString(raw.modelId) || cleanString(raw.id);
  const publicId = cleanString(raw.id) || toAnthropicModelId(upstreamId);
  const id = toAnthropicModelId(publicId || upstreamId);
  if (!id) return null;

  return {
    id,
    upstreamId: upstreamId || id,
    displayName:
      cleanString(raw.displayName) ||
      cleanString(raw.display_name) ||
      cleanString(raw.modelName) ||
      cleanString(raw.description) ||
      id,
    contextWindow: cleanContextWindow(raw.contextWindow || raw.context_window || raw.maxInputTokens),
    enabled: raw.enabled !== false,
    source: cleanString(raw.source) || "manual",
    custom: Boolean(raw.custom),
  };
}

function normalizeModels(models = []) {
  const byId = new Map();

  for (const fallback of DEFAULT_MODELS) {
    const entry = normalizeModelEntry({
      ...fallback,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      enabled: true,
      source: "fallback",
    });
    byId.set(entry.id, entry);
  }

  for (const raw of models) {
    const entry = normalizeModelEntry(raw);
    if (!entry) continue;
    byId.set(entry.id, {
      ...(byId.get(entry.id) || {}),
      ...entry,
    });
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function defaultClaudeConfig(models) {
  const haiku = pickModel(models, "claude-haiku-4-5", ["haiku"]);
  const sonnet = pickModel(models, "claude-sonnet-4-5", ["sonnet"]);
  const opus = pickModel(models, "claude-opus-4-8", ["opus", "sonnet"]);
  const fable = opus || sonnet;
  const smallFast = sonnet || haiku || opus;

  return {
    defaultModel: sonnet || opus || haiku,
    smallFast,
    smallFastName: displayNameFor(models, smallFast),
    haiku,
    haikuName: displayNameFor(models, haiku),
    sonnet,
    sonnetName: displayNameFor(models, sonnet),
    opus,
    opusName: displayNameFor(models, opus),
    fable,
    fableName: displayNameFor(models, fable),
  };
}

function normalizeClaudeConfig(raw, models) {
  const defaults = defaultClaudeConfig(models);
  const next = { ...defaults, ...(raw || {}) };
  const haiku = pickRoleModel(models, next.haiku, "haiku", ["sonnet", "opus"]);
  const sonnet = pickRoleModel(models, next.sonnet, "sonnet", ["haiku", "opus"]);
  const opus = pickRoleModel(models, next.opus, "opus", ["sonnet"]);
  const fable = pickRoleModel(models, next.fable, "fable", ["opus", "sonnet"]);
  const smallFast = pickRoleModel(models, next.smallFast, "sonnet", ["haiku", "opus"]);
  const defaultModel = pickModel(models, next.defaultModel, ["sonnet", "opus", "haiku"]);

  return {
    defaultModel,
    smallFast,
    smallFastName: roleDisplayName(models, smallFast, next.smallFast, next.smallFastName),
    haiku,
    haikuName: roleDisplayName(models, haiku, next.haiku, next.haikuName),
    sonnet,
    sonnetName: roleDisplayName(models, sonnet, next.sonnet, next.sonnetName),
    opus,
    opusName: roleDisplayName(models, opus, next.opus, next.opusName),
    fable,
    fableName: roleDisplayName(models, fable, next.fable, next.fableName),
  };
}

function normalizeTargetsConfig(raw = {}) {
  // Claude takeover is the only target. "manual" simply means it is off.
  const claudeEnabled =
    typeof raw.claudeEnabled === "boolean"
      ? raw.claudeEnabled
      : typeof raw.claude === "boolean"
        ? raw.claude
        : true;

  return {
    mode: claudeEnabled ? "claude" : "manual",
    claudeEnabled,
  };
}

function normalizeQualityConfig(raw = {}) {
  const effort = cleanString(raw.reasoningEffort || raw.effort || "").toLowerCase();
  const allowedEfforts = new Set(["low", "medium", "high", "xhigh", "max"]);

  return {
    noDowngrade: Boolean(raw.noDowngrade),
    reasoningEffort: allowedEfforts.has(effort) ? effort : "medium",
  };
}

function pickPreferredOpusModel(models, rawClaude = {}) {
  const candidates = [
    rawClaude.defaultModel,
    rawClaude.opus,
    rawClaude.sonnet,
    rawClaude.haiku,
    rawClaude.fable,
  ];

  for (const candidate of candidates) {
    const preferredId = cleanString(candidate);
    if (!preferredId || !preferredId.toLowerCase().includes("opus")) continue;
    const picked = pickFamilyModel(models, preferredId, "opus", []);
    if (picked === preferredId) return picked;
  }

  return (
    bestFamilyModel(models, "opus") ||
    bestFamilyModel(models, "opus", { enabledOnly: false }) ||
    pickModel(models, "", ["sonnet", "haiku"])
  );
}

function normalizeProtectedClaudeConfig(raw, models) {
  const claude = normalizeClaudeConfig(raw, models);
  const defaultModel = cleanString(claude.defaultModel);
  if (defaultModel.toLowerCase().includes("opus")) return claude;

  const opusDefault = pickPreferredOpusModel(models, {
    ...(raw || {}),
    opus: claude.opus,
  });

  return {
    ...claude,
    defaultModel: opusDefault || claude.defaultModel,
  };
}

export function normalizeModelConfig(raw = {}) {
  const models = normalizeModels(raw.models);
  const quality = normalizeQualityConfig(raw.quality);
  const claude = quality.noDowngrade
    ? normalizeProtectedClaudeConfig(raw.claude, models)
    : normalizeClaudeConfig(raw.claude, models);

  return {
    version: MODEL_CONFIG_VERSION,
    updatedAt: cleanString(raw.updatedAt) || null,
    source: cleanString(raw.source) || "fallback",
    models,
    targets: normalizeTargetsConfig(raw.targets),
    quality,
    claude,
  };
}

export function defaultModelConfig() {
  return normalizeModelConfig({
    source: "fallback",
    updatedAt: null,
    models: DEFAULT_MODELS,
  });
}

export function mergeFetchedModels(currentConfig, fetchedModels = [], source = "api") {
  const current = normalizeModelConfig(currentConfig);
  const byId = new Map(current.models.map((model) => [model.id, model]));

  for (const raw of fetchedModels) {
    const entry = normalizeModelEntry({
      id: toAnthropicModelId(raw.id),
      upstreamId: raw.id,
      displayName: raw.display_name || raw.displayName || raw.id,
      contextWindow: raw.context_window || raw.contextWindow,
      enabled: true,
      source: raw.source || source,
    });
    if (!entry) continue;
    const existing = byId.get(entry.id);
    byId.set(entry.id, {
      ...entry,
      ...(existing || {}),
      upstreamId: existing?.upstreamId || entry.upstreamId,
      source: entry.source,
      enabled: existing?.enabled ?? true,
      custom: existing?.custom || false,
    });
  }

  return normalizeModelConfig({
    ...current,
    source,
    updatedAt: new Date().toISOString(),
    models: [...byId.values()],
  });
}

export function summarizeModelConfig(modelConfig) {
  const config = normalizeModelConfig(modelConfig);
  return {
    pathVersion: config.version,
    source: config.source,
    updatedAt: config.updatedAt,
    modelCount: config.models.length,
    enabledCount: config.models.filter((model) => model.enabled !== false).length,
    targetMode: config.targets.mode,
    claudeEnabled: config.targets.claudeEnabled,
    claudeDefaultModel: config.claude.defaultModel,
  };
}

export function repairClaudeRoleMapping(modelConfig) {
  const config = normalizeModelConfig(modelConfig);
  const sourceModels = config.models;
  const haiku = pickRoleModel(sourceModels, config.claude.haiku, "haiku", ["sonnet", "opus"]);
  const sonnet = pickRoleModel(sourceModels, config.claude.sonnet, "sonnet", ["haiku", "opus"]);
  const opus = pickRoleModel(sourceModels, config.claude.opus || config.claude.defaultModel, "opus", ["sonnet"]);
  const fable = pickRoleModel(sourceModels, config.claude.fable, "fable", ["opus", "sonnet"]);
  const smallFast = pickRoleModel(sourceModels, config.claude.smallFast, "sonnet", ["haiku", "opus"]);
  const roleModelIds = new Set([haiku, sonnet, opus, fable, smallFast].filter(Boolean));
  const models = sourceModels.map((model) => (roleModelIds.has(model.id) ? { ...model, enabled: true } : model));
  const defaultModel = cleanString(config.claude.defaultModel).toLowerCase().includes("opus")
    ? config.claude.defaultModel
    : opus || config.claude.defaultModel;

  return normalizeModelConfig({
    ...config,
    models,
    claude: {
      ...config.claude,
      defaultModel,
      smallFast,
      smallFastName: displayNameFor(models, smallFast),
      haiku,
      haikuName: displayNameFor(models, haiku),
      sonnet,
      sonnetName: displayNameFor(models, sonnet),
      opus,
      opusName: displayNameFor(models, opus),
      fable,
      fableName: displayNameFor(models, fable),
    },
  });
}

export function buildClaudeEnvFromModelConfig(modelConfig, { shellKey, baseUrl }) {
  const config = normalizeModelConfig(modelConfig);
  const claude = config.claude;
  const smallFastModel = claude.smallFast || (config.quality.noDowngrade ? claude.sonnet || claude.opus || claude.haiku : claude.haiku);
  return {
    ANTHROPIC_AUTH_TOKEN: shellKey,
    ANTHROPIC_BASE_URL: baseUrl.replace(/\/$/, ""),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: claude.haiku,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: claude.haikuName,
    ANTHROPIC_DEFAULT_SONNET_MODEL: claude.sonnet,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: claude.sonnetName,
    ANTHROPIC_DEFAULT_OPUS_MODEL: claude.opus,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: claude.opusName,
    ANTHROPIC_DEFAULT_FABLE_MODEL: claude.fable,
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: claude.fableName,
    ANTHROPIC_SMALL_FAST_MODEL: smallFastModel,
  };
}
