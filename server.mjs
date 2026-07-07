import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { toAnthropicModelId } from "./lib/kiro-model-resolver.mjs";
import { readKiroCredsSummary } from "./lib/kiro-auth.mjs";
import { readAccountsSummary, resolveCredentialPaths } from "./lib/kiro-accounts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.KIRO_DESKTOP_DATA_DIR || path.join(__dirname, "data");
const KEYS_FILE = path.join(DATA_DIR, "api-keys.json");
const CONFIG_FILE = process.env.KIRO_DESKTOP_CONFIG_FILE || path.join(__dirname, "config.json");
const PUBLIC_DIR = process.env.KIRO_DESKTOP_PUBLIC_DIR || path.join(__dirname, "public");

function expandHome(p) {
  return p.startsWith("~") ? path.join(process.env.HOME || "", p.slice(1)) : p;
}

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  return {
    port: Number(process.env.RELAY_PORT || raw.port || 3920),
    kiroGatewayUrl: process.env.KIRO_GATEWAY_URL || raw.kiroGatewayUrl || "http://127.0.0.1:8000",
    kiroGatewayApiKey: process.env.KIRO_GATEWAY_KEY || raw.kiroGatewayApiKey || "",
    kiroCredsFile: expandHome(process.env.KIRO_CREDS_FILE || raw.kiroCredsFile || "auto"),
    kiroAccountsFile: raw.kiroAccountsFile ? expandHome(raw.kiroAccountsFile) : null,
    credentialMode: raw.credentialMode ?? "local",
    gatewayMode: raw.gatewayMode ?? "native",
    ccSwitchProxyPort: raw.ccSwitchProxyPort ?? 15721,
  };
}

function saveConfig(patch) {
  const current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const next = { ...current, ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(KEYS_FILE)) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ keys: [] }, null, 2), "utf8");
  }
}

function loadKeys() {
  ensureDataFiles();
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  } catch (e) {
    const backup = `${KEYS_FILE}.bak`;
    if (fs.existsSync(backup)) {
      console.warn(`[keys] 凭据文件损坏，尝试从备份恢复: ${e.message}`);
      const restored = JSON.parse(fs.readFileSync(backup, "utf8"));
      saveKeys(restored);
      return restored;
    }
    throw new Error(`API Key 存储文件损坏: ${e.message}`);
  }
}

function saveKeys(data) {
  ensureDataFiles();
  const payload = JSON.stringify(data, null, 2);
  const tmp = `${KEYS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload, "utf8");
  if (fs.existsSync(KEYS_FILE)) {
    try {
      fs.copyFileSync(KEYS_FILE, `${KEYS_FILE}.bak`);
    } catch {
      // ignore backup failures
    }
  }
  fs.renameSync(tmp, KEYS_FILE);
}

function normalizeTargetApp() {
  return "claude";
}

function generateApiKey(name) {
  const token = `sk-kiro-${crypto.randomBytes(24).toString("hex")}`;
  return {
    id: crypto.randomUUID(),
    name: name || "Claude Key",
    targetApp: "claude",
    key: token,
    prefix: token.slice(0, 16) + "...",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    enabled: true,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(data);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(text);
}

function getAuthToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string") return apiKey.trim();
  return "";
}

function validateShellKey(token) {
  const data = loadKeys();
  const item = data.keys.find((k) => k.key === token && k.enabled);
  if (!item) return null;
  item.lastUsedAt = new Date().toISOString();
  saveKeys(data);
  return item;
}

async function checkKiroGateway(config) {
  try {
    const res = await fetch(`${config.kiroGatewayUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, mode: null };
    const data = await res.json().catch(() => ({}));
    return {
      ok: true,
      mode: data.mode || "native",
      version: data.version || null,
      modelCount: data.models?.count ?? null,
      modelSource: data.models?.source ?? null,
    };
  } catch {
    return { ok: false, mode: null };
  }
}

