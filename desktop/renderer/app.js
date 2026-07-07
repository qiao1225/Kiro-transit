const api = window.desktopRelay;

const state = {
  busy: false,
  status: null,
  modelConfig: null,
  activeView: "overview",
};

const $ = (id) => document.getElementById(id);

const selectIds = [
  "claudeDefaultModel",
  "claudeSmallFastModel",
  "claudeHaikuModel",
  "claudeSonnetModel",
  "claudeOpusModel",
  "claudeFableModel",
];

const modeTargets = {
  claude: { claudeEnabled: true },
  manual: { claudeEnabled: false },
};

// Show an inline spinner on a specific button so a click feels instant even
// while the backend is still working. The renderer thread is never blocked by
// IPC calls, so this is purely about immediate visual feedback.
function setButtonLoading(button, loading) {
  if (!button || button.tagName !== "BUTTON") return;
  if (loading) {
    if (button.querySelector(":scope > .btn-spinner")) return;
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");
    const spinner = document.createElement("span");
    spinner.className = "btn-spinner";
    spinner.setAttribute("aria-hidden", "true");
    button.insertBefore(spinner, button.firstChild);
  } else {
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
    button.querySelector(":scope > .btn-spinner")?.remove();
  }
}

function on(id, eventName, handler) {
  const el = $(id);
  if (!el) return;
  if (eventName === "click" && el.tagName === "BUTTON") {
    el.addEventListener("click", async (event) => {
      setButtonLoading(el, true);
      try {
        await handler(event);
      } catch {
        // runAction already surfaces errors to the UI; swallow to avoid noise.
      } finally {
        setButtonLoading(el, false);
      }
    });
    return;
  }
  el.addEventListener(eventName, handler);
}

function setText(id, value) {
  const el = $(id);
  if (!el) return;
  el.textContent = value == null || value === "" ? "--" : String(value);
}

function setTone(id, tone) {
  const el = $(id);
  if (!el) return;
  el.dataset.tone = tone || "";
}

function setPillTone(id, tone) {
  const el = $(id);
  if (!el) return;
  el.className = "pill";
  if (tone) el.classList.add(tone);
}

function setSyncState(text, tone = "") {
  setText("syncState", text);
  setTone("syncState", tone);
}

function modeFromTargets(targets = {}) {
  return targets.claudeEnabled ? "claude" : "manual";
}

function modeLabel(mode) {
  return {
    claude: "接管 Claude",
    manual: "Claude 已关闭",
  }[mode || "claude"];
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = busy;
  });
}

function enabledModels() {
  return (state.modelConfig?.models || []).filter((model) => model.enabled !== false);
}

function modelLabel(model) {
  return `${model.id}${model.displayName && model.displayName !== model.id ? ` · ${model.displayName}` : ""}`;
}

function displayNameFor(modelId) {
  return (state.modelConfig?.models || []).find((model) => model.id === modelId)?.displayName || modelId || "";
}

function isNoDowngradeMode(modelConfig = state.modelConfig) {
  return Boolean(modelConfig?.quality?.noDowngrade);
}

function isOpusModelId(modelId) {
  return String(modelId || "").toLowerCase().includes("opus");
}

function renderSelect(id, value) {
  const select = $(id);
  if (!select) return;
  select.textContent = "";
  const models = enabledModels();
  if (!models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无可用模型";
    select.append(option);
    return;
  }
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = modelLabel(model);
    select.append(option);
  }
  select.value = value && models.some((model) => model.id === value) ? value : models[0].id;
}

function setSelectValue(id, value) {
  const select = $(id);
  if (!select) return;
  if ([...select.options].some((option) => option.value === value)) {
    select.value = value;
  }
}

function setInputValue(id, value) {
  const input = $(id);
  if (input) input.value = value || "";
}

const roleNamePairs = [
  ["claudeHaikuModel", "claudeHaikuName"],
  ["claudeSonnetModel", "claudeSonnetName"],
  ["claudeOpusModel", "claudeOpusName"],
  ["claudeFableModel", "claudeFableName"],
];

