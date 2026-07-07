import { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage } from "electron";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildClaudeEnvFromModelConfig,
  defaultModelConfig,
  mergeFetchedModels,
  normalizeModelConfig,
  repairClaudeRoleMapping,
  summarizeModelConfig,
} from "../lib/desktop-model-config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, "..");
const CONFIG_NAME = "config.json";
const MODEL_CONFIG_NAME = "model-config.json";
const CLAUDE_BACKUP_INDEX_NAME = "claude-backups.json";
const DEFAULT_RELAY_PORT = 3920;
const DEFAULT_GATEWAY_PORT = 8000;
const SERVICE_TIMEOUT_MS = 20_000;
const CLAUDE_MANAGED_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_SMALL_FAST_MODEL",
];
const CREDENTIAL_REFRESH_TIMEOUT_MS = 75_000;
const CREDENTIAL_GUARD_INTERVAL_MS = 60_000;
const CREDENTIAL_EXPIRY_WINDOW_MS = 15 * 60 * 1000;
const KIRO_HELPER_APPS = [
  {
    id: "kiro",
    name: "Kiro",
    appPath: "/Applications/Kiro.app",
    processPattern: "/Applications/Kiro.app/Contents/MacOS/Electron",
    background: false,
  },
];

let mainWindow = null;
let tray = null;
let relayProcess = null;
let gatewayProcess = null;
let forceQuit = false;
let credentialGuardTimer = null;
let credentialRefreshPromise = null;
let lastCredentialRefreshResult = null;

function getPaths() {
  const userData = app.getPath("userData");
  return {
    userData,
    configFile: path.join(userData, CONFIG_NAME),
    modelConfigFile: path.join(userData, MODEL_CONFIG_NAME),
    dataDir: path.join(userData, "data"),
    logsDir: path.join(userData, "logs"),
    claudeBackupIndexFile: path.join(userData, CLAUDE_BACKUP_INDEX_NAME),
    bundledConfigFile: path.join(__dirname, "default-config.json"),
    serverEntry: path.join(APP_ROOT, "server.mjs"),
    gatewayEntry: path.join(APP_ROOT, "native-gateway.mjs"),
    rendererEntry: path.join(__dirname, "renderer", "index.html"),
  };
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function expandHome(value) {
  if (!value) return value;
  return value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
}

function createDefaultConfig(legacy = {}) {
  const gatewayPort = Number(legacy.gatewayPort || DEFAULT_GATEWAY_PORT);
  return {
    port: Number(legacy.port || DEFAULT_RELAY_PORT),
    gatewayPort,
    gatewayMode: "native",
    kiroGatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    kiroGatewayApiKey: legacy.kiroGatewayApiKey || `kg-${crypto.randomBytes(16).toString("hex")}`,
    credentialMode: "local",
    kiroCredsFile: legacy.kiroCredsFile || "auto",
    kiroAccountsFile: null,
    kiroApiRegion: legacy.kiroApiRegion || "us-east-1",
    ccSwitchProxyPort: legacy.ccSwitchProxyPort || 15721,
  };
}

function ensureDesktopConfig() {
  const paths = getPaths();
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });

  const existing = readJson(paths.configFile);
  if (existing) {
    const normalized = createDefaultConfig(existing);
    if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
      writeJson(paths.configFile, normalized);
    }
    return normalized;
  }

  const legacy = readJson(paths.bundledConfigFile, {});
  const next = createDefaultConfig(legacy || {});
  writeJson(paths.configFile, next);
  return next;
}

function saveConfigPatch(patch) {
  const paths = getPaths();
  const current = ensureDesktopConfig();
  const next = createDefaultConfig({ ...current, ...patch });
  writeJson(paths.configFile, next);
  return next;
}

function ensureModelConfig() {
  const paths = getPaths();
  const existing = readJson(paths.modelConfigFile);
  const normalized = existing ? normalizeModelConfig(existing) : defaultModelConfig();
  if (!existing || JSON.stringify(existing) !== JSON.stringify(normalized)) {
    writeJson(paths.modelConfigFile, normalized);
  }
  return normalized;
}

function saveModelConfig(nextConfig) {
  const normalized = normalizeModelConfig(nextConfig || {});
  writeJson(getPaths().modelConfigFile, normalized);
  return normalized;
}

async function fetchRelayModels(config, { refresh = false } = {}) {
  const suffix = refresh ? "?refresh=1" : "";
  const data = await fetchJson(`http://127.0.0.1:${config.port}/api/models${suffix}`, { timeout: 20_000 });
  return {
    models: data.models || [],
    meta: data.meta || null,
  };
}

async function refreshModelConfig({ refresh = true } = {}) {
  let config = ensureDesktopConfig();
  await startServices();
  config = ensureDesktopConfig();
  const current = ensureModelConfig();
  const modelInfo = await fetchRelayModels(config, { refresh });
  const source = modelInfo.meta?.source || (refresh ? "api" : "relay");
  const next = mergeFetchedModels(current, modelInfo.models, source);
  return {
    ok: true,
    modelConfig: saveModelConfig(next),
    meta: modelInfo.meta,
    path: getPaths().modelConfigFile,
  };
}

