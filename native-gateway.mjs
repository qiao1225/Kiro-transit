#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KiroAuth } from "./lib/kiro-auth.mjs";
import { materializeLocalCreds, resolveCredentialPaths } from "./lib/kiro-accounts.mjs";
import { buildKiroPayload, resolveModelId } from "./lib/kiro-converter.mjs";
import { ModelRegistry } from "./lib/kiro-models.mjs";
import { parseKiroStream } from "./lib/kiro-stream.mjs";
import {
  anthropicRequestToOpenAi,
  buildAnthropicMessageResponse,
  finishAnthropicStream,
  startAnthropicStream,
  writeAnthropicStreamEvent,
} from "./lib/kiro-anthropic.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.KIRO_DESKTOP_CONFIG_FILE || path.join(__dirname, "config.json");
const DATA_DIR = process.env.KIRO_DESKTOP_DATA_DIR || path.join(__dirname, "data");
const VERSION = "1.0.0-native";

function expandHome(p) {
  return p.startsWith("~") ? path.join(process.env.HOME || "", p.slice(1)) : p;
}

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  return {
    port: Number(process.env.GATEWAY_PORT || raw.gatewayPort || 8000),
    proxyApiKey: process.env.KIRO_GATEWAY_KEY || process.env.PROXY_API_KEY || raw.kiroGatewayApiKey || "",
    kiroCredsFile: expandHome(process.env.KIRO_CREDS_FILE || raw.kiroCredsFile || "auto"),
    kiroAccountsFile: raw.kiroAccountsFile ? expandHome(raw.kiroAccountsFile) : null,
    credentialMode: raw.credentialMode || "local",
    apiRegion: process.env.KIRO_API_REGION || raw.kiroApiRegion || "us-east-1",
  };
}