// Keep a role's display name in lockstep with its selected model, so the name
// always reflects the chosen model (e.g. picking claude-opus-4-7 for Haiku
// shows "Claude Opus 4.7", not a stale "Claude Haiku 4.5").
function syncRoleName(selectId, inputId) {
  const select = $(selectId);
  const input = $(inputId);
  if (!select || !input) return;
  input.value = displayNameFor(select.value);
}

function syncAllRoleNames() {
  for (const [selectId, inputId] of roleNamePairs) {
    syncRoleName(selectId, inputId);
  }
}

function renderQualityLock(modelId) {
  const note = $("qualityLockNote");
  if (!note) return;
  const locked = isNoDowngradeMode();
  note.hidden = !locked;
  if (locked) {
    const opus = modelId || $("claudeOpusModel")?.value || "--";
    const small = $("claudeSmallFastModel")?.value || "--";
    setText("qualityLockModel", `Opus ${opus} / small ${small}`);
  }
}

function syncDefaultSelectionToMatchingRole() {
  const selected = $("claudeDefaultModel")?.value || "";
  if (!selected) return;
  if (isOpusModelId(selected)) {
    setSelectValue("claudeOpusModel", selected);
    syncRoleName("claudeOpusModel", "claudeOpusName");
    renderQualityLock(selected);
    return;
  }
  if (selected.toLowerCase().includes("sonnet")) {
    setSelectValue("claudeSonnetModel", selected);
    syncRoleName("claudeSonnetModel", "claudeSonnetName");
    renderQualityLock();
    return;
  }
  if (selected.toLowerCase().includes("haiku")) {
    setSelectValue("claudeHaikuModel", selected);
    syncRoleName("claudeHaikuModel", "claudeHaikuName");
    renderQualityLock();
  }
}

function createCell(child) {
  const cell = document.createElement("td");
  cell.append(child);
  return cell;
}

function createInput(type, value, className) {
  const input = document.createElement("input");
  input.type = type;
  input.value = value == null ? "" : String(value);
  input.className = className;
  input.spellcheck = false;
  return input;
}