async function fetchGatewayModels(config, { refresh = false } = {}) {
  const headers = {};
  if (config.kiroGatewayApiKey) {
    headers.authorization = `Bearer ${config.kiroGatewayApiKey}`;
  }
  const url = `${config.kiroGatewayUrl}/v1/models${refresh ? "?refresh=1" : ""}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { ok: false, models: [], meta: null };
    const data = await res.json();
    return {
      ok: true,
      models: data.data || [],
      meta: data.meta || null,
    };
  } catch {
    return { ok: false, models: [], meta: null };
  }
}

function buildModelCatalog(gatewayModels = []) {
  const seen = new Set();
  const models = [];
  for (const raw of gatewayModels) {
    const slug = toAnthropicModelId(raw.id);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({ model: slug, displayName: raw.display_name || raw.id || slug });
  }
  if (!models.length) models.push({ model: "claude-sonnet-4-5", displayName: "claude-sonnet-4.5" });
  return { models };
}

function buildClaudeProviderConfig(shellKey, config, gatewayModels = []) {
  const providerId = "kiro-claude-relay";
  const baseUrl = `http://127.0.0.1:${config.port}/`;
  const modelCatalog = buildModelCatalog(gatewayModels);
  const opus = toAnthropicModelId("claude-opus-4.8");
  const sonnet = toAnthropicModelId("claude-sonnet-4.5");
  const haiku = toAnthropicModelId("claude-haiku-4.5");

  return {
    id: providerId,
    name: "Kiro → Claude 中转",
    app_type: "claude",
    settings_config: {
      env: {
        ANTHROPIC_AUTH_TOKEN: shellKey,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_DEFAULT_OPUS_MODEL: opus,
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: opus,
        ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet,
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: sonnet,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku,
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: haiku,
        ANTHROPIC_MODEL: opus,
      },
    },
    meta: {
      apiFormat: "anthropic",
      commonConfigEnabled: true,
      endpointAutoSelect: true,
    },
    modelCatalog,
    ccSwitchSteps: [
      "打开 CC Switch，切换到 Claude 应用",
      "点击右上角 + 添加供应商，选择「自定义」",
      `名称填：Kiro → Claude 中转，API Key 填你的壳子 Key：${shellKey}`,
      `端点 / base_url 填：${baseUrl}`,
      "协议选 Anthropic Messages",
      "保存后启用该供应商",
      "打开 CC Switch 顶部「代理开关」，并开启 Claude 接管",
      "重启 Claude Code 使配置生效",
    ],
  };
}

function buildManualConfigForApp(targetApp, shellKey, config, gatewayModels = []) {
  const ccSwitchProxy = `http://127.0.0.1:${config.ccSwitchProxyPort}`;
  const provider = buildClaudeProviderConfig(shellKey, config, gatewayModels);
  const baseUrl = `http://127.0.0.1:${config.port}/`;
  const env = provider.settings_config.env;
  const envBlock = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
  const quickCopy = [
    "# CC Switch → Claude 手动配置",
    `供应商名称: ${provider.name}`,
    `API Key: ${shellKey}`,
    `Base URL: ${baseUrl}`,
    `CC Switch 代理: ${ccSwitchProxy}`,
    "协议: Anthropic Messages",
    "",
    "# 环境变量（复制到 CC Switch 供应商配置）",
    envBlock,
  ].join("\n");

  return {
    targetApp: "claude",
    shellKey,
    baseUrl,
    ccSwitchProxy,
    protocol: "Anthropic Messages",
    wireApi: null,
    providerName: provider.name,
    provider,
    quickCopy,
    ccSwitchSteps: provider.ccSwitchSteps,
    fields: {
      apiKey: shellKey,
      baseUrl,
      ccSwitchProxy,
      protocol: "Anthropic Messages",
      env,
    },
  };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function proxyToKiroGateway(req, res, config) {
  const upstream = new URL(req.url || "/", config.kiroGatewayUrl);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["content-length"];

  if (config.kiroGatewayApiKey) {
    headers.authorization = `Bearer ${config.kiroGatewayApiKey}`;
  }

  const init = { method: req.method, headers };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await readRawBody(req);
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream, init);
  } catch (e) {
    sendJson(res, 502, {
      error: "kiro_gateway_unreachable",
      message: `无法连接 Kiro Gateway (${config.kiroGatewayUrl})，请先运行 ./scripts/start.sh`,
      detail: e.message,
    });
    return;
  }

  try {
    res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers.entries()));
    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (e) {
    console.warn(`[relay] Kiro Gateway 连接中断: ${e.message}`);
    if (!res.writableEnded) {
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, 502, {
          error: "kiro_gateway_stream_interrupted",
          message: "Kiro Gateway 响应流中断，Relay 已保持运行",
          detail: e.message,
        });
      }
    }
  }
}

function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 404, "Not Found");
    return;
  }
  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  sendText(res, 200, fs.readFileSync(filePath, "utf8"), types[ext] || "application/octet-stream");
}

