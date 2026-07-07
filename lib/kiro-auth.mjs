import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { updatePoolAccountTokens } from "./kiro-accounts.mjs";

const TOKEN_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;
const PROBE_CACHE_MS = 30 * 1000;

// Kiro Builder ID / social logins don't ship a CodeWhisperer profileArn in the
// token file, but /generateAssistantResponse requires one (400 "profileArn is
// required" otherwise). This is the shared default profile used by Kiro's free
// tier; override with KIRO_PROFILE_ARN if your account uses a different one.
const DEFAULT_KIRO_PROFILE_ARN =
  process.env.KIRO_PROFILE_ARN || "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK";

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function parseExpiresAt(value) {
  if (!value) return null;
  const normalized = String(value).replace("Z", "+00:00");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function machineFingerprint() {
  const unique = `${os.hostname()}-${os.userInfo().username}-kiro-gateway`;
  return crypto.createHash("sha256").update(unique).digest("hex");
}

const PROFILE_ARN_RE = /arn:aws:codewhisperer:[a-z0-9-]+:\d+:profile\/[A-Za-z0-9]+/;
let cachedKiroProfileArn = null;

// Enterprise (IdC) accounts require their own CodeWhisperer profileArn — the
// shared free-tier default is rejected with 403. The token file doesn't carry
// it, but the Kiro IDE stores the active profileArn in its state DB. Scan that
// (as raw bytes; no SQLite dependency) to recover the correct ARN.
function discoverKiroProfileArn() {
  if (cachedKiroProfileArn) return cachedKiroProfileArn;
  const candidates = [
    path.join(os.homedir(), "Library", "Application Support", "Kiro", "User", "globalStorage", "state.vscdb"),
    path.join(os.homedir(), ".config", "Kiro", "User", "globalStorage", "state.vscdb"),
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "Kiro", "User", "globalStorage", "state.vscdb")
      : null,
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      if (fs.statSync(file).size > 80 * 1024 * 1024) continue;
      const raw = fs.readFileSync(file, "latin1");
      const keyed = raw.match(/"profileArn"\s*:\s*"(arn:aws:codewhisperer:[a-z0-9-]+:\d+:profile\/[A-Za-z0-9]+)"/);
      if (keyed) {
        cachedKiroProfileArn = keyed[1];
        return cachedKiroProfileArn;
      }
      const any = raw.match(PROFILE_ARN_RE);
      if (any) {
        cachedKiroProfileArn = any[0];
        return cachedKiroProfileArn;
      }
    } catch {
      // ignore unreadable/locked state files
    }
  }
  return null;
}

export class KiroAuth {
  constructor({
    credsFile,
    apiRegion = "us-east-1",
    passiveSync = null,
    credentialSource = "ide",
    accountsFile = null,
    accountId = null,
  }) {
    this.credsFile = expandHome(credsFile);
    this.apiRegion = apiRegion;
    this.apiHost = `https://runtime.${apiRegion}.kiro.dev`;
    this.fingerprint = machineFingerprint();
    this.refreshPromise = null;
    this.credsFileMtime = 0;
    this.probeCache = { at: 0, ok: false };
    this.credentialSource = credentialSource;
    this.accountsFile = accountsFile ? expandHome(accountsFile) : null;
    this.accountId = accountId;

    this.refreshToken = null;
    this.accessToken = null;
    this.expiresAt = null;
    this.profileArn = null;
    this.usingDefaultProfileArn = false;
    this.ssoRegion = apiRegion;
    this.clientId = null;
    this.clientSecret = null;
    this.authMethod = null;
    this.authType = "kiro_desktop";
    this.passiveSync = passiveSync ?? false;

    this.loadCredentials();
  }

  getCredsFileMtime() {
    try {
      return fs.statSync(this.credsFile).mtimeMs;
    } catch {
      return 0;
    }
  }