function getModelConfigPayload() {
  return {
    ok: true,
    modelConfig: ensureModelConfig(),
    path: getPaths().modelConfigFile,
  };
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(startPort) {
  for (let port = Number(startPort); port < Number(startPort) + 100; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`未找到可用端口，起始端口: ${startPort}`);
}

async function reconcilePorts(config) {
  const relayPort = await findAvailablePort(config.port || DEFAULT_RELAY_PORT);
  const gatewayPort = await findAvailablePort(config.gatewayPort || DEFAULT_GATEWAY_PORT);
  const next = {
    ...config,
    port: relayPort,
    gatewayPort,
    kiroGatewayUrl: `http://127.0.0.1:${gatewayPort}`,
  };
  writeJson(getPaths().configFile, next);
  return next;
}

function appendProcessLogs(child, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { flags: "a" });
  const stamp = `[${new Date().toISOString()}] process started pid=${child.pid}\n`;
  stream.write(stamp);
  child.stdout?.on("data", (chunk) => stream.write(chunk));
  child.stderr?.on("data", (chunk) => stream.write(chunk));
  child.on("exit", (code, signal) => {
    stream.write(`\n[${new Date().toISOString()}] process exited code=${code} signal=${signal}\n`);
    stream.end();
  });
}

function defaultReasoningEffort() {
  const quality = ensureModelConfig().quality || {};
  return quality.noDowngrade ? quality.reasoningEffort || "medium" : process.env.KIRO_DEFAULT_REASONING_EFFORT || "low";
}

function spawnNodeScript(script, config, logName) {
  const paths = getPaths();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    KIRO_DESKTOP_CONFIG_FILE: paths.configFile,
    KIRO_DESKTOP_DATA_DIR: paths.dataDir,
    KIRO_GATEWAY_KEY: config.kiroGatewayApiKey,
    KIRO_GATEWAY_URL: config.kiroGatewayUrl,
    KIRO_CREDS_FILE: expandHome(config.kiroCredsFile),
    KIRO_DEFAULT_REASONING_EFFORT: defaultReasoningEffort(),
    GATEWAY_PORT: String(config.gatewayPort),
    RELAY_PORT: String(config.port),
  };

  const child = childProcess.spawn(process.execPath, [script], {
    cwd: APP_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  appendProcessLogs(child, path.join(paths.logsDir, logName));
  return child;
}

async function fetchJson(url, { timeout = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.message || body.error?.message || `HTTP ${response.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForJson(url, timeoutMs = SERVICE_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetchJson(url, { timeout: 1500 });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw lastError || new Error(`等待服务超时: ${url}`);
}

function terminateProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) return resolve();
    const done = () => resolve();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // process already gone
      }
      resolve();
    }, 2500);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function stopServices() {
  await Promise.all([terminateProcess(relayProcess), terminateProcess(gatewayProcess)]);
  relayProcess = null;
  gatewayProcess = null;
  updateTray();
  return getStatus();
}

async function stopRelayService() {
  await terminateProcess(relayProcess);
  relayProcess = null;
  updateTray();
  return getStatus();
}

async function stopGatewayService() {
  await terminateProcess(gatewayProcess);
  gatewayProcess = null;
  updateTray();
  return getStatus();
}

async function startGatewayService({ restart = false, silent = false } = {}) {
  if (restart) {
    await terminateProcess(gatewayProcess);
    gatewayProcess = null;
  }
  if (gatewayProcess && gatewayProcess.exitCode === null) {
    return silent ? null : getStatus();
  }

  const paths = getPaths();
  let config = ensureDesktopConfig();
  let gatewayPort = Number(config.gatewayPort || DEFAULT_GATEWAY_PORT);
  if (!(await isPortAvailable(gatewayPort))) {
    gatewayPort = await findAvailablePort(gatewayPort);
  }
  config = saveConfigPatch({
    gatewayPort,
    kiroGatewayUrl: `http://127.0.0.1:${gatewayPort}`,
  });

  gatewayProcess = spawnNodeScript(paths.gatewayEntry, config, "gateway.log");
  try {
    await waitForJson(`http://127.0.0.1:${config.gatewayPort}/health`, 12_000);
  } catch {
    // The relay UI surfaces credential or gateway startup errors after launch.
  }
  updateTray();
  return silent ? null : getStatus();
}

async function startRelayService({ restart = false, silent = false } = {}) {
  if (restart) {
    await terminateProcess(relayProcess);
    relayProcess = null;
  }
  if (relayProcess && relayProcess.exitCode === null) {
    return silent ? null : getStatus();
  }

  const paths = getPaths();
  let config = ensureDesktopConfig();
  let relayPort = Number(config.port || DEFAULT_RELAY_PORT);
  if (!(await isPortAvailable(relayPort))) {
    relayPort = await findAvailablePort(relayPort);
  }
  config = saveConfigPatch({ port: relayPort });

  relayProcess = spawnNodeScript(paths.serverEntry, config, "relay.log");
  await waitForJson(`http://127.0.0.1:${config.port}/api/status`, SERVICE_TIMEOUT_MS).catch(() => null);
  updateTray();
  return silent ? null : getStatus();
}

async function startServices({ restart = false } = {}) {
  if (restart) {
    await stopServices();
  }
  const relayWasRunning = Boolean(relayProcess && relayProcess.exitCode === null);
  const gatewayWasRunning = Boolean(gatewayProcess && gatewayProcess.exitCode === null);
  if (relayProcess && relayProcess.exitCode === null && gatewayProcess && gatewayProcess.exitCode === null) {
    return getStatus();
  }

  await startGatewayService({ silent: true });
  await startRelayService({ restart: relayWasRunning && !gatewayWasRunning, silent: true });
  updateTray();
  return getStatus();
}

