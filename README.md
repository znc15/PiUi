# Pi Agent UI

基于 [OpenCodeUI](https://github.com/lehhair/OpenCodeUI) 前端提取，并将后端替换为 [Pi coding agent](https://github.com/badlogic/pi-mono) SDK 的 Web / 桌面 UI。

## 架构

```
Browser / Tauri WebView (React UI)
   │  HTTP + SSE (+ WS for PTY)
   ▼
Pi Bridge (Hono, server/)          ← 桌面应用启动时用系统 Node 自动拉起
   │  @earendil-works/pi-coding-agent SDK
   ▼
Pi AgentSession (tools: read/bash/edit/write…)
   + ~/.pi/agent 扩展（MCP 插件等）自动加载
```

- **前端**：保留 OpenCodeUI 的完整界面（Chat / 文件树 / Diff / 终端 / 主题 / 会话管理等）
- **API 层**：已去掉 `@opencode-ai/sdk`，改为本地 `src/api/sdk.ts` HTTP 客户端
- **后端**：`server/` 用 Pi SDK 实现 OpenCode 兼容的 REST + SSE 接口
- **桌面端**：`src-tauri/`（Tauri 2，当前目标平台 macOS）
  - 启动应用时自动检测系统 Node（PATH / Homebrew / nvm / fnm / volta）并拉起内嵌 bridge
  - 检测系统 `pi` CLI 及版本，设置页展示运行环境信息
  - 未检测到 Pi 认证信息（`~/.pi/agent/auth.json` 或 API Key）时弹出配置引导

## 环境要求

| 组件 | 要求 | 说明 |
|------|------|------|
| Node.js | 20+ | 运行 bridge 必需（`brew install node`） |
| pi CLI | 可选 | `npm i -g @earendil-works/pi-coding-agent`，用于 `/login` 登录 |
| Rust | stable | 仅打包桌面应用时需要 |

## 快速开始（开发）

### 1. 安装依赖

```bash
# 前端
npm install

# Pi bridge 后端
npm --prefix server install
```

### 2. 配置 Pi 模型

Pi 使用你本机已有的 Pi 登录 / API Key（`~/.pi`）。例如：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# 或先在终端执行 pi 并 /login
```

可选工作区：

```bash
export PI_WORKSPACE=/path/to/your/project
export PORT=4096
```

### 3. 启动

**方式 A — Tauri 桌面（推荐）**

```bash
npm run tauri:dev
```

应用会自动检测 Node 并用 tsx 拉起 `server/`（无需手动起后端）。

**方式 B — 纯 Web**

```bash
# 终端 1 — Pi bridge
npm run server        # 或热重载：npm run dev:server

# 终端 2 — 前端
npm run dev
```

浏览器打开 Vite 提示的地址（默认 `http://localhost:5173`）。
开发代理会把 `/api/*` 转到后端（默认 `http://127.0.0.1:4096`，可用 `.env.local` 的 `VITE_API_BASE_URL` 覆盖）。

## 打包桌面应用（macOS）

```bash
npm run tauri:build
```

流程：前端构建 → esbuild 打包 bridge 为单文件（`src-tauri/resources/pi-bridge/index.mjs`）→ Tauri 构建 + 打包。

产物：

```
src-tauri/target/release/bundle/dmg/Pi Agent UI_0.1.0_aarch64.dmg
src-tauri/target/release/bundle/macos/Pi Agent UI.app
```

**运行要求**：目标机器需安装 Node.js 20+（应用会在 PATH、Homebrew、nvm、fnm、volta 常见位置自动查找）。首次启动若未检测到 Pi 认证信息，会显示配置引导页。

> 说明：bridge 以单文件 JS 形式随包分发，`node-pty` 为原生模块未内嵌 —— 打包版终端功能降级为 stub，其余功能完整。

## MCP 配置

MCP 服务器配置保存在 `~/.pi/agent/mcp.json`（与 pi CLI 共用），UI 的 **MCP 面板**支持查看状态、添加/连接/断开服务器。

- MCP 工具需要安装 pi 的 MCP 插件（扩展）后才能被 Agent 实际调用；bridge 通过 Pi SDK 自动加载 `~/.pi/agent` 下的扩展
- 每个 stdio 类型服务器的 `command` 必须已在本地安装（面板中出现 `Command not found` 错误即表示缺少该命令）

示例 `~/.pi/agent/mcp.json`：

```json
{
  "mcpServers": {
    "fetch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@kazuph/mcp-fetch"],
      "lifecycle": "lazy"
    }
  }
}
```

## 目录

| 路径 | 说明 |
|------|------|
| `src/` | OpenCodeUI 前端（API 层已对接 Pi bridge） |
| `server/` | Pi bridge 后端（Hono + Pi SDK） |
| `src-tauri/` | 桌面端外壳（服务管理 / 窗口 / 打包） |
| `scripts/build-bridge.mjs` | bridge 单文件打包脚本 |

## 能力映射

| UI 能力 | 后端实现 |
|---------|----------|
| 会话 CRUD / 消息流式 | Pi `AgentSession` + SSE 事件桥接 |
| 模型列表 | Pi `ModelRuntime` |
| 文件浏览 / 搜索 | 本地 FS + ripgrep |
| Diff / VCS | `git` |
| 终端 | `node-pty`（打包版降级 stub） |
| MCP | `~/.pi/agent/mcp.json` 管理 + 状态展示（工具调用依赖 pi MCP 扩展） |
| Skills / 斜杠命令 | 后续可接 Pi skills / prompt templates |

## 开发说明

- 前端类型已从 `@opencode-ai/sdk` 解耦到 `src/types/api/generated.ts`
- 事件协议保持 OpenCode UI 期望的 `session.*` / `message.*` / `message.part.delta` 形状
- 默认端口：后端 `4096`，前端 Vite 代理 `/api` → 后端
- 桌面端服务管理命令：`detect_pi_environment` / `start_pi_service` / `stop_pi_service` / `check_pi_service`
- bridge 健康检查：`GET /global/health`；Pi 认证状态：`GET /global/pi-status`

## License

GPL-3.0-only（继承 OpenCodeUI）