async function handleApi(req, res, config) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/status" && req.method === "GET") {
    const gateway = await checkKiroGateway(config);
    let credentialPaths = null;
    let creds = null;
    let accounts = null;
    let credentialError = null;
    try {
      credentialPaths = resolveCredentialPaths(config, DATA_DIR);
      creds = await readKiroCredsSummary(credentialPaths.credsFile);
      accounts = readAccountsSummary(config, DATA_DIR);
    } catch (e) {
      credentialError = e.message;
      creds = { ok: false, error: e.message };
      accounts = { ok: false, error: e.message };
    }
    const keys = loadKeys();
    const modelInfo = gateway.ok ? await fetchGatewayModels(config) : { ok: false, models: [], meta: null };
    return sendJson(res, 200, {
      gatewayOk: gateway.ok,
      gatewayMode: gateway.ok ? gateway.mode : config.gatewayMode,
      gatewayVersion: gateway.version,
      credentialMode: credentialPaths?.mode || config.credentialMode,
      credentialSource: credentialPaths?.source || "unavailable",
      credentialBridge: credentialPaths?.credentialBridge || credentialPaths?.source || "unavailable",
      credentialFile: credentialPaths?.credsFile || null,
      ideCredsFile: credentialPaths?.ideCredsFile || null,
      credentialDiscovery: credentialPaths?.credentialDiscovery
        ? {
            found: credentialPaths.credentialDiscovery.found,
            selectedFile: credentialPaths.credentialDiscovery.file,
            selectedSource: credentialPaths.credentialDiscovery.best?.source || null,
            selectedExpired: credentialPaths.credentialDiscovery.best?.expired ?? null,
            searched: credentialPaths.credentialDiscovery.candidates.length,
          }
        : null,
      credentialError,
      accounts,
      modelCount: modelInfo.models.length || gateway.modelCount || 0,
      modelSource: modelInfo.meta?.source || gateway.modelSource || "unknown",
      models: modelInfo.models.map((m) => m.id),
      creds: {
        ...creds,
        source: credentialPaths?.source || "unavailable",
        passiveSync: Boolean(credentialPaths?.passiveSync),
      },
      keyCount: keys.keys.length,
      keysPersisted: true,
      keysFile: KEYS_FILE,
      relayUrl: `http://127.0.0.1:${config.port}/v1`,
      gatewayUrl: config.kiroGatewayUrl,
      ccSwitchProxy: `http://127.0.0.1:${config.ccSwitchProxyPort}`,
      hasGatewayKey: Boolean(config.kiroGatewayApiKey),
    });
  }

  if (url.pathname === "/api/models" && req.method === "GET") {
    const refresh = url.searchParams.get("refresh") === "1";
    const modelInfo = await fetchGatewayModels(config, { refresh });
    return sendJson(res, 200, {
      ok: modelInfo.ok,
      models: modelInfo.models,
      meta: modelInfo.meta,
    });
  }

  if (url.pathname === "/api/keys" && req.method === "GET") {
    const data = loadKeys();
    return sendJson(res, 200, {
      keys: data.keys.map(({ key, ...rest }) => rest),
    });
  }

  if (url.pathname === "/api/keys" && req.method === "POST") {
    const body = await readJsonBody(req);
    const entry = generateApiKey(body.name, body.targetApp);
    const data = loadKeys();
    data.keys.unshift(entry);
    saveKeys(data);
    const modelInfo = await fetchGatewayModels(config);
    const manualConfig = buildManualConfigForApp(entry.targetApp, entry.key, config, modelInfo.models);
    return sendJson(res, 201, { key: entry, manualConfig, persisted: true });
  }

  if (/^\/api\/keys\/[^/]+$/.test(url.pathname) && req.method === "GET") {
    const id = url.pathname.split("/").pop();
    const data = loadKeys();
    const item = data.keys.find((k) => k.id === id);
    if (!item) return sendJson(res, 404, { error: "not_found", message: "Key 不存在" });
    return sendJson(res, 200, {
      id: item.id,
      name: item.name,
      targetApp: item.targetApp || "claude",
      key: item.key,
      prefix: item.prefix,
      enabled: item.enabled,
      createdAt: item.createdAt,
      lastUsedAt: item.lastUsedAt,
      persisted: true,
    });
  }

  if (url.pathname.startsWith("/api/keys/") && req.method === "DELETE") {
    const id = url.pathname.split("/").pop();
    const data = loadKeys();
    data.keys = data.keys.filter((k) => k.id !== id);
    saveKeys(data);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname.startsWith("/api/keys/") && url.pathname.endsWith("/toggle") && req.method === "POST") {
    const id = url.pathname.split("/")[3];
    const data = loadKeys();
    const item = data.keys.find((k) => k.id === id);
    if (!item) return sendJson(res, 404, { error: "not_found" });
    item.enabled = !item.enabled;
    saveKeys(data);
    return sendJson(res, 200, { key: item });
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    return sendJson(res, 200, loadConfig());
  }

  if (url.pathname === "/api/config" && req.method === "POST") {
    const body = await readJsonBody(req);
    const next = saveConfig({
      kiroGatewayApiKey: body.kiroGatewayApiKey ?? "",
      kiroGatewayUrl: body.kiroGatewayUrl,
      port: body.port,
      kiroAccountsFile: body.kiroAccountsFile,
    });
    return sendJson(res, 200, next);
  }

  if (url.pathname === "/api/service/restart" && req.method === "POST") {
    const { execFileSync } = await import("node:child_process");
    const scriptsDir = path.join(__dirname, "scripts");
    try {
      execFileSync(path.join(scriptsDir, "background-stop.sh"), { stdio: "ignore" });
      execFileSync(path.join(scriptsDir, "background-start.sh"), { stdio: "ignore" });
      return sendJson(res, 200, { ok: true, message: "中转服务已重启" });
    } catch (e) {
      return sendJson(res, 500, { error: "restart_failed", message: e.message });
    }
  }

  if (url.pathname === "/api/credentials/mode" && req.method === "POST") {
    const body = await readJsonBody(req);
    const mode = body.credentialMode === "json" ? "json" : "local";
    const patch = { credentialMode: mode };
    if (body.kiroAccountsFile) patch.kiroAccountsFile = expandHome(body.kiroAccountsFile);
    saveConfig(patch);
    const nextConfig = { ...config, ...patch };
    const credentialPaths = resolveCredentialPaths(nextConfig, DATA_DIR);
    const creds = await readKiroCredsSummary(credentialPaths.credsFile);
    return sendJson(res, 200, {
      ok: true,
      message: `已切换为${mode === "json" ? "JSON 账号池" : "本地 Kiro IDE"}模式，请重启中转服务生效`,
      credentialMode: mode,
      credentialSource: credentialPaths.source,
      creds,
      needsRestart: true,
    });
  }

  if (url.pathname === "/api/accounts/config" && req.method === "POST") {
    saveConfig({ credentialMode: "local", kiroAccountsFile: null });
    return sendJson(res, 410, {
      ok: false,
      error: "external_account_pool_disabled",
      message: "外部账号池已停用；当前版本只使用本地 Kiro IDE 凭据。",
      credentialMode: "local",
      needsRestart: true,
    });
  }

  if (url.pathname === "/api/cc-switch-config" && req.method === "GET") {
    const keyId = url.searchParams.get("keyId");
    const data = loadKeys();
    const item = keyId ? data.keys.find((k) => k.id === keyId) : data.keys.find((k) => k.enabled);
    if (!item) return sendJson(res, 400, { error: "no_key", message: "请先创建一个中转 API Key" });
    const modelInfo = await fetchGatewayModels(config);
    const manualConfig = buildManualConfigForApp("claude", item.key, config, modelInfo.models);
    return sendJson(res, 200, {
      ...manualConfig,
      keyId: item.id,
      keyName: item.name,
      manualOnly: true,
    });
  }

  return sendJson(res, 404, { error: "not_found" });
}