function sanitizeStatus(status) {
  if (!status) return null;
  return {
    gatewayOk: Boolean(status.gatewayOk),
    gatewayMode: status.gatewayMode || null,
    gatewayVersion: status.gatewayVersion || null,
    credentialMode: status.credentialMode || null,
    credentialSource: status.credentialSource || null,
    credentialBridge: status.credentialBridge || null,
    credentialFile: status.credentialFile || null,
    ideCredsFile: status.ideCredsFile || null,
    credentialDiscovery: status.credentialDiscovery || null,
    modelCount: status.modelCount || 0,
    modelSource: status.modelSource || "unknown",
    creds: status.creds || null,
    keyCount: status.keyCount || 0,
    relayUrl: status.relayUrl || null,
    gatewayUrl: status.gatewayUrl || null,
    hasGatewayKey: Boolean(status.hasGatewayKey),
  };
}

async function getStatus() {
  const config = ensureDesktopConfig();
  const relayRunning = Boolean(relayProcess && relayProcess.exitCode === null);
  const gatewayRunning = Boolean(gatewayProcess && gatewayProcess.exitCode === null);
  let relayStatus = null;
  let relayError = null;
  let gatewayHealth = null;
  let gatewayError = null;

  try {
    relayStatus = sanitizeStatus(await fetchJson(`http://127.0.0.1:${config.port}/api/status`, { timeout: 2500 }));
  } catch (error) {
    relayError = error.message;
  }

  try {
    gatewayHealth = await fetchJson(`http://127.0.0.1:${config.gatewayPort}/health`, { timeout: 2500 });
  } catch (error) {
    gatewayError = error.message;
  }

  return {
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    relayRunning,
    gatewayRunning,
    relayError,
    gatewayError,
    relayStatus,
    gatewayHealth: gatewayHealth
      ? {
          status: gatewayHealth.status,
          mode: gatewayHealth.mode,
          version: gatewayHealth.version,
          credentialSource: gatewayHealth.credentialSource,
          profileArn: gatewayHealth.profileArn,
          models: gatewayHealth.models,
        }
      : null,
    config: {
      port: config.port,
      gatewayPort: config.gatewayPort,
      kiroGatewayUrl: config.kiroGatewayUrl,
      credentialMode: config.credentialMode,
      kiroCredsFile: config.kiroCredsFile,
      kiroAccountsFile: config.kiroAccountsFile,
      kiroApiRegion: config.kiroApiRegion,
    },
    claude: inspectClaudeConfig(config),
    modelConfig: summarizeModelConfig(ensureModelConfig()),
    credentialGuard: lastCredentialRefreshResult
      ? {
          ok: lastCredentialRefreshResult.ok,
          running: Boolean(credentialRefreshPromise),
          reason: lastCredentialRefreshResult.reason,
          mode: lastCredentialRefreshResult.mode,
          message: lastCredentialRefreshResult.message,
          checkedAt: lastCredentialRefreshResult.checkedAt,
          refreshedAt: lastCredentialRefreshResult.refreshedAt,
          requiresLogin: Boolean(lastCredentialRefreshResult.requiresLogin),
          before: lastCredentialRefreshResult.before,
          after: lastCredentialRefreshResult.after,
          helpers: lastCredentialRefreshResult.helpers,
          modelRefresh: lastCredentialRefreshResult.modelRefresh,
        }
      : {
          ok: null,
          running: Boolean(credentialRefreshPromise),
          reason: "startup",
          mode: "background",
          message: "后台守护已启用，到期前自动刷新",
          checkedAt: null,
          refreshedAt: null,
          requiresLogin: false,
          before: null,
          after: null,
          helpers: [],
          modelRefresh: null,
        },
    paths: {
      userData: getPaths().userData,
      logsDir: getPaths().logsDir,
      configFile: getPaths().configFile,
      modelConfigFile: getPaths().modelConfigFile,
    },
  };
}