  loadCredentials() {
    if (!fs.existsSync(this.credsFile)) {
      throw new Error(`Kiro 凭据文件不存在: ${this.credsFile}`);
    }

    const data = JSON.parse(fs.readFileSync(this.credsFile, "utf8"));
    const prevToken = this.accessToken;

    this.refreshToken = data.refreshToken || data.refresh_token || null;
    this.accessToken = data.accessToken || data.access_token || null;
    this.profileArn =
      data.profileArn
      || data.profile_arn
      || data.arn
      || data.usageData?.profileArn
      || null;
    this.ssoRegion = data.idcRegion || data.idc_region || data.region || this.apiRegion;
    this.authMethod = data.authMethod || data.auth_method || null;

    if (!this.profileArn) {
      this.profileArn = this.recoverProfileArnFromCache();
    }

    if (data.clientIdHash && !data.clientId) {
      this.loadEnterpriseDeviceRegistration(data.clientIdHash);
    }

    this.enrichFromMetadata(data);

    this.clientId = data.clientId || data.client_id || this.clientId;
    this.clientSecret = data.clientSecret || data.client_secret || this.clientSecret;
    this.expiresAt = parseExpiresAt(data.expiresAt || data.expires_at);

    if (this.clientId && this.clientSecret) {
      this.authType = "aws_sso_oidc";
    }

    // IDE 模式下 IdC 企业账号由 Kiro IDE 负责刷新；账号池模式由 Gateway 主动刷新
    if (this.credentialSource !== "pool") {
      this.passiveSync = this.passiveSync || this.authMethod === "IdC" || data.loginProvider === "Enterprise";
    }

    // profileArn resolution: token file / backup cache (tried above) -> the
    // Kiro IDE's stored profile (correct for enterprise/IdC) -> shared free-tier
    // default as a last resort. The wrong ARN is rejected with 403, so prefer
    // the IDE's own value over the default.
    if (!this.profileArn) {
      const discovered = discoverKiroProfileArn();
      if (discovered) {
        this.profileArn = discovered;
        this.usingDefaultProfileArn = false;
      } else {
        this.profileArn = DEFAULT_KIRO_PROFILE_ARN;
        this.usingDefaultProfileArn = true;
      }
    } else {
      this.usingDefaultProfileArn = false;
    }

    this.credsFileMtime = this.getCredsFileMtime();

    if (this.accessToken && this.accessToken !== prevToken) {
      this.probeCache = { at: 0, ok: false };
    }
  }

  reloadIfChanged() {
    const mtime = this.getCredsFileMtime();
    if (mtime <= this.credsFileMtime) return false;

    const prevToken = this.accessToken;
    this.loadCredentials();
    if (this.accessToken === prevToken) {
      this.credsFileMtime = mtime;
      return false;
    }
    return true;
  }

  enrichFromMetadata(data) {
    if (this.credentialSource !== "local") return;

    const backupPaths = [
      `${this.credsFile}.bak`,
      path.join(path.dirname(this.credsFile), "kiro-auth-token.json.bak"),
    ];

    let backup = null;
    for (const filePath of backupPaths) {
      if (!fs.existsSync(filePath)) continue;
      try {
        backup = JSON.parse(fs.readFileSync(filePath, "utf8"));
        break;
      } catch {
        // ignore
      }
    }

    if (!this.profileArn) {
      this.profileArn =
        data.profileArn
        || data.profile_arn
        || data.arn
        || backup?.profileArn
        || backup?.arn
        || null;
    }

    if (!this.clientId || !this.clientSecret) {
      const hash = data.clientIdHash || backup?.clientIdHash;
      if (hash) this.loadEnterpriseDeviceRegistration(hash);
      this.clientId = this.clientId || data.clientId || backup?.clientId;
      this.clientSecret = this.clientSecret || data.clientSecret || backup?.clientSecret;
    }
  }

  recoverProfileArnFromCache() {
    const candidates = [
      `${this.credsFile}.bak`,
      path.join(path.dirname(this.credsFile), "kiro-auth-token.json.bak"),
    ];

    for (const filePath of candidates) {
      if (!fs.existsSync(filePath)) continue;
      try {
        const cached = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const arn =
          cached.profileArn
          || cached.profile_arn
          || cached.arn
          || cached.usageData?.profileArn
          || null;
        if (arn) {
          console.log(`[kiro-auth] 从备份恢复 profileArn: ${path.basename(filePath)}`);
          return arn;
        }
      } catch {
        // ignore malformed cache files
      }
    }

    return null;
  }

