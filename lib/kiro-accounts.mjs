import fs from "node:fs";
import path from "node:path";
import os from "node:os";
function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function isCredsExpired(creds) {
  if (!creds?.accessToken && !creds?.access_token) return true;
  const expiresAt = creds.expiresAt || creds.expires_at;
  if (!expiresAt) return false;
  const date = new Date(String(expiresAt).replace("Z", "+00:00"));
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
}

function isAutoCredentialPath(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "auto" || normalized === "detect" || normalized === "__auto__";
}

function toIsoExpiresAt(value) {
  if (!value) return null;
  if (typeof value === "number") {
    return new Date(value * 1000).toISOString();
  }
  const d = new Date(String(value).replace("Z", "+00:00"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function loadAccountsPool(filePath) {
  const file = expandHome(filePath);
  if (!fs.existsSync(file)) {
    throw new Error(`账号池文件不存在: ${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const accounts = Array.isArray(raw) ? raw : raw.accounts || [raw];
  return { file, accounts, mtime: fs.statSync(file).mtimeMs };
}

export function selectActiveAccount(accounts) {
  const candidates = accounts.filter((a) => {
    const status = String(a.status || "normal").toLowerCase();
    return status === "normal" || status === "active";
  });
  const list = candidates.length ? candidates : accounts;
  return list.sort((a, b) => (b.last_used || 0) - (a.last_used || 0))[0] || null;
}

export function accountToKiroCreds(account) {
  const raw = account.kiro_auth_token_raw || {};
  const expiresIso = toIsoExpiresAt(account.expires_at || raw.expiresAt || raw.expires_at);

  return {
    ...raw,
    accessToken: account.access_token || raw.accessToken || raw.access_token,
    refreshToken: account.refresh_token || raw.refreshToken || raw.refresh_token,
    clientId: account.client_id || raw.clientId || raw.client_id,
    clientSecret: raw.clientSecret || raw.client_secret,
    profileArn:
      raw.profileArn
      || raw.profile_arn
      || raw.arn
      || account.kiro_profile_raw?.profileArn
      || account.kiro_profile_raw?.arn
      || null,
    email: account.email || raw.email || raw.loginHint || raw.login_hint,
    authMethod: raw.authMethod || "IdC",
    loginProvider: raw.loginProvider || account.login_provider || "Enterprise",
    idcRegion: account.idc_region || raw.idcRegion || raw.idc_region || raw.region || "us-east-1",
    region: account.idc_region || raw.region || "us-east-1",
    expiresAt: expiresIso,
    usageData: account.kiro_usage_raw || raw.usageData || null,
  };
}

export function materializeAccountCreds(account, targetPath) {
  const creds = accountToKiroCreds(account);
  const file = expandHome(targetPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(creds, null, 2));
  return { file, creds, mtime: fs.statSync(file).mtimeMs };
}

export function updatePoolAccountTokens(poolPath, accountId, patch) {
  const { file, accounts } = loadAccountsPool(poolPath);
  const idx = accounts.findIndex((a) => a.id === accountId);
  if (idx < 0) throw new Error(`账号池中未找到账号: ${accountId}`);

  const account = accounts[idx];
  const raw = account.kiro_auth_token_raw || {};

  if (patch.accessToken) {
    account.access_token = patch.accessToken;
    raw.accessToken = patch.accessToken;
  }
  if (patch.refreshToken) {
    account.refresh_token = patch.refreshToken;
    raw.refreshToken = patch.refreshToken;
  }
  if (patch.expiresAt) {
    const iso = patch.expiresAt instanceof Date ? patch.expiresAt.toISOString() : String(patch.expiresAt);
    raw.expiresAt = iso;
    account.expires_at = Math.floor(new Date(iso).getTime() / 1000);
  }
  if (patch.profileArn) {
    raw.profileArn = patch.profileArn;
    raw.profile_arn = patch.profileArn;
    raw.arn = patch.profileArn;
  }

  account.kiro_auth_token_raw = raw;
  account.last_used = Math.floor(Date.now() / 1000);
  accounts[idx] = account;

  fs.writeFileSync(file, JSON.stringify(accounts, null, 2));
  return account;
}

function readJsonIfExists(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function parseExpiresAtMs(value) {
  const iso = toIsoExpiresAt(value);
  if (!iso) return null;
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? null : time;
}

function getKiroCredentialSearchFiles(configuredPath) {
  const files = [];
  const add = (file, source) => {
    if (!file) return;
    const expanded = expandHome(file);
    if (!expanded) return;
    files.push({ file: expanded, source });
  };

  if (!isAutoCredentialPath(configuredPath)) {
    add(configuredPath, "configured");
  }

  const ssoCacheDir = path.join(os.homedir(), ".aws", "sso", "cache");
  add(path.join(ssoCacheDir, "kiro-auth-token.json"), "kiro-default");
  add(path.join(ssoCacheDir, "kiro-auth-token-cli.json"), "kiro-cli");

  try {
    for (const name of fs.readdirSync(ssoCacheDir)) {
      if (!name.endsWith(".json")) continue;
      add(path.join(ssoCacheDir, name), "aws-sso-cache");
    }
  } catch {
    // Kiro/AWS SSO cache may not exist on a fresh machine.
  }

  const seen = new Set();
  return files.filter((item) => {
    if (seen.has(item.file)) return false;
    seen.add(item.file);
    return true;
  });
}

function summarizeCredentialCandidate(file, source) {
  const stat = safeStat(file);
  if (!stat || !stat.isFile()) {
    return {
      file,
      source,
      exists: false,
      valid: false,
      expired: null,
      score: -1000,
    };
  }

  const raw = readJsonIfExists(file);
  const accessToken = raw?.accessToken || raw?.access_token || null;
  const refreshToken = raw?.refreshToken || raw?.refresh_token || null;
  const expiresAt = toIsoExpiresAt(raw?.expiresAt || raw?.expires_at);
  const expiresAtMs = parseExpiresAtMs(expiresAt);
  const expired = expiresAtMs ? expiresAtMs < Date.now() : false;
  const basename = path.basename(file);
  const kiroLike = Boolean(
    basename.startsWith("kiro-auth-token")
      || raw?.authMethod
      || raw?.auth_method
      || raw?.clientIdHash
      || raw?.loginProvider
      || String(raw?.provider || "").toLowerCase().includes("kiro")
  );
  const valid = Boolean(accessToken && kiroLike);

  let score = 0;
  if (valid) score += 100;
  if (refreshToken) score += 25;
  if (raw?.clientIdHash) score += 10;
  if (raw?.clientId || raw?.client_id) score += 5;
  if (raw?.authMethod === "IdC" || raw?.loginProvider === "Enterprise") score += 12;
  if (String(raw?.provider || "").toLowerCase().includes("kiro")) score += 20;
  if (basename === "kiro-auth-token.json") score += 40;
  if (basename === "kiro-auth-token-cli.json") score += 25;
  if (source === "configured") score += 15;
  if (expired) score -= 120;
  if (stat.mtimeMs) score += Math.min(10, Math.max(0, (stat.mtimeMs - (Date.now() - 30 * 24 * 60 * 60 * 1000)) / (3 * 24 * 60 * 60 * 1000)));

  return {
    file,
    source,
    exists: true,
    valid,
    expired,
    expiresAt,
    mtime: stat.mtimeMs,
    score,
    hasRefreshToken: Boolean(refreshToken),
    hasClientIdHash: Boolean(raw?.clientIdHash),
    hasClientRegistration: Boolean(raw?.clientId || raw?.client_id || raw?.clientSecret || raw?.client_secret),
    authMethod: raw?.authMethod || raw?.auth_method || null,
    region: raw?.region || raw?.idcRegion || raw?.idc_region || null,
  };
}

export function discoverKiroCredentialFile(configuredPath = null) {
  const candidates = getKiroCredentialSearchFiles(configuredPath).map((item) =>
    summarizeCredentialCandidate(item.file, item.source)
  );

  const usable = candidates
    .filter((item) => item.valid)
    .sort((a, b) => b.score - a.score || (b.mtime || 0) - (a.mtime || 0));

  const best = usable.find((item) => !item.expired) || usable[0] || null;
  return {
    found: Boolean(best),
    file: best?.file || (isAutoCredentialPath(configuredPath) ? null : expandHome(configuredPath)),
    best,
    candidates,
  };
}

function loadDeviceRegistration(clientIdHash) {
  if (!clientIdHash) return null;
  const regPath = path.join(os.homedir(), ".aws", "sso", "cache", `${clientIdHash}.json`);
  return readJsonIfExists(regPath);
}

export function materializeLocalCreds(config, dataDir) {
  const discovery = discoverKiroCredentialFile(config.kiroCredsFile);
  const ideFile = discovery.file;
  const localFile = path.join(dataDir, "kiro-auth-token.local.json");
  const ide = readJsonIfExists(ideFile);
  if (!ide) {
    const searched = discovery.candidates
      .filter((item) => item.exists)
      .map((item) => item.file)
      .slice(0, 6)
      .join(", ");
    throw new Error(
      `未自动识别到可用 Kiro 凭据。请先在 Kiro IDE 登录并保持打开，或检查 ~/.aws/sso/cache/kiro-auth-token.json。已搜索: ${searched || "~/.aws/sso/cache"}`
    );
  }

  const backup = readJsonIfExists(`${ideFile}.bak`)
    || readJsonIfExists(path.join(path.dirname(ideFile), "kiro-auth-token.json.bak"));
  let poolMeta = null;
  if (config.kiroAccountsFile) {
    try {
      poolMeta = selectActiveAccount(loadAccountsPool(config.kiroAccountsFile).accounts);
    } catch {
      // Local IDE mode must not fail just because a previously selected JSON
      // account-pool file is missing on this Mac.
      poolMeta = null;
    }
  }
  const poolRaw = poolMeta?.kiro_auth_token_raw || {};
  const device = loadDeviceRegistration(ide.clientIdHash || backup?.clientIdHash || poolRaw.clientIdHash);

  let creds = {
    accessToken: ide.accessToken || ide.access_token,
    refreshToken: ide.refreshToken || ide.refresh_token,
    expiresAt: toIsoExpiresAt(ide.expiresAt || ide.expires_at),
    clientId: ide.clientId || ide.client_id || backup?.clientId || poolRaw.clientId || device?.clientId,
    clientSecret: ide.clientSecret || ide.client_secret || backup?.clientSecret || poolRaw.clientSecret || device?.clientSecret,
    clientIdHash: ide.clientIdHash || backup?.clientIdHash || poolRaw.clientIdHash,
    profileArn:
      ide.profileArn
      || ide.profile_arn
      || ide.arn
      || backup?.profileArn
      || poolRaw.profileArn
      || poolMeta?.kiro_profile_raw?.profileArn
      || null,
    email: ide.email || ide.loginHint || backup?.email || poolMeta?.email || null,
    authMethod: ide.authMethod || backup?.authMethod || "IdC",
    loginProvider: ide.loginProvider || backup?.loginProvider || "Enterprise",
    region: ide.region || ide.idcRegion || backup?.region || poolRaw.region || "us-east-1",
    idcRegion: ide.idcRegion || ide.idc_region || backup?.idcRegion || "us-east-1",
    usageData: ide.usageData || backup?.usageData || poolMeta?.kiro_usage_raw || poolRaw.usageData || null,
  };

  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  fs.writeFileSync(localFile, JSON.stringify(creds, null, 2));
  return { file: localFile, creds, mtime: fs.statSync(localFile).mtimeMs, credentialBridge: "ide", ideFile, discovery };
}

export function resolveCredentialPaths(config, dataDir) {
  const mode = config.credentialMode || "local";
  const accountsFile = config.kiroAccountsFile ? expandHome(config.kiroAccountsFile) : null;
  const activeCredsFile = path.join(dataDir, "kiro-auth-token.active.json");

  if (mode === "json") {
    if (!accountsFile || !fs.existsSync(accountsFile)) {
      throw new Error(`JSON 模式需要有效的账号池文件: ${accountsFile || "(未配置)"}`);
    }
    const { accounts } = loadAccountsPool(accountsFile);
    const account = selectActiveAccount(accounts);
    if (!account) throw new Error(`账号池为空: ${accountsFile}`);

    const creds = accountToKiroCreds(account);
    let credentialBridge = "pool";
    if (isCredsExpired(creds)) credentialBridge = "pool-expired";

    fs.mkdirSync(path.dirname(activeCredsFile), { recursive: true });
    fs.writeFileSync(activeCredsFile, JSON.stringify(creds, null, 2));
    return {
      mode: "json",
      source: "pool",
      accountsFile,
      credsFile: activeCredsFile,
      account,
      passiveSync: false,
      credentialBridge,
    };
  }

  const local = materializeLocalCreds(config, dataDir);
  return {
    mode: "local",
    source: "local",
    accountsFile,
    credsFile: local.file,
    ideCredsFile: local.ideFile || null,
    account: null,
    passiveSync: true,
    credentialBridge: local.credentialBridge,
    credentialDiscovery: local.discovery,
  };
}

export function readAccountsSummary(config, dataDir) {
  const accountsFile = config.kiroAccountsFile ? expandHome(config.kiroAccountsFile) : null;
  if (!accountsFile || !fs.existsSync(accountsFile)) {
    return { enabled: false };
  }

  try {
    const { accounts, file, mtime } = loadAccountsPool(accountsFile);
    const active = selectActiveAccount(accounts);
    const expiresAt = active ? toIsoExpiresAt(active.expires_at || active.kiro_auth_token_raw?.expiresAt) : null;

    return {
      enabled: true,
      file,
      mtime,
      total: accounts.length,
      active: active
        ? {
            id: active.id,
            email: active.email,
            status: active.status,
            plan: active.plan_name,
            creditsUsed: active.credits_used,
            creditsTotal: active.credits_total,
            expiresAt,
          }
        : null,
    };
  } catch (e) {
    return { enabled: true, error: e.message };
  }
}