function parseCredentialExpiresAt(value) {
  if (!value) return null;
  const normalized = String(value).replace(/\//g, "-").replace(" ", "T").replace("Z", "+00:00");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function credentialSummaryFromStatus(status) {
  const creds = status?.relayStatus?.creds || null;
  const expiresAt = creds?.expiresAt || null;
  const expiresAtDate = parseCredentialExpiresAt(expiresAt);
  return {
    email: creds?.email || null,
    expiresAt,
    expiresInSeconds: expiresAtDate ? Math.round((expiresAtDate.getTime() - Date.now()) / 1000) : null,
    apiOk: creds?.apiOk ?? null,
    apiReason: creds?.apiReason || null,
    expired: Boolean(creds?.expired),
    fileExpired: Boolean(creds?.fileExpired),
    credentialSource: status?.relayStatus?.credentialSource || null,
    credentialBridge: status?.relayStatus?.credentialBridge || null,
    credentialFile: status?.relayStatus?.credentialFile || null,
    ideCredsFile: status?.relayStatus?.ideCredsFile || null,
  };
}

function credentialIsUsable(status) {
  const creds = status?.relayStatus?.creds;
  return Boolean(creds?.apiOk && !creds?.expired && !creds?.fileExpired);
}

function credentialNeedsRefresh(status, { force = false } = {}) {
  if (force) return true;
  const creds = status?.relayStatus?.creds;
  if (!status?.relayRunning || !status?.gatewayRunning) return true;
  if (!creds) return true;
  if (creds.apiOk === false || creds.expired || creds.fileExpired) return true;

  const expiresAt = parseCredentialExpiresAt(creds.expiresAt);
  if (!expiresAt) return false;
  return expiresAt.getTime() - Date.now() <= CREDENTIAL_EXPIRY_WINDOW_MS;
}

function stampForFile() {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function backupFile(file, reason) {
  if (!file) return null;
  const source = expandHome(file);
  if (!source || !fs.existsSync(source)) return null;
  const bakDir = path.join(getPaths().userData, "bak");
  fs.mkdirSync(bakDir, { recursive: true });
  const target = path.join(bakDir, `${stampForFile()}.${path.basename(source)}.${reason}.bak`);
  fs.copyFileSync(source, target);
  return target;
}

function backupCredentialFiles(status, config, reason = "credential-refresh") {
  const files = new Set([
    status?.relayStatus?.credentialFile,
    status?.relayStatus?.ideCredsFile,
    config?.kiroCredsFile,
    path.join(os.homedir(), ".aws", "sso", "cache", "kiro-auth-token.json"),
    path.join(os.homedir(), ".aws", "sso", "cache", "kiro-auth-token-cli.json"),
  ].filter(Boolean).map(expandHome));

  return [...files]
    .map((file) => {
      const backup = backupFile(file, reason);
      return backup ? { source: file, backup } : null;
    })
    .filter(Boolean);
}

function isProcessRunning(pattern) {
  if (!pattern) return false;
  const result = childProcess.spawnSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" });
  return result.status === 0;
}

function launchHiddenMacApp(helper) {
  const alreadyRunning = isProcessRunning(helper.processPattern);
  if (alreadyRunning && helper.background !== false) {
    return { id: helper.id, name: helper.name, available: true, alreadyRunning: true, launched: false, error: null };
  }
  if (process.platform !== "darwin") {
    return { id: helper.id, name: helper.name, available: false, alreadyRunning: false, launched: false, error: "仅支持 macOS App 刷新" };
  }
  if (!fs.existsSync(helper.appPath)) {
    return { id: helper.id, name: helper.name, available: false, alreadyRunning: false, launched: false, error: `未找到 ${helper.appPath}` };
  }

  const args = helper.background === false ? [helper.appPath] : ["-gj", helper.appPath];
  const result = childProcess.spawnSync("/usr/bin/open", args, {
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    id: helper.id,
    name: helper.name,
    available: true,
    alreadyRunning,
    launched: result.status === 0,
    error: result.status === 0 ? null : (result.stderr || result.stdout || `open exited ${result.status}`),
  };
}

function quitMacApp(helper) {
  if (process.platform !== "darwin") return { id: helper.id, name: helper.name, quit: false, error: "unsupported" };
  const result = childProcess.spawnSync("/usr/bin/osascript", ["-e", `tell application "${helper.name}" to quit`], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    id: helper.id,
    name: helper.name,
    quit: result.status === 0,
    error: result.status === 0 ? null : (result.stderr || result.stdout || `osascript exited ${result.status}`),
  };
}

function helperById(id) {
  return KIRO_HELPER_APPS.find((helper) => helper.id === id) || null;
}

async function waitForCredentialUsable(timeoutMs) {
  const startedAt = Date.now();
  let lastStatus = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastStatus = await getStatus().catch(() => null);
    if (credentialIsUsable(lastStatus)) return lastStatus;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return lastStatus || await getStatus().catch(() => null);
}

async function refreshKiroCredentialsImpl({ force = false, reason = "manual", mode = "manual" } = {}) {
  let config = ensureDesktopConfig();
  await startServices();
  config = ensureDesktopConfig();
  const checkedAt = new Date().toISOString();
  const before = await getStatus();

  if (!credentialNeedsRefresh(before, { force })) {
    const summary = credentialSummaryFromStatus(before);
    const result = {
      ok: true,
      skipped: true,
      reason,
      mode,
      message: "Kiro 凭据当前可用，未触发外部刷新",
      checkedAt,
      refreshedAt: null,
      requiresLogin: false,
      before: summary,
      after: summary,
      backups: [],
      helpers: [],
      cleanup: [],
      modelRefresh: null,
    };
    lastCredentialRefreshResult = result;
    return result;
  }

  const backups = backupCredentialFiles(before, config, "before-credential-refresh");
  const helpers = [];

  let after = await waitForCredentialUsable(Math.floor(CREDENTIAL_REFRESH_TIMEOUT_MS / 3));

  if (!credentialIsUsable(after)) {
    const kiro = helperById("kiro");
    if (kiro) helpers.push(launchHiddenMacApp(kiro));
    after = await waitForCredentialUsable(Math.ceil(CREDENTIAL_REFRESH_TIMEOUT_MS * 2 / 3));
  }

  const ok = credentialIsUsable(after);
  let modelRefresh = null;
  if (ok) {
    try {
      config = ensureDesktopConfig();
      const modelInfo = await fetchRelayModels(config, { refresh: true });
      modelRefresh = {
        ok: true,
        count: modelInfo.models.length,
        source: modelInfo.meta?.source || null,
        updatedAt: modelInfo.meta?.updatedAt || null,
      };
    } catch (error) {
      modelRefresh = { ok: false, error: error.message };
      await startGatewayService({ restart: true, silent: true }).catch(() => null);
    }
  }

  const cleanup = [];
  if (ok) {
    for (const helperResult of helpers) {
      if (!helperResult.launched || helperResult.alreadyRunning) continue;
      const helper = helperById(helperResult.id);
      if (helper) cleanup.push(quitMacApp(helper));
    }
  }

  const result = {
    ok,
    skipped: false,
    reason,
    mode,
    message: ok
      ? "Kiro 凭据已刷新并通过上游验证"
      : "Kiro 凭据仍不可用，已尝试打开 Kiro IDE；请在 Kiro IDE 中完成登录或重新登录后再点同步全部",
    checkedAt,
    refreshedAt: ok ? new Date().toISOString() : null,
    requiresLogin: !ok,
    before: credentialSummaryFromStatus(before),
    after: credentialSummaryFromStatus(after),
    backups,
    helpers,
    cleanup,
    modelRefresh,
  };

  lastCredentialRefreshResult = result;
  const status = await getStatus().catch(() => null);
  if (status) sendStatusToRenderer(status);
  return result;
}

function refreshKiroCredentials(options = {}) {
  if (credentialRefreshPromise) return credentialRefreshPromise;
  credentialRefreshPromise = refreshKiroCredentialsImpl(options).finally(() => {
    credentialRefreshPromise = null;
  });
  return credentialRefreshPromise;
}

async function runCredentialGuardOnce(reason = "background") {
  try {
    await startServices();
    const status = await getStatus();
    if (!credentialNeedsRefresh(status)) {
      const summary = credentialSummaryFromStatus(status);
      lastCredentialRefreshResult = {
        ok: true,
        skipped: true,
        reason,
        mode: "background",
        message: "后台守护检查通过，凭据未到刷新窗口",
        checkedAt: new Date().toISOString(),
        refreshedAt: null,
        requiresLogin: false,
        before: summary,
        after: summary,
        backups: [],
        helpers: [],
        cleanup: [],
        modelRefresh: null,
      };
      sendStatusToRenderer(await getStatus());
      return lastCredentialRefreshResult;
    }
    return await refreshKiroCredentials({ reason, mode: "background" });
  } catch (error) {
    lastCredentialRefreshResult = {
      ok: false,
      skipped: false,
      reason,
      mode: "background",
      message: `后台守护检查失败: ${error.message || error}`,
      checkedAt: new Date().toISOString(),
      refreshedAt: null,
      requiresLogin: false,
      before: null,
      after: null,
      backups: [],
      helpers: [],
      cleanup: [],
      modelRefresh: null,
    };
    const status = await getStatus().catch(() => null);
    if (status) sendStatusToRenderer(status);
    return lastCredentialRefreshResult;
  }
}

function startCredentialGuard() {
  if (credentialGuardTimer) clearInterval(credentialGuardTimer);
  credentialGuardTimer = setInterval(() => {
    if (!forceQuit) runCredentialGuardOnce("interval").catch(() => null);
  }, CREDENTIAL_GUARD_INTERVAL_MS);
  setTimeout(() => {
    if (!forceQuit) runCredentialGuardOnce("startup").catch(() => null);
  }, 5000);
}

function stopCredentialGuard() {
  if (credentialGuardTimer) clearInterval(credentialGuardTimer);
  credentialGuardTimer = null;
}

async function requestJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || body.error?.message || body.error || `HTTP ${response.status}`);
  }
  return body;
}