function bootstrapCredentials(config) {
  const resolved = resolveCredentialPaths(config, DATA_DIR);
  const auth = new KiroAuth({
    credsFile: resolved.credsFile,
    apiRegion: config.apiRegion,
    passiveSync: resolved.passiveSync,
    credentialSource: resolved.source,
    accountsFile: resolved.accountsFile,
    accountId: resolved.account?.id || null,
  });
  return { auth, resolved };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendErrorSafely(res, status, data) {
  if (res.writableEnded) return;
  if (res.headersSent) {
    res.write(`event: error\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
    return;
  }
  sendJson(res, status, data);
}

function isRecoverableStreamError(error) {
  const text = `${error?.message || ""} ${error?.cause?.message || ""} ${error?.cause?.code || ""}`.toLowerCase();
  return text.includes("terminated")
    || text.includes("und_err_socket")
    || text.includes("other side closed")
    || text.includes("socket");
}

function verifyApiKey(req, proxyApiKey) {
  if (!proxyApiKey) return true;
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${proxyApiKey}`) return true;
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim() === proxyApiKey) return true;
  return false;
}

// Total-request safety cap so a hung upstream connection can't block a request
// forever. Long Claude Code turns can legitimately run for many minutes, so the
// default is intentionally generous; override with KIRO_UPSTREAM_TIMEOUT_MS.
const UPSTREAM_TIMEOUT_MS = Number(process.env.KIRO_UPSTREAM_TIMEOUT_MS || 1_800_000);
const UPSTREAM_MAX_ATTEMPTS = Math.max(1, Number(process.env.KIRO_UPSTREAM_MAX_ATTEMPTS || 3));

async function callKiro(auth, payload) {
  const url = `${auth.apiHost}/generateAssistantResponse`;
  const body = JSON.stringify(payload);

  const send = (token) =>
    fetch(url, {
      method: "POST",
      headers: auth.getKiroHeaders(token),
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

  const token = await auth.getAccessToken();
  const res = await send(token);

  // 401/403 means the token went stale (possibly mid-session). Re-auth once and
  // retry with a fresh token before surfacing the error.
  if (res.status === 401 || res.status === 403) {
    await auth.handleUnauthorized();
    const retryToken = await auth.getAccessToken();
    return send(retryToken);
  }

  return res;
}

async function collectKiroResponse(upstream) {
  let content = "";
  let thinking = "";
  const toolCalls = [];

  for await (const event of parseKiroStream(upstream)) {
    if (event.type === "content") content += event.content;
    else if (event.type === "thinking") thinking += event.content;
    else if (event.type === "tool_use") toolCalls.push(event.tool);
  }

  return normalizeCollectedResponse({ content, thinking, toolCalls });
}

function findJsonObjectEnd(text, start) {
  if (text[start] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function extractTextEncodedToolCalls(content) {
  const marker = "Assistant requested tool calls:";
  const markerIndex = content.lastIndexOf(marker);
  if (markerIndex === -1) return { content, toolCalls: [] };

  const prefix = content.slice(0, markerIndex).trimEnd();
  const tail = content.slice(markerIndex + marker.length);
  const toolCalls = [];
  let pos = 0;

  while (pos < tail.length) {
    while (/\s/.test(tail[pos] || "")) pos += 1;
    const match = tail.slice(pos).match(/^-\s*([A-Za-z_][\w.-]*)(?:\s*\(([^)]+)\))?\s*:\s*/);
    if (!match) break;
    pos += match[0].length;

    while (/\s/.test(tail[pos] || "")) pos += 1;
    if (tail[pos] !== "{") break;

    const jsonEnd = findJsonObjectEnd(tail, pos);
    if (jsonEnd === -1) break;

    const rawArgs = tail.slice(pos, jsonEnd + 1);
    try {
      const args = JSON.parse(rawArgs);
      const name = args.name || match[1];
      const id = match[2] || args.toolUseId || args.id || `toolu_text_${Date.now()}_${toolCalls.length}`;
      toolCalls.push({
        id,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      });
    } catch {
      break;
    }
    pos = jsonEnd + 1;
  }

  return toolCalls.length ? { content: prefix, toolCalls } : { content, toolCalls: [] };
}

function toolCallScore(tool) {
  const args = tool?.function?.arguments || "";
  return args && args !== "{}" ? args.length : 0;
}

function dedupeToolCalls(toolCalls) {
  const byId = new Map();
  for (const tool of toolCalls || []) {
    const name = tool?.function?.name || tool?.name || "";
    const id = tool?.id || "";
    if (!name || !id) continue;
    const existing = byId.get(id);
    if (!existing || toolCallScore(tool) > toolCallScore(existing)) byId.set(id, tool);
  }
  return [...byId.values()];
}

function normalizeCollectedResponse(collected) {
  const rescued = extractTextEncodedToolCalls(collected.content || "");
  const toolCalls = dedupeToolCalls([...(collected.toolCalls || []), ...rescued.toolCalls]);
  return {
    ...collected,
    content: rescued.toolCalls.length ? rescued.content : collected.content,
    toolCalls,
  };
}

async function upstreamError(upstream) {
  const text = await upstream.text().catch(() => "");
  const error = new Error(text || `Kiro API error ${upstream.status}`);
  error.upstreamStatus = upstream.status;
  error.upstreamBody = text;
  return error;
}

async function collectKiroResponseWithRetry(auth, payload, firstUpstream = null) {
  let upstream = firstUpstream;

  for (let attempt = 1; attempt <= UPSTREAM_MAX_ATTEMPTS; attempt += 1) {
    if (!upstream) upstream = await callKiro(auth, payload);
    if (!upstream.ok) throw await upstreamError(upstream);

    try {
      return await collectKiroResponse(upstream);
    } catch (e) {
      if (!isRecoverableStreamError(e) || attempt >= UPSTREAM_MAX_ATTEMPTS) throw e;
      console.warn(`[kiro-native] 上游响应流中断，重试 ${attempt}/${UPSTREAM_MAX_ATTEMPTS - 1}: ${e.message}`);
      upstream = null;
    }
  }

  throw new Error("Kiro API response collection failed");
}

function sendUpstreamFailure(res, error) {
  if (error?.upstreamStatus) {
    return sendJson(res, error.upstreamStatus, {
      type: "error",
      error: { type: "api_error", message: error.upstreamBody || error.message },
    });
  }
  return sendJson(res, 502, {
    type: "error",
    error: { type: "stream_error", message: error?.message || String(error) },
  });
}

function writeBufferedTextDeltas(res, text, index = 0) {
  const chunkSize = 1200;
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    writeAnthropicStreamEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: text.slice(offset, offset + chunkSize) },
    });
  }
}

class StreamingToolCallGuard {
  constructor() {
    this.marker = "Assistant requested tool calls:";
    this.buffer = "";
    this.rescuing = false;
  }

  feed(text) {
    if (!text) return "";
    this.buffer += text;

    if (this.rescuing) return "";

    const markerIndex = this.buffer.indexOf(this.marker);
    if (markerIndex !== -1) {
      const safeText = this.buffer.slice(0, markerIndex).trimEnd();
      this.buffer = this.buffer.slice(markerIndex);
      this.rescuing = true;
      return safeText;
    }

    const keep = this.marker.length - 1;
    if (this.buffer.length <= keep) return "";

    const safeLength = this.buffer.length - keep;
    const safeText = this.buffer.slice(0, safeLength);
    this.buffer = this.buffer.slice(safeLength);
    return safeText;
  }