  loadEnterpriseDeviceRegistration(clientIdHash) {
    const regPath = path.join(os.homedir(), ".aws", "sso", "cache", `${clientIdHash}.json`);
    if (!fs.existsSync(regPath)) return;
    const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
    this.clientId = reg.clientId || this.clientId;
    this.clientSecret = reg.clientSecret || this.clientSecret;
    if (reg.region) this.ssoRegion = reg.region;
  }

  saveCredentials() {
    const existing = JSON.parse(fs.readFileSync(this.credsFile, "utf8"));
    existing.accessToken = this.accessToken;
    existing.refreshToken = this.refreshToken;
    if (this.expiresAt) existing.expiresAt = this.expiresAt.toISOString();
    if (this.profileArn) {
      existing.profileArn = this.profileArn;
      existing.profile_arn = this.profileArn;
      existing.arn = this.profileArn;
    }
    fs.writeFileSync(this.credsFile, JSON.stringify(existing, null, 2));
    this.credsFileMtime = this.getCredsFileMtime();

    if (this.credentialSource === "local") {
      return;
    }

    if (this.credentialSource === "pool" && this.accountsFile && this.accountId) {
      try {
        updatePoolAccountTokens(this.accountsFile, this.accountId, {
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          expiresAt: this.expiresAt,
          profileArn: this.profileArn,
        });
      } catch (e) {
        console.warn(`[kiro-auth] 回写账号池失败: ${e.message}`);
      }
    }
  }

  isExpiresAtStale() {
    if (!this.expiresAt) return true;
    return this.expiresAt.getTime() < Date.now();
  }

  isTokenExpiringSoon() {
    if (!this.expiresAt) return false;
    if (this.isExpiresAtStale()) return false;
    return this.expiresAt.getTime() - Date.now() <= TOKEN_REFRESH_THRESHOLD_MS;
  }

  async getAccessToken({ force = false } = {}) {
    this.reloadIfChanged();

    if (!force && this.accessToken) {
      if (!this.isTokenExpiringSoon()) {
        return this.accessToken;
      }
      // Passive (IdC) accounts are refreshed by Kiro IDE — don't fight it with
      // our own OIDC refresh (which the IdC session rejects with 400).
      if (this.passiveSync) {
        return this.accessToken;
      }
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken().finally(() => {
        this.refreshPromise = null;
      });
    }
    await this.refreshPromise;
    return this.accessToken;
  }

  async forceRefresh() {
    this.reloadIfChanged();
    if (this.passiveSync) {
      const changed = this.reloadIfChanged();
      if (this.accessToken) return this.accessToken;
      if (!changed) {
        await this.refreshAccessToken();
      }
      return this.accessToken;
    }
    await this.refreshAccessToken();
    return this.accessToken;
  }

  async handleUnauthorized() {
    const tokenBefore = this.accessToken;
    this.reloadIfChanged();

    if (this.accessToken && this.accessToken !== tokenBefore) {
      console.log("[kiro-auth] 已从 Kiro IDE 同步新凭据");
      return this.accessToken;
    }

    if (this.passiveSync) {
      throw new Error(
        `Kiro 凭据文件中的 token 已失效。请在 Kiro IDE 中保持登录（或重新登录），IDE 会自动更新本机凭据文件。`
      );
    }

    await this.refreshAccessToken();
    return this.accessToken;
  }