function renderTargetControls(targets = {}) {
  const normalized = { claudeEnabled: targets.claudeEnabled !== false };
  if (targets.mode === "manual") normalized.claudeEnabled = false;
  const mode = modeFromTargets(normalized);
  const claudeToggle = $("targetClaudeEnabled");
  if (claudeToggle) claudeToggle.checked = normalized.claudeEnabled;
  document.querySelectorAll(".mode-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
}

function currentTargetsFromControls() {
  const claudeEnabled = Boolean($("targetClaudeEnabled")?.checked);
  return {
    mode: modeFromTargets({ claudeEnabled }),
    claudeEnabled,
  };
}

function setTargetMode(mode) {
  const next = modeTargets[mode] || modeTargets.claude;
  const claudeToggle = $("targetClaudeEnabled");
  if (claudeToggle) claudeToggle.checked = next.claudeEnabled;
  renderTargetControls({ ...next, mode });
}

function setTargetEnabled(target, enabled) {
  if (target === "claude") {
    const toggle = $("targetClaudeEnabled");
    if (toggle) toggle.checked = enabled;
  }
  renderTargetControls(currentTargetsFromControls());
}

function renderModelRows(models) {
  const tbody = $("modelRows");
  if (!tbody) return;
  tbody.textContent = "";
  if (!models.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "empty-row";
    cell.textContent = "暂无模型";
    row.append(cell);
    tbody.append(row);
    return;
  }

  models.forEach((model, index) => {
    const row = document.createElement("tr");
    row.dataset.index = String(index);

    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "model-enabled";
    enabled.checked = model.enabled !== false;
    row.append(createCell(enabled));

    row.append(createCell(createInput("text", model.id, "model-id")));
    row.append(createCell(createInput("text", model.displayName, "model-display")));
    row.append(createCell(createInput("number", model.contextWindow || 200000, "model-context")));

    const source = document.createElement("span");
    source.className = "source-pill";
    source.textContent = model.custom ? "custom" : model.source || "manual";
    row.append(createCell(source));

    const remove = document.createElement("button");
    remove.className = "icon-btn row-remove";
    remove.type = "button";
    remove.title = "移除模型";
    remove.setAttribute("aria-label", "移除模型");
    remove.innerHTML = '<i class="btn-icon" data-lucide="trash-2"></i>';
    remove.addEventListener("click", () => {
      const next = collectModelConfig();
      next.models.splice(index, 1);
      renderModelConfig(next);
    });
    row.append(createCell(remove));

    tbody.append(row);
  });
}

function renderModelConfig(modelConfig) {
  state.modelConfig = modelConfig;
  const config = modelConfig || { models: [], targets: {}, claude: {} };
  const claude = config.claude || {};

  for (const id of selectIds) {
    const selected = {
      claudeDefaultModel: claude.defaultModel,
      claudeSmallFastModel: claude.smallFast,
      claudeHaikuModel: claude.haiku,
      claudeSonnetModel: claude.sonnet,
      claudeOpusModel: claude.opus,
      claudeFableModel: claude.fable,
    }[id];
    renderSelect(id, selected);
  }

  // Names are derived from the selected model so they always match.
  syncAllRoleNames();
  renderQualityLock(claude.opus);
  const effort = $("reasoningEffort");
  if (effort) effort.value = config.quality?.reasoningEffort || "medium";
  setText("modelUpdatedAt", config.updatedAt ? `更新 ${new Date(config.updatedAt).toLocaleString()}` : "内置默认");
  renderTargetControls(config.targets || {});
  renderModelRows(config.models || []);
}

function collectModelRows() {
  return [...document.querySelectorAll("#modelRows tr[data-index]")].map((row) => {
    const index = Number(row.dataset.index);
    const original = state.modelConfig?.models?.[index] || {};
    const id = row.querySelector(".model-id").value.trim();
    return {
      ...original,
      id,
      upstreamId: original.upstreamId || id,
      displayName: row.querySelector(".model-display").value.trim() || id,
      contextWindow: Number(row.querySelector(".model-context").value) || 200000,
      enabled: row.querySelector(".model-enabled").checked,
      custom: Boolean(original.custom),
      source: original.source || "manual",
    };
  });
}

function collectModelConfig() {
  const rows = collectModelRows().filter((model) => model.id);
  const claude = {
    defaultModel: $("claudeDefaultModel").value,
    smallFast: $("claudeSmallFastModel").value,
    smallFastName: displayNameFor($("claudeSmallFastModel").value),
    haiku: $("claudeHaikuModel").value,
    haikuName: $("claudeHaikuName").value.trim() || displayNameFor($("claudeHaikuModel").value),
    sonnet: $("claudeSonnetModel").value,
    sonnetName: $("claudeSonnetName").value.trim() || displayNameFor($("claudeSonnetModel").value),
    opus: $("claudeOpusModel").value,
    opusName: $("claudeOpusName").value.trim() || displayNameFor($("claudeOpusModel").value),
    fable: $("claudeFableModel").value,
    fableName: $("claudeFableName").value.trim() || displayNameFor($("claudeFableModel").value),
  };

  return {
    ...(state.modelConfig || {}),
    updatedAt: state.modelConfig?.updatedAt || null,
    source: state.modelConfig?.source || "manual",
    quality: {
      ...(state.modelConfig?.quality || {}),
      reasoningEffort: $("reasoningEffort")?.value || state.modelConfig?.quality?.reasoningEffort || "medium",
    },
    targets: currentTargetsFromControls(),
    models: rows,
    claude,
  };
}

async function saveModelConfigFromForm({ silent = false } = {}) {
  const payload = collectModelConfig();
  const result = await api.saveModelConfig(payload);
  renderModelConfig(result.modelConfig);
  if (!silent) {
    setText("testOutput", `模型配置已保存。\n路径: ${result.path}`);
  }
  return result.modelConfig;
}

function badgeText(enabled, managed) {
  if (!enabled) return "已关闭";
  return managed ? "已接管" : "待写入";
}

function probeText(probe = {}) {
  if (!probe) return "--";
  if (probe.skipped) return probe.message || "已跳过";
  return `${probe.status || "--"} / ${probe.conclusion || probe.message || "--"}`;
}

function credentialReasonLabel(reason) {
  const text = String(reason || "").toLowerCase();
  if (!text) return "unknown";
  if (text === "http_403" || text === "http_401" || text.includes("失效") || text.includes("expired") || text.includes("invalid")) {
    return "需要在 Kiro IDE 重新登录";
  }
  if (text.includes("missing")) return "未找到 Kiro 登录凭据";
  return reason;
}

function formatTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatExpiresIn(seconds) {
  if (seconds == null) return "--";
  if (seconds <= 0) return "已过期";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} 分钟`;
  return `${Math.round(minutes / 60)} 小时`;
}

function renderCredentialRefreshResult(result) {
  const after = result.after || {};
  const helpers = (result.helpers || [])
    .map((helper) => `${helper.name}: ${helper.alreadyRunning ? "已在后台" : helper.launched ? "已静默拉起" : helper.error || "未启动"}`)
    .join("\n");
  const cleanup = (result.cleanup || [])
    .map((item) => `${item.name}: ${item.quit ? "已退出临时进程" : item.error || "保留运行"}`)
    .join("\n");
  const lines = [
    result.ok ? "Kiro 凭据刷新: PASS" : "Kiro 凭据刷新: FAIL",
    "",
    `模式: ${result.mode || "--"} / ${result.reason || "--"}`,
    `结论: ${result.message || "--"}`,
    `账号: ${after.email || "--"}`,
    `过期时间: ${after.expiresAt || "--"} (${formatExpiresIn(after.expiresInSeconds)})`,
    `上游验证: ${after.apiOk ? "API OK" : after.apiReason || "不可用"}`,
    `模型刷新: ${result.modelRefresh?.ok ? `${result.modelRefresh.count} 个 / ${result.modelRefresh.source || "--"}` : result.modelRefresh?.error || "未执行"}`,
    "",
    "辅助进程:",
    helpers || "(未拉起)",
  ];
  if (cleanup) lines.push("", "清理:", cleanup);
  if (result.requiresLogin) lines.push("", "需要在 Kiro IDE 中完成登录或重新登录后重试。");
  setText("testOutput", lines.join("\n"));
  setText("diagnosticsOutput", JSON.stringify(result, null, 2));
}

function stepLine(label, step) {
  if (!step) return `${label}: 未执行`;
  if (step.ok) return `${label}: OK${step.detail ? ` / ${step.detail}` : ""}`;
  return `${label}: FAIL / ${step.error || "unknown"}`;
}

async function runStep(label, action, detail) {
  try {
    const value = await action();
    return {
      ok: true,
      label,
      value,
      detail: typeof detail === "function" ? detail(value) : detail,
    };
  } catch (error) {
    return {
      ok: false,
      label,
      error: error.message || String(error),
    };
  }
}

function renderDiagnostics(result) {
  const runtime = result.runtime || {};
  const credential = runtime.credential || {};
  const claude = result.claude || {};

  setText("diagKiroConclusion", credential.apiOk ? "Kiro 上游可用" : `Kiro 凭据不可用: ${credential.apiReason || "unknown"}`);
  setText("diagKiroAccount", credential.email || "--");
  setText("diagKiroApi", credential.apiOk ? "API OK" : `expired=${credential.expired} / fileExpired=${credential.fileExpired}`);
  setText("diagKiroFile", runtime.credentialFile);

  setText("diagClaudeConclusion", claude.conclusion);
  setText("diagClaudeManaged", claude.managed ? "已接管" : "未接管");
  setText(
    "diagClaudeAuth",
    claude.authConflict
      ? "冲突"
      : claude.hasAuthToken
        ? "AUTH_TOKEN"
        : claude.hasApiKey
          ? "API_KEY"
          : "未配置"
  );
  setText("diagClaudeProbe", probeText(claude.probe));

  setText("diagnosticsOutput", JSON.stringify(result, null, 2));
}

function renderStatus(status) {
  state.status = status;
  const relayOk = status.relayRunning && !status.relayError;
  const gatewayHealthy = status.gatewayHealth?.status === "healthy" || status.relayStatus?.gatewayOk;
  const creds = status.relayStatus?.creds || null;
  const credentialOk = !creds || (creds.apiOk !== false && !creds.expired);
  const gatewayOk = gatewayHealthy && credentialOk;
  const claudeOk = status.claude?.managed;
  const targets = {
    mode: status.modelConfig?.targetMode || state.modelConfig?.targets?.mode || "claude",
    claudeEnabled: status.modelConfig?.claudeEnabled ?? state.modelConfig?.targets?.claudeEnabled ?? true,
  };
  const liveModelCount = status.relayStatus?.modelCount || status.gatewayHealth?.models?.count || 0;
  const liveModelSource = status.relayStatus?.modelSource || status.gatewayHealth?.models?.source || "";
  const modelCount = liveModelCount || status.modelConfig?.modelCount || status.modelConfig?.enabledCount || 0;
  const serviceOk = relayOk && gatewayOk;
  const serviceWarn = relayOk || gatewayHealthy;

  setText("relayState", relayOk ? "运行中" : "未就绪");
  setText("gatewayState", gatewayOk ? "可用" : gatewayHealthy ? "凭据异常" : "未就绪");
  setText("claudeState", badgeText(targets.claudeEnabled, claudeOk));
  setText("modelCount", modelCount || "--");
  setText("relayUrl", `http://127.0.0.1:${status.config.port}`);
  setText("gatewayUrl", status.config.kiroGatewayUrl);
  setText("claudeBaseUrl", status.claude?.baseUrl || status.claude?.expectedBaseUrl);
  setText("modelSource", liveModelSource || status.modelConfig?.source || "unknown");
  setText("targetModeLabel", modeLabel(targets.mode));
  setText("overviewClaude", badgeText(targets.claudeEnabled, claudeOk));
  setText("overviewDefaultModel", status.modelConfig?.claudeDefaultModel);
  setText("overviewRelayPort", status.config.port);
  setText("overviewGatewayPort", status.config.gatewayPort);
  setText(
    "topbarSubtitle",
    serviceOk
      ? `服务在线，Claude ${claudeOk ? "已接管" : targets.claudeEnabled ? "待写入" : "已关闭"}`
      : serviceWarn
        ? "服务部分可用，需要检查凭据或子进程"
        : "服务未就绪"
  );
  setText("operationHint", serviceOk ? "点右上角「同步全部」会刷新凭据、写入 Claude、刷新模型和日志。" : "先启动服务，再点右上角「同步全部」；如凭据异常会打开 Kiro 登录。");
  setText("serviceSummary", serviceOk ? "ONLINE" : serviceWarn ? "PARTIAL" : "STOPPED");
  setPillTone("serviceSummary", serviceOk ? "ok" : serviceWarn ? "warn" : "bad");
  setText("targetSummary", targets.claudeEnabled ? (claudeOk ? "已接管" : "待写入") : "Claude 已关闭");
  setPillTone("targetSummary", claudeOk ? "ok" : targets.claudeEnabled ? "warn" : "");
  setText("sideTargetState", targets.claudeEnabled ? (claudeOk ? "已接管" : "待写入") : "已关闭");
  const syncLabel = $("syncState")?.textContent;
  if (!state.busy && (syncLabel === "未同步" || syncLabel === "5s 自动刷新" || syncLabel === "状态轮询")) {
    setSyncState(serviceOk ? "5s 自动刷新" : "状态轮询", serviceOk ? "ok" : "warn");
  }

  setText(
    "credentialState",
    `${status.config.credentialMode} / ${status.relayStatus?.credentialSource || status.gatewayHealth?.credentialSource || "unknown"}`
  );
  setText(
    "credentialApiState",
    creds
      ? creds.apiOk
        ? "API 可用"
        : credentialReasonLabel(creds.apiReason)
      : "未检测"
  );
  setPillTone("credentialApiState", creds?.apiOk ? "ok" : creds ? "warn" : "");
  setText("credentialAccount", creds?.email || status.gatewayHealth?.profileArn || "未知");
  const guard = status.credentialGuard || {};
  setText(
    "credentialGuardState",
    guard.running
      ? "刷新中"
      : guard.ok === false
        ? "需要处理"
        : "后台守护中"
  );
  setTone("credentialGuardState", guard.running ? "warn" : guard.ok === false ? "bad" : "ok");
  setText(
    "credentialGuardDetail",
    `${guard.message || "到期前自动刷新"}${guard.checkedAt ? ` / ${formatTime(guard.checkedAt)}` : ""}`
  );
  const detectedCredentialFile =
    status.relayStatus?.credentialDiscovery?.selectedFile ||
    status.relayStatus?.ideCredsFile ||
    status.relayStatus?.credentialFile ||
    status.config.kiroCredsFile;
  setText("credentialFilePath", detectedCredentialFile);
  setText("accountsPath", "不使用外部工具");
  setText("configPath", status.paths.configFile);
  setText("userDataPath", status.paths.userData);
  setText("runtimeCredentialPath", detectedCredentialFile);
  setText("claudeSettingsPath", status.claude?.settingsFile);
  setText("modelConfigPath", status.paths.modelConfigFile);
  setText("claudeTargetBadge", badgeText(targets.claudeEnabled, claudeOk));
  setText("claudeTargetBaseUrl", status.claude?.baseUrl || status.claude?.expectedBaseUrl);
  setText(
    "claudeTargetModel",
    status.claude?.modelLocked
      ? `固定: ${status.claude.model}`
      : `可切换 / 默认 ${status.modelConfig?.claudeDefaultModel || "--"}`
  );
  setText(
    "claudeAuthState",
    status.claude?.authConflict
      ? "冲突: AUTH_TOKEN + API_KEY"
      : status.claude?.hasAuthToken
        ? "AUTH_TOKEN"
        : status.claude?.hasApiKey
          ? "API_KEY"
          : "未配置"
  );
  setPillTone("claudeTargetBadge", claudeOk ? "ok" : targets.claudeEnabled ? "warn" : "");
  setTone("claudeTargetModel", status.claude?.modelLocked ? "warn" : "ok");

  setTone("relayState", relayOk ? "ok" : "bad");
  setTone("gatewayState", gatewayOk ? "ok" : gatewayHealthy ? "warn" : "bad");
  setTone("claudeState", claudeOk ? "ok" : targets.claudeEnabled ? "warn" : "muted");

  $("localModeBtn")?.classList.toggle("active", true);
  if (!state.modelConfig) renderTargetControls(targets);

  const badge = $("appBadge");
  if (badge) {
    badge.className = "status-badge";
    if (relayOk && gatewayOk && (!targets.claudeEnabled || claudeOk)) {
      badge.classList.add("ok");
      badge.textContent = "Ready";
    } else if (relayOk || gatewayHealthy) {
      badge.classList.add("warn");
      badge.textContent = "Partial";
    } else {
      badge.classList.add("bad");
      badge.textContent = "Stopped";
    }
  }
}