  finish() {
    if (this.rescuing) {
      const rescued = extractTextEncodedToolCalls(this.buffer);
      if (rescued.toolCalls.length) return { text: "", rescuedToolCalls: rescued.toolCalls };
      return { text: this.buffer, rescuedToolCalls: [] };
    }

    const text = this.buffer;
    this.buffer = "";
    return { text, rescuedToolCalls: [] };
  }
}

async function streamKiroResponseWithRetry(auth, payload, firstUpstream, res, model) {
  let upstream = firstUpstream;
  const { anthropicModel } = startAnthropicStream(res, model);
  res.flushHeaders?.();

  for (let attempt = 1; attempt <= UPSTREAM_MAX_ATTEMPTS; attempt += 1) {
    const guard = new StreamingToolCallGuard();
    const toolCalls = [];
    let contentLength = 0;
    let thinkingLength = 0;
    let emittedVisibleOutput = false;

    if (!upstream) upstream = await callKiro(auth, payload);
    if (!upstream.ok) throw await upstreamError(upstream);

    try {
      for await (const event of parseKiroStream(upstream)) {
        if (res.writableEnded) return;

        if (event.type === "content") {
          const safeText = guard.feed(event.content);
          if (safeText) {
            writeBufferedTextDeltas(res, safeText);
            contentLength += safeText.length;
            emittedVisibleOutput = true;
          }
        } else if (event.type === "thinking") {
          thinkingLength += event.content?.length || 0;
        } else if (event.type === "tool_use") {
          toolCalls.push(event.tool);
          emittedVisibleOutput = true;
        }
      }

      const final = guard.finish();
      if (final.text) {
        writeBufferedTextDeltas(res, final.text);
        contentLength += final.text.length;
      }

      const mergedToolCalls = dedupeToolCalls([...toolCalls, ...final.rescuedToolCalls]);
      finishAnthropicStream(res, {
        anthropicModel,
        outputTokens: Math.ceil((contentLength + thinkingLength) / 4),
        toolCalls: mergedToolCalls,
      });
      return;
    } catch (e) {
      if (isRecoverableStreamError(e) && !emittedVisibleOutput && attempt < UPSTREAM_MAX_ATTEMPTS) {
        console.warn(`[kiro-native] 上游响应流中断，流式重试 ${attempt}/${UPSTREAM_MAX_ATTEMPTS - 1}: ${e.message}`);
        upstream = null;
        continue;
      }
      throw e;
    }
  }

  throw new Error("Kiro API response stream failed");
}

async function handleAnthropicMessages(req, res, auth) {
  const body = await readJsonBody(req);
  const openAiBody = anthropicRequestToOpenAi(body);
  const model = resolveModelId(openAiBody.model);
  let payload;

  try {
    payload = buildKiroPayload(openAiBody, auth.profileArn);
  } catch (e) {
    return sendJson(res, 400, {
      type: "error",
      error: { type: "invalid_request_error", message: e.message },
    });
  }

  let upstream;
  try {
    upstream = await callKiro(auth, payload);
  } catch (e) {
    return sendJson(res, 401, {
      type: "error",
      error: { type: "authentication_error", message: e.message },
    });
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    return sendJson(res, upstream.status, {
      type: "error",
      error: { type: "api_error", message: text || `Kiro API error ${upstream.status}` },
    });
  }

  if (openAiBody.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      await streamKiroResponseWithRetry(auth, payload, upstream, res, model);
    } catch (e) {
      return sendErrorSafely(res, e?.upstreamStatus || 502, {
        type: "error",
        error: { type: e?.upstreamStatus ? "api_error" : "stream_error", message: e?.upstreamBody || e?.message || String(e) },
      });
    }
    return;
  }

  try {
    const collected = await collectKiroResponseWithRetry(auth, payload, upstream);
    const { content, thinking, toolCalls } = collected;
    return sendJson(
      res,
      200,
      buildAnthropicMessageResponse({
        model,
        text: content,
        thinking,
        toolCalls,
        outputTokens: Math.ceil((content.length + thinking.length) / 4),
      })
    );
  } catch (e) {
    if (isRecoverableStreamError(e) || e.upstreamStatus) return sendUpstreamFailure(res, e);
    throw e;
  }
}

const config = loadConfig();
let auth;
let credentialResolved;

let modelRegistry;

