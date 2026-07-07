# Kiro Desktop Relay

用 **Kiro 账号额度**驱动 **Claude Code** 的本地中转。Claude Code 的请求先发到本地 Relay，再经原生 Gateway 用你在本机的 Kiro 登录凭据访问上游模型，无需额外申请 API Key。

> 端到端本地运行，凭据不出本机。桌面 App 提供完整的启停、凭据、模型与接管管理界面。

---

## 特性

- **桌面控制台**（Electron）：一键启停 Relay/Gateway、查看状态、管理凭据与模型、诊断与日志。
- **自动识别 Kiro 凭据**：扫描本机 Kiro 登录缓存并自动选用；后台守护在到期前自动刷新，失效时引导重新登录。
- **Claude 接管**：一键写入 `~/.claude/settings.json`，支持 Haiku / Sonnet / Opus / Fable 四角色分别映射模型。
- **Anthropic Messages 兼容端点**：本地 `POST /v1/messages`，可直接对接 Claude Code 或其他兼容客户端。
- **纯 Node 原生 Gateway**：无需 Docker。

---

## 工作原理

```
Claude Code
   │   ANTHROPIC_BASE_URL = http://127.0.0.1:3920
   │   ANTHROPIC_AUTH_TOKEN = sk-kiro-…（本地壳子 Key）
   ▼
Relay  (server.mjs, :3920)        校验壳子 Key，转发请求
   │
   ▼
Native Gateway  (native-gateway.mjs, :8000)   用 Kiro 凭据访问上游
   │
   ▼
Kiro 上游（Claude 系列模型）
```

---

## 环境要求

- Node.js 18+（建议 LTS）
- 已安装并**至少完成过一次登录**的 Kiro（用于本地凭据发现）
- 桌面 App 目前面向 **macOS**（Electron 43，产物未签名/未公证）；Relay / Gateway 本身是纯 Node，可跨平台以命令行方式运行。

---

## 快速开始

### 方式一：桌面 App（推荐）

```bash
npm install
npm run desktop:dev            # 本地开发运行
```

打开后 App 会自动识别 Kiro 凭据并启动 Relay/Gateway，在「配置」页点「写入 Claude」即可完成接管。

打包 macOS 应用：

```bash
npm run desktop:pack           # 通用包（Intel + Apple Silicon）
npm run desktop:pack:arm64     # 仅 Apple Silicon
```

产物输出到 `release/`。

### 方式二：命令行 / 服务模式

```bash
npm install
npm run setup                  # 生成 .env 与 Gateway 密钥
npm run gateway                # 启动原生 Gateway (:8000)
npm start                      # 启动 Relay + 管理页 (:3920)
```

浏览器打开 <http://127.0.0.1:3920> 可创建 / 管理壳子 Key，并查看 Anthropic 端点配置。

---

## 配置

复制 `.env.example` 为 `.env`（或直接运行 `npm run setup` 生成）：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `KIRO_GATEWAY_KEY` | Relay ↔ Gateway 之间的内部鉴权密钥 | 自动生成 |
| `KIRO_CREDS_FILE` | Kiro 凭据文件路径，`auto` 表示自动发现 | `auto` |
| `KIRO_API_REGION` | 上游区域 | `us-east-1` |
| `GATEWAY_PORT` | Gateway 端口 | `8000` |
| `RELAY_PORT` | Relay 端口 | `3920` |
| `RELAY_HOST` | Relay 监听地址 | `0.0.0.0` |
| `KIRO_DEFAULT_REASONING_EFFORT` | 默认思考强度 | `medium` |

桌面 App 的配置与数据目录：`~/Library/Application Support/kiro-codex`
（`config.json` 端口/凭据来源、`model-config.json` 模型与角色映射、`data/` 壳子 Key、`logs/` 日志）。

---

## Claude Code 接管

桌面 App「配置」页会写入 `~/.claude/settings.json` 的 `env`：

- `ANTHROPIC_BASE_URL=http://127.0.0.1:3920`
- `ANTHROPIC_AUTH_TOKEN=sk-kiro-…`（本地壳子 Key）

不写入 `ANTHROPIC_API_KEY`，也不固定顶层 `model` / `ANTHROPIC_MODEL`，避免鉴权冲突以及 `/model` 切换后被旧配置拉回。写入前会自动备份到 `~/.claude/backups`，可在 App 中「恢复」。

---

## HTTP 端点

**Relay（`:3920`）**

- `POST /v1/messages` — Anthropic Messages 兼容端点
- `GET /api/status` — 服务、凭据、模型状态
- `GET /api/models` — 模型列表（`?refresh=1` 强制刷新）
- `GET|POST /api/keys`、`DELETE /api/keys/:id` — 壳子 Key 管理
- `GET /api/cc-switch-config` — 生成客户端配置片段

**Gateway（`:8000`）**

- `GET /health` — 健康检查
- `POST /v1/messages` — 转发到 Kiro 上游
- `GET /v1/models` — 上游模型

---

## 项目结构

```
desktop/            Electron 主进程 / 预加载 / 渲染层（管理界面 UI）
lib/                Kiro 鉴权、协议转换、模型解析、流式处理等核心库
public/             Relay 自带的轻量网页
scripts/            启停脚本与 setup
server.mjs          Relay 服务（管理 API + Anthropic 端点）
native-gateway.mjs  原生 Gateway（对接 Kiro 上游）
```

---

## 常见问题（简版）

完整说明见 [DESKTOP_MAC.md](./DESKTOP_MAC.md)。

- **凭据失效 / 401**：在 App 点「刷新凭据」；若仍失败，去 Kiro IDE 重新登录后再点「同步全部」。
- **模型显示 fallback**：通常是凭据未刷新或上游暂时不可达，先「同步全部」，或依次「刷新凭据」+「获取模型」。
- **`/model` 切换后又回到旧模型**：点「修复模型切换」，清除固定项并重置角色映射。
- **端口被占用**：App 会自动改用后续可用端口，并同步更新 Claude 的 `ANTHROPIC_BASE_URL`。

---

## 说明

- 本项目使用你**自己的 Kiro 登录额度**，请遵守 Kiro / Anthropic 的相关服务条款。
- 桌面产物未签名、未公证；首次打开如遇提示，请在 Finder 中右键 App 选择「打开」。