async function refreshStatus() {
  const status = await api.getStatus();
  renderStatus(status);
  return status;
}

async function refreshModelConfig() {
  const result = await api.getModelConfig();
  renderModelConfig(result.modelConfig);
  return result.modelConfig;
}

async function refreshLogs() {
  setText("logs", await api.getLogs());
}

async function syncWorkspace() {
  const startedAt = new Date();
  setSyncState("同步中", "warn");

  const credentialStep = await runStep("凭据", api.refreshCredentials, (result) =>
    result?.after?.apiOk ? `${result.after.email || "unknown"} / API OK` : result?.after?.apiReason || result?.message || "已刷新"
  );

  const modelStep = await runStep("模型", api.refreshModels, (result) =>
    `${result.modelConfig?.models?.length || 0} 个 / ${result.meta?.source || result.modelConfig?.source || "unknown"}`
  );
  if (modelStep.ok) renderModelConfig(modelStep.value.modelConfig);

  const claudeStep = await runStep("Claude 接管", async () => {
    const targets = state.modelConfig?.targets || { claudeEnabled: true };
    return targets.claudeEnabled ? api.installClaude() : api.disableClaude();
  }, (result) => result?.claude?.managed ? "已写入本地 Relay" : "已关闭或未接管");

  const statusStep = await runStep("状态", refreshStatus, (status) =>
    status.relayRunning && (status.gatewayHealth?.status === "healthy" || status.relayStatus?.gatewayOk) ? "服务在线" : "服务未完全就绪"
  );

  const logStep = await runStep("日志", refreshLogs, "已读取最新日志");
  const ok = credentialStep.ok && modelStep.ok && claudeStep.ok && statusStep.ok && logStep.ok;
  const finishedAt = new Date();

  setSyncState(`${ok ? "已同步" : "部分失败"} ${finishedAt.toLocaleTimeString()}`, ok ? "ok" : "warn");
  setText(
    "testOutput",
    [
      ok ? "同步全部: PASS" : "同步全部: PARTIAL",
      "",
      stepLine("凭据", credentialStep),
      stepLine("模型", modelStep),
      stepLine("Claude 接管", claudeStep),
      stepLine("状态", statusStep),
      stepLine("日志", logStep),
      "",
      `开始: ${startedAt.toLocaleString()}`,
      `完成: ${finishedAt.toLocaleString()}`,
    ].join("\n")
  );
  return {
    ok,
    credential: credentialStep,
    models: modelStep,
    claude: claudeStep,
    status: statusStep,
    logs: logStep,
  };
}