try {
  ({ auth, resolved: credentialResolved } = bootstrapCredentials(config));
  modelRegistry = new ModelRegistry(auth);
  console.log(
    `[kiro-native] 凭据已加载 (${auth.authType}, ${credentialResolved.source === "pool" ? "外部凭据" : "Kiro IDE"})`
  );
  auth.getAccessToken()
    .catch(() => {})
    .then(() => auth.probeToken())
    .then((probe) => {
      if (probe.ok) {
        const mode = credentialResolved.source === "pool" ? "外部凭据" : (auth.passiveSync ? "IdC 被动同步" : "主动刷新");
        console.log(`[kiro-native] 凭据可用 (${mode})`);
      } else {
        const hint = credentialResolved.source === "pool"
          ? "请更新外部凭据"
          : "等待 Kiro IDE 更新凭据文件";
        console.warn(`[kiro-native] 凭据待同步: ${probe.reason || "unknown"}，${hint}`);
      }
      return auth.ensureProfileArn();
    })
    .then(() => {
      if (auth.profileArn) auth.saveCredentials();
      console.log(`[kiro-native] profileArn: ${auth.profileArn ? "configured" : "missing"}`);
    })
    .catch((e) => console.warn(`[kiro-native] 凭据检查失败: ${e.message}`));
  if (credentialResolved.mode === "local") {
    const ideFile = credentialResolved.ideCredsFile;
    if (ideFile && fs.existsSync(ideFile)) {
      const ideDir = path.dirname(ideFile);
      const ideName = path.basename(ideFile);
      fs.watch(ideDir, (_, changed) => {
        if (changed !== ideName) return;
        try {
          const rematerialized = resolveCredentialPaths(config, DATA_DIR);
          auth.credsFile = rematerialized.credsFile;
          auth.loadCredentials();
          console.log("[kiro-native] Kiro IDE 凭据更新，已重新同步");
          modelRegistry?.refresh().catch(() => {});
        } catch (e) {
          console.warn(`[kiro-native] IDE 凭据同步失败: ${e.message}`);
        }
      });
    }
  }
  if (credentialResolved.mode === "json" && credentialResolved.accountsFile) {
    try {
      const poolFile = credentialResolved.accountsFile;
      fs.watch(path.dirname(poolFile), (_, changed) => {
        if (changed !== path.basename(poolFile)) return;
        try {
          resolveCredentialPaths(config, DATA_DIR);
          auth.reloadIfChanged();
          console.log("[kiro-native] 外部凭据变更，已重新物化凭据");
          modelRegistry?.refresh().catch(() => {});
        } catch (e) {
          console.warn(`[kiro-native] 账号池同步失败: ${e.message}`);
        }
      });
    } catch (e) {
      console.warn(`[kiro-native] 无法监听账号池文件: ${e.message}`);
    }
  }
  modelRegistry.refresh().then((models) => {
    console.log(`[kiro-native] 模型列表就绪: ${models.length} 个 (${modelRegistry.source})`);
  }).catch((e) => {
    console.warn(`[kiro-native] 模型预加载失败，将使用内置列表: ${e.message}`);
  });
} catch (e) {
  console.error(`[kiro-native] 凭据加载失败: ${e.message}`);
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/" || url.pathname === "/health") {
    return sendJson(res, 200, {
      status: "healthy",
      mode: "native",
      version: VERSION,
      apiHost: auth.apiHost,
      authType: auth.authType,
      credentialSource: credentialResolved?.source || "ide",
      profileArn: auth.profileArn ? "configured" : "missing",
      models: modelRegistry.getStatus(),
    });
  }

  const needsAuth = url.pathname.startsWith("/v1/");
  if (needsAuth && !verifyApiKey(req, config.proxyApiKey)) {
    return sendJson(res, 401, { error: { message: "Invalid or missing API Key" } });
  }

  try {
    if (url.pathname === "/v1/models" && req.method === "GET") {
      const refresh = url.searchParams.get("refresh") === "1";
      const data = await modelRegistry.listAnthropicModels({ force: refresh });
      const meta = modelRegistry.getStatus();
      return sendJson(res, 200, { object: "list", data, meta });
    }

    if (url.pathname === "/v1/messages" && req.method === "POST") {
      return await handleAnthropicMessages(req, res, auth);
    }

    return sendJson(res, 404, { error: { message: "Not Found" } });
  } catch (e) {
    console.error("[kiro-native] error:", e);
    return sendErrorSafely(res, 500, { error: { message: e.message, type: "internal_error" } });
  }
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`[kiro-native] Gateway 已启动: http://127.0.0.1:${config.port}`);
  console.log(`[kiro-native] Anthropic 端点: http://127.0.0.1:${config.port}/v1/messages`);
});
