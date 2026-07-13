# Macaron artifacts 使用

一个 WebUI，Claude Code 和 Codex 两侧都能装，可同时开。装完在 CLI 里一句话拉起：

- Claude → <http://localhost:7878>
- Codex → <http://localhost:7979>

## 安装

### Claude Code

```
/plugin marketplace add https://github.com/MindLab-Research/macaron-artifacts
/plugin install macaron@macaron
```

装完在会话里 `/macaron` 打开。

### Codex

```bash
codex plugin marketplace add https://github.com/MindLab-Research/macaron-artifacts
codex plugin add macaron@macaron
```

装完在会话里说 `open macaron web ui` 打开。

### 不装插件，一句 bunx 拉起

发布的 tarball 自带预构建的 server + web 产物，并暴露两个 bin —— `mcc`（Claude WebUI，端口 `7878`）和 `mcx`（Codex WebUI，端口 `7979`）。任选一个一句话拉起：

```bash
bunx mcc@https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcc@<sha>   # Claude → http://localhost:7878
bunx mcx@https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcc@<sha>   # Codex  → http://localhost:7979
```

`bunx` 按 bin 名解析，所以 `mcx@…` 会从同一个 `mcc` 包里跑起 Codex 启动器。`npx` 按包名解析，用独立的 `mcx` 包即可：

```bash
npx mcc@https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcc@<sha>   # Claude → http://localhost:7878
npx mcx@https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcx@<sha>   # Codex  → http://localhost:7979
```

`<sha>` 换成 `main` 上的某个 commit。两个 bin 都支持 `--host` / `--port`，`--help` 看全部参数。

## 使用

进 WebUI 后：

- 侧栏点 workspace 进画布，session 用 `+` 钉住
- 画布里：拖 grip 换位置、右下角拉伸改大小、点 tile 聚焦
- 输入框：Enter 发送 · Shift+Enter 换行 · ↑↓ 翻历史 · 粘贴图片直接附上

首次 Codex 侧要在 **Settings** 里填 Base URL / API Key / Model。

## 更新

### Claude Code

```
/plugin update macaron
```

### Codex

```bash
codex plugin marketplace upgrade macaron   # 拉最新版本
codex plugin remove macaron@macaron
codex plugin add macaron@macaron           # 重装
```

## 反馈

<https://github.com/MindLab-Research/macaron-artifacts/issues>