async function runAction(label, action, { refresh = true } = {}) {
  setBusy(true);
  try {
    const result = await action();
    if (refresh) await refreshStatus();
    await refreshLogs();
    return result;
  } catch (error) {
    setText("testOutput", `${label}失败:\n${error.message || error}`);
    setView("logs");
    throw error;
  } finally {
    setBusy(false);
  }
}

function renderTestResult(result) {
  const lines = [
    result.ok ? "Claude smoke test: PASS" : "Claude smoke test: FAIL",
    "",
    `Command: ${result.command}`,
    "",
    "STDOUT:",
    result.stdout || "(empty)",
  ];
  if (result.stderr) lines.push("", "STDERR:", result.stderr);
  setText("testOutput", lines.join("\n"));
  setView("logs");
}

function setView(viewName) {
  state.activeView = viewName;
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewName);
  });
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === viewName);
  });
}

async function applyTargets() {
  const saved = await saveModelConfigFromForm({ silent: true });
  const result = await api.applyTargets(saved.targets);
  if (result.modelConfig) renderModelConfig(result.modelConfig);
  if (result.status) renderStatus(result.status);
  setText(
    "testOutput",
    `目标已应用。\n模式: ${modeLabel(result.modelConfig?.targets?.mode)}\nClaude: ${result.modelConfig?.targets?.claudeEnabled ? "开启" : "关闭"}`
  );
  setView("logs");
  return result;
}

