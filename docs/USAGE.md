# Macaron 插件使用手册

一个 WebUI，两条命令：`mcc` 打开 Claude Code 的可视化会话管理，`mcx` 打开 OpenAI Codex 的。两者共用一份后端（同端口，默认 `7878`），根据启动命令决定挂载哪套前端。

---

## 你需要什么

| 前置 | 用途 |
| --- | --- |
| **Node ≥ 22** | 跑 `mcc` / `mcx` |
| **Claude Code CLI** | 使用 `mcc`（Claude 侧会话） |
| **Codex CLI ≥ 0.115** | 使用 `mcx`（Codex 侧会话）·  `brew install codex` 或 `npm i -g @openai/codex` |

浏览器随便，不需要 Docker，不需要 GPU。

---

## 装到 Claude Code 里（推荐）

Claude Code 有插件市场机制，Macaron 是市场的一员，装完可用 `/macaron` 一键呼出。

```bash
# 1. 在 Claude Code 里注册市场（本仓库同时是市场清单）
/plugin marketplace add https://github.com/mindverse-ltd/macaron-claude-code

# 2. 装插件
/plugin install macaron@macaron

# 3. 校验
claude plugin list
# → macaron@macaron  (commands: /macaron, skills: genui-builder)
```

装好后随时在会话里输入：

```
/macaron          # 开在默认 7878
/macaron 8080     # 指定端口
```

浏览器自动开 `http://localhost:7878`，看到的是 Claude 的 WebUI（workspaces / sessions / canvas / GenUI 预览）。

---

## 不装插件，用 npx 直跑

不想走市场机制，或者要在纯 shell 里用：

```bash
# Claude 侧 WebUI
npx https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcc@main

# Codex 侧 WebUI
npx https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcx@main
```

两个 tarball 都包含预构建的 web + bundled server，首次拉起时装几个 npm 运行时依赖就行。

也支持指定 PR / commit sha：`mcc@42`、`mcc@e285873`。

---

## 装到 Codex 里

Codex 官方没有 marketplace 机制，只需要装好 `codex` CLI 后跑 `mcx` 命令。

### 1. 装 Codex CLI

```bash
brew install codex        # macOS
# 或
npm install -g @openai/codex
codex --version           # 0.115+ 
```

### 2. 启动 Macaron for Codex

装完 Claude Code 插件后，`mcx` 命令随之可用；也可以 npx 直跑：

```bash
mcx                       # 默认 7878
mcx --port 8080
npx https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcx@main
```

打开 `http://localhost:7878` — UI 会自动进入 Codex 界面（区别于 Claude 那套，配色改成 ChatGPT 的黑白灰）。

### 3. 配 Provider

第一次进去要在 **Settings** 里填：

- **Base URL** — 你的 OpenAI-compatible 网关地址
- **API Key** — Bearer token
- **Model** — 比如 `gpt-5.5`、`gpt-4.1`
- **Wire API** — `responses`（GPT-5 家族）或 `chat`（老式）
- **Provider ID** — 记入 rollout 的 provider 名，比如 `OpenAI`
- **Reasoning effort** / **Sandbox** / **Approval policy** — 按需

配置写到 `~/.claude/macaron-codex-config.json`，跟 Claude 的 provider 配置文件是分开的。

---

## Claude 侧日常使用

### Workspaces & Sessions

侧栏按 cwd 分组显示所有 workspace，每个 workspace 里是 `~/.claude/projects/<encoded>/*.jsonl` 里的历史 session。

- 点 **workspace 名** → 进对应的 canvas 视图
- 点 **session 行** → 钉到 canvas（`+/✓`）
- 再点已钉的 → 聚焦

### Canvas（多 tile 排版）

canvas 是一个 12 列网格，每个 tile 是一个可交互的 session：

- **拖 grip 条** 换位置（有 FLIP 动画）
- **SE 角** 拖拽 resize（hover 出现）
- **点击 tile** 聚焦（focused tile 才显示输入框和 composer）
- **grip 上的按钮**：`⧉` 拷 `claude --resume`、`↻` 刷新、`×` 从 canvas 移除
- **正在跑**的 tile 顶部有 2px 流光条

同一 workspace 的 tile 布局按 project 持久到 localStorage。

### 输入框功能

- Enter 发送 · Shift+Enter 换行
- 上下箭头翻历史 prompt
- 粘贴 / 拖入图片直接附上
- 输入框顶部：模型 badge、permission mode 快捷键（Shift+Tab 循环）
- 右侧下拉菜单：`Compact`（把 session 总结压缩）、`Rewind`（回滚到某条消息之前）