  async refreshAccessToken() {
    const tokenBefore = this.refreshToken;
    this.reloadIfChanged();

    // Passive (IdC) accounts are refreshed externally by Kiro IDE. We only
    // re-read the file; actively hitting the OIDC endpoint fails (400) and
    // spams retries, so never do it here.
    if (this.passiveSync && this.accessToken) {
      return;
    }

    try {
      if (this.authType === "aws_sso_oidc") {
        await this.refreshAwsSsoOidc();
      } else {
        await this.refreshKiroDesktop();
      }
    } catch (e) {
      this.reloadIfChanged();
      if (this.accessToken && this.refreshToken !== tokenBefore) {
        console.log("[kiro-auth] 刷新失败，但已从文件同步到新凭据");
        return;
      }
      // The auth type is inferred from the token file and can be wrong (e.g. a
      // Kiro Desktop login that also carries a device-registration clientId).
      // Try the other refresh endpoint once before surfacing the error.
      try {
        if (this.authType === "aws_sso_oidc") {
          console.warn("[kiro-auth] OIDC 刷新失败，改用 Kiro Desktop 刷新端点重试");
          await this.refreshKiroDesktop();
        } else if (this.clientId && this.clientSecret) {
          console.warn("[kiro-auth] Kiro Desktop 刷新失败，改用 OIDC 刷新端点重试");
          await this.refreshAwsSsoOidc();
        } else {
          throw e;
        }
      } catch {
        throw e;
      }
    }

    await this.ensureProfileArn();
    this.saveCredentials();
  }

  async probeToken({ force = false } = {}) {
    this.reloadIfChanged();

    if (!this.accessToken) {
      return { ok: false, reason: "missing_token" };
    }

    const now = Date.now();
    if (!force && this.probeCache.at && now - this.probeCache.at < PROBE_CACHE_MS) {
      return { ok: this.probeCache.ok, cached: true };
    }

    const params = new URLSearchParams({ origin: "AI_EDITOR" });
    if (this.profileArn) params.set("profileArn", this.profileArn);
    const url = `https://q.${this.apiRegion}.amazonaws.com/ListAvailableModels?${params}`;

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          "x-amz-target": "AmazonCodeWhispererService.ListAvailableModels",
          "User-Agent": this.getKiroHeaders(this.accessToken)["User-Agent"],
        },
        signal: AbortSignal.timeout(10000),
      });

      const ok = res.ok;
      this.probeCache = { at: now, ok };

      if (ok && this.isExpiresAtStale()) {
        this.expiresAt = new Date(Date.now() + 3600 * 1000);
        try {
          this.saveCredentials();
        } catch {
          // ignore write errors during probe
        }
      }

      return {
        ok,
        reason: ok ? null : `http_${res.status}`,
        status: res.status,
      };
    } catch (e) {
      this.probeCache = { at: now, ok: false };
      return { ok: false, reason: e.message };
    }
  }

  async ensureProfileArn() {
    if (!this.accessToken) return this.profileArn;
    // Already have a real (API/creds) profileArn — nothing to do.
    if (this.profileArn && !this.usingDefaultProfileArn) return this.profileArn;

    const hosts = [
      `https://q.${this.apiRegion}.amazonaws.com`,
      `https://runtime.${this.apiRegion}.kiro.dev`,
    ];

    for (const host of hosts) {
      try {
        const res = await fetch(`${host}/ListAvailableProfiles`, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
            "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
            "User-Agent": this.getKiroHeaders(this.accessToken)["User-Agent"],
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) continue;
        const data = await res.json();
        const arn = data.profiles?.[0]?.arn || data.profileArn || null;
        if (arn) {
          this.profileArn = arn;
          this.usingDefaultProfileArn = false;
          console.log(`[kiro-auth] 已从 API 获取 profileArn`);
          return arn;
        }
      } catch (e) {
        console.warn(`[kiro-auth] 获取 profileArn 失败 (${host}): ${e.message}`);
      }
    }

    // Keep (or set) the shared default so requests still succeed.
    if (!this.profileArn) {
      this.profileArn = DEFAULT_KIRO_PROFILE_ARN;
      this.usingDefaultProfileArn = true;
    }
    if (this.usingDefaultProfileArn) {
      console.log(`[kiro-auth] 使用默认 profileArn: ${this.profileArn}`);
    }
    return this.profileArn;
  }

  async refreshKiroDesktop() {
    const url = `https://prod.${this.ssoRegion}.auth.desktop.kiro.dev/refreshToken`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `KiroIDE-0.7.45-${this.fingerprint}`,
      },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kiro Desktop token 刷新失败 (${res.status}): ${text}`);
    }
    const data = await res.json();
    if (!data.accessToken) throw new Error("刷新响应缺少 accessToken");
    this.accessToken = data.accessToken;
    this.expiresAt = new Date(Date.now() + (data.expiresIn || 3600) * 1000);
  }

  async refreshAwsSsoOidc() {
    const url = `https://oidc.${this.ssoRegion}.amazonaws.com/token`;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
    });

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `AWS SSO token 刷新失败 (${res.status}): ${text}。请在 Kiro IDE 重新登录以更新凭据文件: ${this.credsFile}`
      );
    }

    const data = await res.json();
    const token = data.accessToken || data.access_token;
    if (!token) throw new Error("OIDC 刷新响应缺少 accessToken");

    this.accessToken = token;
    if (data.refreshToken || data.refresh_token) {
      this.refreshToken = data.refreshToken || data.refresh_token;
    }
    const expiresIn = data.expiresIn || data.expires_in || 3600;
    this.expiresAt = new Date(Date.now() + expiresIn * 1000);
  }

  watchCredentialsFile(onChange) {
    const dir = path.dirname(this.credsFile);
    const file = path.basename(this.credsFile);
    try {
      const watcher = fs.watch(dir, (_, changed) => {
        if (changed === file) {
          this.reloadIfChanged();
          onChange?.();
        }
      });
      return watcher;
    } catch (e) {
      console.warn(`[kiro-auth] 无法监听凭据文件: ${e.message}`);
      return null;
    }
  }

  getKiroHeaders(token) {
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-amz-json-1.0",
      "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
      "User-Agent": `aws-sdk-js/1.0.27 ua/2.1 os/darwin lang/js md/nodejs#24 api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.7.45-${this.fingerprint}`,
      "x-amz-user-agent": `aws-sdk-js/1.0.27 KiroIDE-0.7.45-${this.fingerprint}`,
      "x-amzn-codewhisperer-optout": "true",
      "x-amzn-kiro-agent-mode": "vibe",
      "amz-sdk-invocation-id": crypto.randomUUID(),
      "amz-sdk-request": "attempt=1; max=3",
      Connection: "close",
    };
  }
}