document.querySelectorAll(".nav-btn").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

document.querySelectorAll(".mode-btn").forEach((button) => {
  button.addEventListener("click", () => setTargetMode(button.dataset.mode));
});

on("targetClaudeEnabled", "change", () => renderTargetControls(currentTargetsFromControls()));
on("applyTargetsBtnTop", "click", () => runAction("应用目标", applyTargets, { refresh: false }));
on("syncAllBtn", "click", () => runAction("同步全部", syncWorkspace, { refresh: false }));
// 同步日志：只重新读取日志，轻量、不阻塞其他按钮
on("refreshLogsBtn", "click", async () => {
  await refreshLogs();
});
on("runDiagnosticsBtn", "click", () =>
  runAction(
    "运行诊断",
    async () => {
      const result = await api.runDiagnostics();
      renderDiagnostics(result);
      setView("diagnostics");
    },
    { refresh: true }
  )
);
on("runDiagnosticsBtnPanel", "click", () =>
  runAction(
    "运行诊断",
    async () => {
      const result = await api.runDiagnostics();
      renderDiagnostics(result);
      setView("diagnostics");
    },
    { refresh: true }
  )
);

for (const [id, label, action] of [
  ["startAllBtn", "启动全部", api.startServices],
  ["startAllBtnOverview", "启动全部", api.startServices],
  ["restartAllBtn", "重启全部", api.restartServices],
  ["restartBtn", "重启全部", api.restartServices],
  ["stopAllBtn", "停止全部", api.stopServices],
  ["stopBtn", "停止全部", api.stopServices],
]) {
  on(id, "click", () => runAction(label, action));
}