### 权限门（Permission Gate）

工具执行前会弹 Allow/Deny 卡片（default mode 下）。全局 **YOLO** 开关在 Settings，打开后所有工具自动放行。

### 通知

session done 时会推浏览器 Notification（如果 tab 不在前台）。首次会请求授权。

### Provider 切换

Settings → Providers：
- **System default**：直接透传你 shell 里的 `ANTHROPIC_BASE_URL` / OAuth
- 自定义：加任意 Anthropic-compatible 端点（Macaron / OpenRouter / LiteLLM / Bedrock relay …）

切换后立即生效。

---

## Codex 侧日常使用

功能布局跟 Claude 侧对齐（sidebar + canvas + tile），只是数据源换成 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`。

### 差异点

- **没有 rewind / compact**：Codex 的 rollout 格式不同，暂未实现（Codex CLI 自己有 auto-compact）
- **没有 permission gate 弹窗**：Codex SDK 还没暴露 canUseTool callback，MVP 只能用 `approvalPolicy: never` + sandbox 保底
- **没有 GenUI 预览**：那是 Macaron 独有的 MCP tool，Codex 不认
- **Provider 只有一套**：所有 Codex 会话共用 Settings 里的那份配置

### 常用操作

一样，点 workspace 进 canvas、点 thread 钉到 canvas、grip 上 `⧉` 拷 `codex resume <sid>`。

Stop 按钮点 → 后端 `AbortController` 打断当前 turn。

---

## 端口 / 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MACARON_PORT` | 7878 | 监听端口 |
| `MACARON_HOST` | 127.0.0.1 | 绑定地址 |
| `MACARON_LOG_LEVEL` | info | fastify 日志级别 |
| `MACARON_ENGINE` | claude | `mcx` 会自动设成 `codex`；一般不用手动改 |
| `MACARON_CODEX_PATH` | 自动探测 | 指定 codex CLI 绝对路径 |
| `MACARON_API_BASE` / `MACARON_API_KEY` / `MACARON_MODEL` | — | Claude 侧 provider 环境变量兜底 |

---

## 配置文件

| 路径 | 归属 |
| --- | --- |
| `~/.claude/macaron-config.json` | Claude 侧 providers + YOLO mode |
| `~/.claude/macaron-codex-config.json` | Codex 侧 provider（base URL、model、sandbox …） |
| `localStorage: macaron.canvas.<project>` | 每个 workspace 的 canvas 布局（tile 顺序 / 尺寸 / 聚焦） |

以上都是纯 JSON，可以手动编辑；WebUI 有兜底默认值。

---

## 故障排查

**`/macaron` 报端口占用**  
另一个 mcc/mcx 进程还在跑。`lsof -ti:7878 | xargs kill` 后重开，或换端口 `/macaron 8080`。

**Codex 侧 session 没名字**  
Codex 0.115 的 rollout 头部 `session_meta` 塞了 ~16KB 的 personality prompt，早期 head cap 太小读不到第一条 `user_message`。已修复；如果自定义了 codex-store，head 至少给 256KB。

**Codex 里跑 session 报 "recorded with gpt-5.4 but resuming with gpt-5.5"**  
Warning 而已。历史 session 记录的 model 和当前 Settings 里配的不同；不影响执行，可无视，或把 Settings 里 model 改回 gpt-5.4。

**Codex `503 Service Unavailable`**  
上游网关抖动，SDK 会自动 reconnect 5 次。持续 503 就说明网关挂了，跟插件无关。

**Claude 侧滚不动 / Codex 侧滚不动**  
浏览器 hard reload（`Cmd/Ctrl+Shift+R`）。如果还不行，看 devtools console 是不是有 JS 报错阻塞了 render。

**`/plugin install` 报 SSH 错误**  
用完整 https URL，不要用 `owner/repo` 简写：

```
/plugin marketplace add https://github.com/mindverse-ltd/macaron-claude-code
```

---

## 开发

```bash
git clone https://github.com/mindverse-ltd/macaron-claude-code
cd macaron-claude-code
npm install
npm run dev            # 起 vite dev (5173) + tsx watch server (7878)
npm run build          # 生产构建
npm run typecheck      # 三个 workspace 一起
```

本地安装到 Claude Code：`claude plugin install /path/to/macaron-claude-code`。

---

## 相关链接

- 仓库：<https://github.com/mindverse-ltd/macaron-claude-code>
- Claude Agent SDK：<https://github.com/anthropics/claude-agent-sdk-typescript>
- Codex SDK：<https://github.com/openai/codex>
- Issues：<https://github.com/mindverse-ltd/macaron-claude-code/issues>