async function ensureShellKey(config, targetApp, name) {
  await startServices();
  const base = `http://127.0.0.1:${config.port}`;
  const list = await fetchJson(`${base}/api/keys`, { timeout: 5000 }).catch(() => ({ keys: [] }));
  const existing = list.keys.find((item) => item.enabled && item.targetApp === targetApp);
  if (existing) {
    const detail = await fetchJson(`${base}/api/keys/${existing.id}`, { timeout: 5000 });
    if (detail.key) return detail.key;
  }
  const created = await requestJson(`${base}/api/keys`, {
    name,
    targetApp,
  });
  return created.key.key;
}

function ensureClaudeShellKey(config) {
  return ensureShellKey(config, "claude", "Kiro Desktop Claude");
}

function claudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function claudeBackupDir() {
  return path.join(os.homedir(), ".claude", "backups");
}

function backupClaudeSettings(reason = "install") {
  const source = claudeSettingsPath();
  fs.mkdirSync(claudeBackupDir(), { recursive: true });
  if (!fs.existsSync(source)) return null;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backup = path.join(claudeBackupDir(), `${stamp}.settings.${reason}.kiro-desktop.bak`);
  fs.copyFileSync(source, backup);
  const paths = getPaths();
  const index = readJson(paths.claudeBackupIndexFile, { backups: [] }) || { backups: [] };
  index.backups.unshift({ path: backup, reason, createdAt: new Date().toISOString() });
  writeJson(paths.claudeBackupIndexFile, { backups: index.backups.slice(0, 20) });
  return backup;
}

function inspectClaudeConfig(config = ensureDesktopConfig()) {
  const file = claudeSettingsPath();
  const settings = readJson(file, {});
  const env = settings?.env || {};
  const expectedBaseUrl = `http://127.0.0.1:${config.port}`;
  const baseUrl = String(env.ANTHROPIC_BASE_URL || "").replace(/\/$/, "");
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
  const hasAuthToken = Boolean(env.ANTHROPIC_AUTH_TOKEN);
  const hasApiKey = Boolean(env.ANTHROPIC_API_KEY);
  const modelPin = settings?.model || null;
  const envModel = env.ANTHROPIC_MODEL || null;
  const modelLocked = Boolean(modelPin || envModel);
  return {
    settingsFile: file,
    exists: fs.existsSync(file),
    managed: baseUrl === expectedBaseUrl && String(token).startsWith("sk-kiro-"),
    baseUrl: baseUrl || null,
    expectedBaseUrl,
    hasToken: Boolean(token),
    hasAuthToken,
    hasApiKey,
    authConflict: hasAuthToken && hasApiKey,
    model: modelPin || envModel || null,
    modelPin,
    envModel,
    modelLocked,
  };
}

