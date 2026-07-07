# Kiro Desktop Relay macOS 使用说明

## 产物

- Universal DMG: `release/Kiro Desktop Relay-1.0.3-universal.dmg`
- Universal ZIP: `release/Kiro Desktop Relay-1.0.3-universal.zip`
- 本地可运行 App: `release/mac-universal/Kiro Desktop Relay.app`

Universal 包同时包含 Intel Mac 和 Apple Silicon Mac 架构。

## 首次安装

1. 打开 DMG。
2. 将 `Kiro Desktop Relay.app` 拖入 `Applications`。
3. 启动 App。
4. 如 macOS 提示未知开发者，先在 Finder 中右键 App，选择“打开”。

当前产物未签名、未公证。要让所有用户双击无提示打开，需要 Apple Developer ID 证书和 notarization。

## 使用方式

1. 保持 Kiro App 至少完成过一次登录。
2. 打开 `Kiro Desktop Relay.app`。
3. App 会自动识别当前 Mac 上的 Kiro 凭据，识别顺序：
   - `~/.aws/sso/cache/kiro-auth-token.json`
   - `~/.aws/sso/cache/kiro-auth-token-cli.json`
   - `~/.aws/sso/cache/*.json` 中符合 Kiro token 结构的文件
4. App 会自动启动本地服务：
   - Relay: `http://127.0.0.1:3920`
   - Native Gateway: `http://127.0.0.1:8000`
5. 左侧“接管目标”只显示 `Claude`；点击“应用接管”会写入 Claude 接管。
6. “总览”页是控制中心，包含服务启停、凭据来源、接管状态、配置路径和统一同步。
7. 点击“同步全部”会真实执行凭据刷新、Claude 接管写入、模型目录刷新、服务状态刷新和日志刷新，不只是重读界面状态。
8. “配置”页合并了原目标页和模型页，可写入/关闭/恢复 Claude、修复模型切换、配置角色模型并维护模型目录。
9. “诊断”页只保留 Kiro/Claude 探测结论和完整诊断 JSON。
10. “日志”页只保留操作输出和最近日志。
11. App 会每 60 秒后台检查 Kiro 凭据，并在到期前 15 分钟尝试从 Kiro IDE 缓存同步；如凭据被上游拒绝，会拉起 Kiro IDE 让用户完成登录。也可以在“总览”点击“刷新凭据”立即刷新。

## 配置与数据

App 私有数据目录：

```bash
~/Library/Application Support/kiro-codex
```

重要文件：

- `config.json`: 端口、凭据来源、账号池路径。`kiroCredsFile` 默认是 `auto`，表示在当前 Mac 自动发现 Kiro 登录凭据。
- `model-config.json`: 接管目标、可编辑模型列表、Claude 四角色映射
- `data/api-keys.json`: Claude 使用的本地壳子 Key
- `logs/relay.log`: relay 日志
- `logs/gateway.log`: native gateway 日志

Claude 配置备份目录：

```bash
~/.claude/backups
```

## 验证命令

```bash
curl -fsS http://127.0.0.1:3920/api/status
curl -fsS 'http://127.0.0.1:3920/api/models?refresh=1'
curl -fsS http://127.0.0.1:8000/health
claude -p '请只输出 OK_DESKTOP_RELAY，不要解释。' --output-format json --model sonnet --max-budget-usd 0.05 --no-session-persistence
```

## 接管目标

- `Claude`: 写入 Claude Code 接管，让 Claude Code 请求走本地 relay。

关闭接管不作为侧边栏目标显示；在“配置”页点击“关闭 Claude”会先备份当前配置，再移除 Kiro Desktop 写入的 managed 配置项。Relay / Gateway 的启停放在“总览”页。

## Claude 接管策略

- Claude 只写入 `~/.claude/settings.json`，使用 `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_BASE_URL`。
- Claude 不再写入 `ANTHROPIC_API_KEY`，避免 Claude Code 出现 `ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY both set`。
- Claude 不再写入顶层 `model` 或 `ANTHROPIC_MODEL`，避免 `/model` 切换后被 `~/.claude/settings.json` 固定项拉回旧模型。
- Relay / Gateway 是底层服务，Claude 是否接管由“配置”页独立控制。

## 回滚

在 App 中点击“恢复 Claude”，或手动恢复最近的备份：

```bash
cp ~/.claude/backups/<backup-file>.bak ~/.claude/settings.json
```

停止服务：

```bash
pkill -f "Kiro Desktop Relay.*server.mjs" || true
pkill -f "Kiro Desktop Relay.*native-gateway.mjs" || true
```

## 故障排查

- 如果 `/health` 正常但 Claude 返回 `401 Kiro 凭据文件中的 token 已失效`，先在 App 中点击“刷新凭据”；后台守护也会自动重试。只有状态显示 `requiresLogin` 或仍然 `http_401/http_403` 时，才需要打开 Kiro IDE 完成一次人工登录或重新登录。
- 如果换电脑后 Gateway / Claude / Models 三块不可用，通常不是安装包坏了，而是新电脑没有可复用的 Kiro 登录 token，或 token 没落到可读缓存。先打开 Kiro 完成登录，再点“刷新凭据”；新版会自动扫描 Kiro 常见缓存路径，不再只认固定的 `kiro-auth-token.json`。
- 如果 Claude Code 提示 `ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY both set`，在“配置”页重新点击“写入 Claude”；新版只保留 `ANTHROPIC_AUTH_TOKEN`。
- 如果 Claude Code 的 `/model` 提示已切换但重启后仍回到旧模型，点击“配置”页的“修复模型切换”；它会清除 `settings.model` 和 `ANTHROPIC_MODEL` 两个模型固定项，并把 Haiku / Sonnet / Opus / Fable 角色重置到同族最佳模型。
- 如果模型列表显示 fallback，通常是 Kiro token 未刷新或上游暂时不可达；先点击“同步全部”，或依次点击“刷新凭据”和“获取模型”。
- 如果对话中出现 `terminated`、连接中断或上游提前断开，Relay / Gateway 会尽量保持进程存活；非流式请求会自动重试一次，流式请求会结束当前 SSE 并等待下一次请求恢复。
- 如果端口被占用，App 会尝试使用后续可用端口，并在写入 Claude 时同步更新 `ANTHROPIC_BASE_URL`。
