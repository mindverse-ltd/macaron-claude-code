# Macaron 插件使用

一个 WebUI，两条命令：`mcc` 打开 Claude Code 的会话管理，`mcx` 打开 Codex 的。

## 安装

**Claude Code**（有 marketplace）：

```
/plugin marketplace add https://github.com/mindverse-ltd/macaron-claude-code
/plugin install macaron@macaron
```

装好后在会话里 `/macaron` 一键打开 → <http://localhost:7878>

**Codex**（先装 codex CLI）：

推荐走 Codex 官方 plugin marketplace（v0.140+ 支持），装完在 codex 会话里说一句 "open macaron" 就自动拉起 WebUI：

```bash
brew install codex                                                        # 或 npm i -g @openai/codex
codex plugin marketplace add mindverse-ltd/macaron-claude-code            # 注册市场（GitHub owner/repo）
codex plugin add macaron@macaron                                          # 装 macaron 插件
```

之后在 codex 会话里 `@macaron` 或说 "open macaron webui"，Codex 会调用 `macaron-webui` skill 自动跑 `start.sh` → 打开 <http://localhost:7878>。

不想用 plugin？直接跑独立 CLI 也行：

```bash
mcx                       # 等价于装完后 skill 内部做的事
```

进去在 **Settings** 里填 Base URL / API Key / Model 就能用。

## 用什么

侧栏点 workspace 进画布，点 session 钉住（`+/✓`），画布里：

- **拖 grip 换位置** · 右下角**拉伸**改大小 · 点 tile 聚焦（focused 才有输入框）
- **grip 按钮**：`⧉` 拷 resume 命令、`↻` 刷新、`×` 收起
- 输入框：Enter 发送 / Shift+Enter 换行 / 上下箭头翻历史 / 粘贴图片直接附上
- 运行中 tile 顶部有流光条；任务结束会推浏览器通知（如果 tab 不在前台）

Claude 侧独占：Rewind、Compact、权限门弹窗、GenUI 预览、多 provider 切换。Codex 侧对应功能靠 codex CLI 自己的 sandbox / auto-compact。

## 常用环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MACARON_PORT` | 7878 | 端口 |
| `MACARON_HOST` | 127.0.0.1 | 绑定地址 |

配置文件：Claude 侧 `~/.claude/macaron-config.json`、Codex 侧 `~/.claude/macaron-codex-config.json`。都是纯 JSON，也可以手动改。

## 反馈

<https://github.com/mindverse-ltd/macaron-claude-code/issues>