async function installClaudeConfig() {
  let config = ensureDesktopConfig();
  await startServices();
  config = ensureDesktopConfig();
  const shellKey = await ensureClaudeShellKey(config);
  const file = claudeSettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = backupClaudeSettings("before-install");
  const current = readJson(file, {}) || {};
  const currentEnv = { ...(current.env || {}) };
  delete currentEnv.ANTHROPIC_API_KEY;
  delete currentEnv.ANTHROPIC_MODEL;
  const env = {
    ...currentEnv,
    ...buildClaudeEnvFromModelConfig(ensureModelConfig(), {
      shellKey,
      baseUrl: `http://127.0.0.1:${config.port}`,
    }),
  };

  const next = {
    ...current,
    $schema: current.$schema || "https://json.schemastore.org/claude-code-settings.json",
    env,
    language: current.language || "Simplified Chinese",
    effortLevel: ensureModelConfig().quality?.noDowngrade
      ? ensureModelConfig().quality.reasoningEffort || "medium"
      : current.effortLevel || "low",
  };
  delete next.model;
  writeJson(file, next);
  return {
    ok: true,
    backup,
    claude: inspectClaudeConfig(config),
  };
}

function clearClaudeModelPin() {
  const file = claudeSettingsPath();
  if (!fs.existsSync(file)) {
    return {
      ok: true,
      changed: false,
      backup: null,
      removed: { modelPin: false, envModel: false },
      claude: inspectClaudeConfig(),
    };
  }

  const current = readJson(file, {}) || {};
  const currentEnv = { ...(current.env || {}) };
  const removed = {
    modelPin: Object.prototype.hasOwnProperty.call(current, "model"),
    envModel: Object.prototype.hasOwnProperty.call(currentEnv, "ANTHROPIC_MODEL"),
  };

  if (!removed.modelPin && !removed.envModel) {
    return {
      ok: true,
      changed: false,
      backup: null,
      removed,
      claude: inspectClaudeConfig(),
    };
  }

  const backup = backupClaudeSettings("before-clear-model-pin");
  const next = { ...current };
  delete next.model;
  delete currentEnv.ANTHROPIC_MODEL;
  if (Object.keys(currentEnv).length) {
    next.env = currentEnv;
  } else {
    delete next.env;
  }
  writeJson(file, next);
  return {
    ok: true,
    changed: true,
    backup,
    removed,
    claude: inspectClaudeConfig(),
  };
}

async function repairClaudeModelSwitching() {
  const clearResult = clearClaudeModelPin();
  const repairedModelConfig = saveModelConfig(repairClaudeRoleMapping(ensureModelConfig()));
  const installResult = await installClaudeConfig();

  return {
    ok: true,
    clear: clearResult,
    modelConfig: repairedModelConfig,
    roleMapping: repairedModelConfig.claude,
    install: installResult,
    claude: inspectClaudeConfig(),
  };
}

function restoreClaudeConfig() {
  const paths = getPaths();
  const index = readJson(paths.claudeBackupIndexFile, { backups: [] }) || { backups: [] };
  const latest = index.backups.find((entry) => entry?.path && fs.existsSync(entry.path));
  if (!latest) {
    throw new Error("没有找到由 Kiro Desktop 创建的 Claude 配置备份");
  }
  fs.mkdirSync(path.dirname(claudeSettingsPath()), { recursive: true });
  fs.copyFileSync(latest.path, claudeSettingsPath());
  return { ok: true, restoredFrom: latest.path, claude: inspectClaudeConfig() };
}

function disableClaudeConfig() {
  const file = claudeSettingsPath();
  if (!fs.existsSync(file)) {
    return { ok: true, backup: null, claude: inspectClaudeConfig() };
  }

  const backup = backupClaudeSettings("before-disable");
  const current = readJson(file, {}) || {};
  const env = { ...(current.env || {}) };
  for (const key of CLAUDE_MANAGED_ENV_KEYS) {
    delete env[key];
  }
  const next = { ...current, env };
  if (!Object.keys(env).length) delete next.env;
  writeJson(file, next);
  return { ok: true, backup, claude: inspectClaudeConfig() };
}

async function applyTargetRouting(targets = {}) {
  const current = ensureModelConfig();
  const modelConfig = saveModelConfig({
    ...current,
    targets,
  });
  const results = {};

  if (modelConfig.targets.claudeEnabled) {
    results.claude = await installClaudeConfig();
  } else {
    results.claude = disableClaudeConfig();
  }

  return {
    ok: true,
    modelConfig,
    results,
    status: await getStatus(),
  };
}

function findClaudeBinary() {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const result = childProcess.spawnSync("/bin/zsh", ["-lc", "command -v claude"], {
    encoding: "utf8",
  });
  return result.stdout.trim() || null;
}

function runCommand(command, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd: os.homedir(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`命令超时: ${command}`));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr, code });
      reject(new Error(stderr || stdout || `命令退出码 ${code}`));
    });
  });
}