const config = loadConfig();
ensureDataFiles();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, config);
    } catch (e) {
      sendJson(res, 500, { error: "internal_error", message: e.message });
    }
    return;
  }

  if (url.pathname.startsWith("/v1/")) {
    const token = getAuthToken(req);
    if (!token || !validateShellKey(token)) {
      return sendJson(res, 401, {
        error: "invalid_api_key",
        message: "无效的中转 API Key，请在管理页创建壳子 Key 后使用",
      });
    }
    try {
      await proxyToKiroGateway(req, res, config);
    } catch (e) {
      console.error("[relay] proxy failed:", e);
      sendJson(res, 502, {
        error: "kiro_gateway_proxy_failed",
        message: "Kiro Gateway 代理失败，Relay 已保持运行",
        detail: e.message,
      });
    }
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  sendText(res, 405, "Method Not Allowed");
});

const relayHost = process.env.RELAY_HOST || "127.0.0.1";
server.listen(config.port, relayHost, () => {
  const { keys } = loadKeys();
  const enabledCount = keys.filter((k) => k.enabled).length;
  const displayHost = relayHost === "0.0.0.0" ? "127.0.0.1" : relayHost;
  console.log(`Kiro Claude 中转管理页: http://${displayHost}:${config.port}`);
  console.log(`Anthropic 兼容端点: http://${displayHost}:${config.port}/v1/messages`);
  console.log(`[keys] 已加载 ${keys.length} 个壳子 Key（${enabledCount} 个启用），存储于 ${KEYS_FILE}`);
});