on("refreshModelsBtn", "click", () =>
  runAction("获取模型", async () => {
    const result = await api.refreshModels();
    renderModelConfig(result.modelConfig);
    setText("testOutput", `模型已更新。\n来源: ${result.meta?.source || result.modelConfig.source}\n数量: ${result.modelConfig.models.length}`);
    setView("logs");
  })
);

on("addModelBtn", "click", () => {
  const next = collectModelConfig();
  next.models.push({
    id: "custom-model",
    upstreamId: "custom-model",
    displayName: "Custom Model",
    contextWindow: 200000,
    enabled: true,
    source: "manual",
    custom: true,
  });
  renderModelConfig(next);
});

on("saveModelsBtn", "click", () => runAction("保存模型配置", () => saveModelConfigFromForm(), { refresh: false }));
on("claudeDefaultModel", "change", () => {
  syncDefaultSelectionToMatchingRole();
});
on("installClaudeBtn", "click", () =>
  runAction("写入 Claude", async () => {
    setTargetEnabled("claude", true);
    await saveModelConfigFromForm({ silent: true });
    const result = await api.installClaude();
    setText("testOutput", `Claude 配置已写入。\n备份: ${result.backup || "无旧配置"}`);
    setView("logs");
  })
);
on("disableClaudeBtn", "click", () =>
  runAction("关闭 Claude", async () => {
    setTargetEnabled("claude", false);
    await saveModelConfigFromForm({ silent: true });
    const result = await api.disableClaude();
    setText("testOutput", `Claude 接管已关闭。\n备份: ${result.backup || "无旧配置"}`);
    setView("logs");
  })
);
on("restoreClaudeBtn", "click", () =>
  runAction("恢复 Claude", async () => {
    const result = await api.restoreClaude();
    setText("testOutput", `Claude 配置已恢复。\n来源: ${result.restoredFrom}`);
    setView("logs");
  })
);
on("clearClaudeModelPinBtn", "click", () =>
  runAction("修复模型切换", async () => {
    const result = await api.repairClaudeModelSwitching();
    const roles = result.roleMapping || {};
    setText(
      "testOutput",
      [
        "Claude 模型切换已修复。",
        `移除 settings.model: ${result.clear?.removed?.modelPin ? "是" : "否"}`,
        `移除 ANTHROPIC_MODEL: ${result.clear?.removed?.envModel ? "是" : "否"}`,
        `默认: ${roles.defaultModel || "--"}`,
        `Haiku: ${roles.haiku || "--"}`,
        `Sonnet: ${roles.sonnet || "--"}`,
        `Opus: ${roles.opus || "--"}`,
        `Fable: ${roles.fable || "--"}`,
        `备份: ${result.install?.backup || result.clear?.backup || "无"}`,
      ].join("\n")
    );
    setView("logs");
  })
);
on("testClaudeBtn", "click", () =>
  runAction("测试 Claude", async () => {
    await saveModelConfigFromForm({ silent: true });
    renderTestResult(await api.testClaude());
  })
);

on("localModeBtn", "click", () => runAction("切换本地 Kiro", () => api.setCredentialMode("local")));
on("refreshCredentialsBtn", "click", () =>
  runAction("刷新 Kiro 凭据", async () => {
    const result = await api.refreshCredentials();
    renderCredentialRefreshResult(result);
    return result;
  })
);
on("openLogsBtn", "click", () => {
  if (state.status?.paths?.logsDir) api.openPath(state.status.paths.logsDir);
});

for (const [selectId, inputId] of roleNamePairs) {
  on(selectId, "change", () => {
    syncRoleName(selectId, inputId);
    renderQualityLock();
  });
}

document.addEventListener("click", (event) => {
  const target = event.target.closest(".path-clickable");
  if (!target || !target.textContent || target.textContent === "--") return;
  api.openPath(target.textContent);
});

api.onStatusUpdate((status) => renderStatus(status));

refreshModelConfig()
  .then(refreshStatus)
  .then(refreshLogs)
  .catch((error) => {
    setText("testOutput", `初始化失败:\n${error.message || error}`);
    setView("logs");
  });

setInterval(() => {
  if (!state.busy) refreshStatus().catch(() => {});
}, 5000);