async function testClaude() {
  await installClaudeConfig();
  const binary = findClaudeBinary();
  if (!binary) throw new Error("未找到 claude CLI，请先安装 Claude Code");

  const prompt = "请只输出 OK_DESKTOP_RELAY，不要解释。";
  const result = await runCommand(binary, [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    "sonnet",
    "--max-budget-usd",
    "0.05",
    "--no-session-persistence",
  ]);

  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // Claude may return plain text if a future version changes output behavior.
  }
  const text = parsed?.result || parsed?.output || result.stdout;
  return {
    ok: /OK_DESKTOP_RELAY/i.test(text),
    command: `${binary} -p ... --output-format json --model sonnet`,
    stdout: result.stdout.slice(0, 4000),
    stderr: result.stderr.slice(0, 4000),
  };
}

async function findExistingShellKey(config, targetApp) {
  await startServices();
  const base = `http://127.0.0.1:${config.port}`;
  const list = await fetchJson(`${base}/api/keys`, { timeout: 5000 }).catch(() => ({ keys: [] }));
  const existing = list.keys.find((item) => item.enabled && item.targetApp === targetApp);
  if (!existing) {
    return {
      key: null,
      meta: null,
      error: `未找到已启用的 ${targetApp} 壳子 Key`,
    };
  }
  const detail = await fetchJson(`${base}/api/keys/${existing.id}`, { timeout: 5000 });
  return {
    key: detail.key,
    meta: {
      id: detail.id,
      name: detail.name,
      targetApp: detail.targetApp,
      enabled: detail.enabled,
      createdAt: detail.createdAt,
      lastUsedAt: detail.lastUsedAt,
    },
    error: null,
  };
}