export async function readKiroCredsSummary(credsPath) {
  const file = expandHome(credsPath);
  if (!fs.existsSync(file)) {
    return { ok: false, message: "未找到 Kiro 凭据，请先在 Kiro IDE 登录" };
  }

  try {
    const creds = JSON.parse(fs.readFileSync(file, "utf8"));
    const expiresAt = creds.expiresAt || creds.expires_at || null;
    const fileExpired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;
    const usage = creds.usageData?.usageBreakdownList?.[0];

    let apiOk = false;
    let apiReason = null;
    if (creds.accessToken || creds.access_token) {
      try {
        const auth = new KiroAuth({ credsFile: file });
        const probe = await auth.probeToken();
        apiOk = probe.ok;
        apiReason = probe.reason;
      } catch (e) {
        apiReason = e.message;
      }
    }

    const reason = String(apiReason || "").toLowerCase();
    const apiExpired =
      reason === "http_401"
      || reason === "http_403"
      || reason.includes("expired")
      || reason.includes("invalid")
      || reason.includes("失效");
    const expired = !apiOk && (fileExpired || apiExpired);
    const stale = fileExpired && apiOk;

    return {
      ok: true,
      email: creds.email || creds.loginHint || creds.login_hint || "未知账号",
      expiresAt,
      expired,
      stale,
      apiOk,
      apiReason,
      fileExpired,
      passiveSync: creds.authMethod === "IdC" || creds.loginProvider === "Enterprise",
      usage: usage
        ? {
            current: usage.currentUsageWithPrecision ?? usage.currentUsage,
            limit: usage.usageLimitWithPrecision ?? usage.usageLimit,
          }
        : null,
      region: creds.region || creds.idcRegion || creds.idc_region || "us-east-1",
      authMethod: creds.authMethod || "unknown",
    };
  } catch (e) {
    return { ok: false, message: `凭据解析失败: ${e.message}` };
  }
}