async function probeRelayWithShellKey(config, { targetApp, model }) {
  const found = await findExistingShellKey(config, targetApp);
  if (!found.key) {
    return {
      ok: false,
      skipped: true,
      key: found.meta,
      status: null,
      message: found.error,
      conclusion: "缺少本地壳子 Key",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": found.key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(async () => ({ raw: await response.text().catch(() => "") }));
    const message = body?.error?.message || body?.message || body?.raw || (response.ok ? "OK" : `HTTP ${response.status}`);
    let conclusion = response.ok ? "本地 Relay 和上游请求可用" : "请求失败";
    if (!response.ok && /token 已失效|http_403|http_401|authentication/i.test(String(message))) {
      conclusion = "Kiro 上游凭据失效";
    } else if (!response.ok && response.status === 401) {
      conclusion = "本地壳子 Key 或上游鉴权失败";
    } else if (!response.ok && response.status >= 500) {
      conclusion = "Relay 或 Gateway 服务异常";
    }

    return {
      ok: response.ok,
      skipped: false,
      key: found.meta,
      status: response.status,
      message,
      conclusion,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runDesktopDiagnostics() {
  let config = ensureDesktopConfig();
  await startServices();
  config = ensureDesktopConfig();
  const modelConfig = ensureModelConfig();
  const status = await getStatus();
  const claudeConfig = inspectClaudeConfig(config);

  const claudeProbe = await probeRelayWithShellKey(config, {
    targetApp: "claude",
    model: modelConfig.claude.defaultModel,
  }).catch((error) => ({
    ok: false,
    skipped: false,
    key: null,
    status: null,
    message: error.message,
    conclusion: "Claude Relay 探测失败",
  }));

  return {
    ok: Boolean(status.relayRunning && status.gatewayHealth && !status.relayError && !status.gatewayError),
    generatedAt: new Date().toISOString(),
    note: "只检查配置并通过本地 Relay 进行 HTTP 级探测。",
    runtime: {
      relayRunning: status.relayRunning,
      gatewayRunning: status.gatewayRunning,
      relayUrl: `http://127.0.0.1:${config.port}/v1`,
      gatewayUrl: config.kiroGatewayUrl,
      credentialFile: status.relayStatus?.credentialFile || null,
      ideCredsFile: status.relayStatus?.ideCredsFile || null,
      credentialSource: status.relayStatus?.credentialSource || null,
      credentialBridge: status.relayStatus?.credentialBridge || null,
      credential: {
        email: status.relayStatus?.creds?.email || null,
        expired: Boolean(status.relayStatus?.creds?.expired),
        apiOk: status.relayStatus?.creds?.apiOk ?? null,
        apiReason: status.relayStatus?.creds?.apiReason || null,
        fileExpired: status.relayStatus?.creds?.fileExpired ?? null,
      },
    },
    claude: {
      enabled: modelConfig.targets.claudeEnabled,
      managed: claudeConfig.managed,
      baseUrl: claudeConfig.baseUrl,
      expectedBaseUrl: claudeConfig.expectedBaseUrl,
      model: claudeConfig.model,
      modelPin: claudeConfig.modelPin,
      envModel: claudeConfig.envModel,
      modelLocked: claudeConfig.modelLocked,
      authConflict: claudeConfig.authConflict,
      hasAuthToken: claudeConfig.hasAuthToken,
      hasApiKey: claudeConfig.hasApiKey,
      probe: claudeProbe,
      conclusion: claudeConfig.authConflict
        ? "Claude 同时存在 AUTH_TOKEN 和 API_KEY，需要重新写入 Claude"
        : claudeConfig.modelLocked
          ? "Claude 存在模型固定项，/model 切换可能被覆盖"
        : claudeProbe.conclusion,
    },
  };
}

async function chooseAccountsFile() {
  return { ok: false, message: "外部账号池已停用；当前版本只使用本地 Kiro IDE 凭据。", status: await updateCredentialMode("local") };
}

async function updateCredentialMode(mode) {
  saveConfigPatch({ credentialMode: "local", kiroAccountsFile: null });
  return startServices({ restart: true });
}

function readRecentLogs() {
  const paths = getPaths();
  const files = ["relay.log", "gateway.log"].map((name) => path.join(paths.logsDir, name));
  return files
    .map((file) => {
      if (!fs.existsSync(file)) return `# ${path.basename(file)}\n(暂无日志)`;
      const text = fs.readFileSync(file, "utf8");
      return `# ${path.basename(file)}\n${text.slice(-8000)}`;
    })
    .join("\n\n");
}

function createTrayImage() {
  const trayPath = path.join(__dirname, "assets", "trayTemplate.png");
  const image = nativeImage.createFromPath(trayPath);
  image.setTemplateImage(true);
  return image;
}

function updateTray() {
  if (!tray) return;
  const relayRunning = Boolean(relayProcess && relayProcess.exitCode === null);
  const gatewayRunning = Boolean(gatewayProcess && gatewayProcess.exitCode === null);
  const running = relayRunning || gatewayRunning;
  tray.setToolTip(
    running
      ? `Kiro Desktop Relay: Relay ${relayRunning ? "运行中" : "已停止"} / Gateway ${gatewayRunning ? "运行中" : "已停止"}`
      : "Kiro Desktop Relay 已停止"
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开控制台", click: () => showMainWindow() },
      { type: "separator" },
      { label: "启动全部服务", enabled: !relayRunning || !gatewayRunning, click: () => startServices().then(sendStatusToRenderer).catch(showError) },
      { label: "重启服务", click: () => startServices({ restart: true }).then(sendStatusToRenderer).catch(showError) },
      { label: "刷新 Kiro 凭据", click: () => refreshKiroCredentials({ force: true, reason: "tray", mode: "manual" }).then(() => getStatus()).then(sendStatusToRenderer).catch(showError) },
      { label: "停止服务", enabled: running, click: () => stopServices().then(sendStatusToRenderer).catch(showError) },
      { type: "separator" },
      {
        label: "退出",
        click: async () => {
          forceQuit = true;
          await stopServices();
          app.quit();
        },
      },
    ])
  );
}

function sendStatusToRenderer(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("status:update", status);
  }
}

function showError(error) {
  dialog.showErrorBox("Kiro Desktop Relay", error?.message || String(error));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 840,
    minWidth: 1040,
    minHeight: 640,
    title: "Kiro Desktop Relay",
    backgroundColor: "#0B0D0E",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(getPaths().rendererEntry);
  mainWindow.on("close", (event) => {
    if (process.platform === "darwin" && !forceQuit) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showMainWindow() {
  if (!mainWindow) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
}

function registerIpc() {
  ipcMain.handle("status:get", () => getStatus());
  ipcMain.handle("logs:get", () => readRecentLogs());
  ipcMain.handle("services:start", () => startServices());
  ipcMain.handle("services:restart", () => startServices({ restart: true }));
  ipcMain.handle("services:stop", () => stopServices());
  ipcMain.handle("services:relay:start", () => startRelayService());
  ipcMain.handle("services:relay:restart", () => startRelayService({ restart: true }));
  ipcMain.handle("services:relay:stop", () => stopRelayService());
  ipcMain.handle("services:gateway:start", () => startGatewayService());
  ipcMain.handle("services:gateway:restart", () => startGatewayService({ restart: true }));
  ipcMain.handle("services:gateway:stop", () => stopGatewayService());
  ipcMain.handle("targets:apply", (_event, targets) => applyTargetRouting(targets));
  ipcMain.handle("models:get", () => getModelConfigPayload());
  ipcMain.handle("models:refresh", () => refreshModelConfig({ refresh: true }));
  ipcMain.handle("models:save", (_event, modelConfig) => ({ ok: true, modelConfig: saveModelConfig(modelConfig), path: getPaths().modelConfigFile }));
  ipcMain.handle("claude:install", () => installClaudeConfig());
  ipcMain.handle("claude:disable", () => disableClaudeConfig());
  ipcMain.handle("claude:restore", () => restoreClaudeConfig());
  ipcMain.handle("claude:clearModelPin", () => clearClaudeModelPin());
  ipcMain.handle("claude:repairModelSwitching", () => repairClaudeModelSwitching());
  ipcMain.handle("claude:test", () => testClaude());
  ipcMain.handle("diagnostics:run", () => runDesktopDiagnostics());
  ipcMain.handle("accounts:choose", () => chooseAccountsFile());
  ipcMain.handle("credentials:setMode", (_event, mode) => updateCredentialMode(mode));
  ipcMain.handle("credentials:refresh", () => refreshKiroCredentials({ force: true, reason: "manual", mode: "manual" }));
  ipcMain.handle("shell:openPath", (_event, targetPath) => shell.openPath(targetPath));
  ipcMain.handle("shell:openExternal", (_event, url) => shell.openExternal(url));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  app.whenReady().then(async () => {
    app.setName("Kiro Desktop Relay");
    ensureDesktopConfig();
    registerIpc();
    tray = new Tray(createTrayImage());
    updateTray();
    createMainWindow();
    try {
      const status = await startServices();
      sendStatusToRenderer(status);
      startCredentialGuard();
    } catch (error) {
      showError(error);
    }
  });
}

app.on("activate", () => showMainWindow());

app.on("before-quit", () => {
  forceQuit = true;
  stopCredentialGuard();
});

app.on("will-quit", async (event) => {
  if (relayProcess || gatewayProcess) {
    event.preventDefault();
    await stopServices();
    app.exit(0);
  }
});
