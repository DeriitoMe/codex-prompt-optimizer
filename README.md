# Context Prompt Assistant

面向 Windows Codex 用户的第三方提示词优化伴随应用，同时提供可安装的 Codex 插件。你可以把 Codex 任务链接绑定到小窗口，每次输入口语化原话，应用会在生成前刷新可访问的上下文，再用 Codex 的只读优化会话给出可复制的提示词。

应用只生成文本，不会修改目标项目、续跑源任务或自动发送结果。它使用你当前 Codex CLI 的登录状态，不要求单独配置模型 API Key。ChatGPT 私有链接目前只做解析和诚实的不可访问提示，不能承诺读取任意云端历史。

## 当前版本

0.2.0 已包含：

- Electron 伴随窗口：链接绑定、刷新状态、提示词输入、复制、Ctrl+Enter、置顶。
- Codex 只读优化调用：通过 `codex exec --json --sandbox read-only --ephemeral` 生成结果。
- 共用上下文核心：Codex 目标解析、数组消息提取、稳定目标标识、截断和失败状态。
- Codex 插件：`resolve_context_target`、`read_context`、`refresh_context` 三个只读 MCP 工具及共用 Skill。
- Windows NSIS／便携包构建配置、GitHub Actions 校验、MIT 许可证和人工验收清单。
- `test/cases.json` 中的 40 条固定验收案例，覆盖保真、指代、刷新、隔离和异常。

这是可审查的首个桌面版本；真实 App Server 历史读取和客户端安装仍需在用户的 Codex 环境中人工验收。

## 开发与测试

要求 Node.js 20+。首次安装依赖：

```powershell
npm ci
```

检查核心和插件：

```powershell
npm run check
npm test
npm run validate
```

启动窗口：

```powershell
npm run dev
```

构建 Windows 安装包和便携包：

```powershell
npm run package:win
```

输出在 `release/`。构建机需要能下载 Electron 二进制；网络受限时可先运行不依赖 Electron 的三项检查。

## 使用

1. 启动应用，在“上下文目标”粘贴 Codex 任务或对话链接并绑定。
2. 查看目标 ID、读取轮次和覆盖状态。不可读时不要把结果当作已参考历史。
3. 输入待优化原话，点击“优化提示词”或按 Ctrl+Enter。
4. 复制结果，回到目标 Codex 对话自行决定是否执行。

应用在每次提交前重新读取目标。刷新失败会标记缓存过期；不会静默把旧记录冒充最新上下文。多个任务不能自动混合，需重新绑定具体目标。

## Codex 插件

插件清单在 `.codex-plugin/plugin.json`，MCP 配置在 `.mcp.json`。按 Codex 当前客户端提供的本地插件或 Marketplace 流程加载插件目录。Skill 也可在当前对话中直接调用，但它不是桌面窗口的替代品。

App Server 读取默认尝试 `codex app-server proxy`。需要独立进程测试时，显式设置：

```powershell
$env:CODEX_PROMPT_ASSISTANT_APP_SERVER_MODE = 'spawn'
$env:CODEX_PROMPT_ASSISTANT_ALLOW_SPAWN = '1'
```

连接失败会返回结构化的不可用状态和回到原对话的调用文字。不会使用浏览器 Cookie、网页抓取或未公开接口。

## 目录

- `desktop/`：Electron 主进程、受限 preload 和窗口界面。
- `scripts/context.mjs`：链接解析、消息规范化、覆盖和指纹。
- `scripts/optimizer.mjs`：只读 Codex 优化会话和事件解析。
- `scripts/app-server-diagnostics.mjs`：人工验证登录、线程列表和 `thread/read` 的只读诊断命令。
- `scripts/server.mjs`：插件的只读 MCP 服务。
- `skills/context-prompt-assistant/`：Skill 规则和输出约定。
- `docs/acceptance-checklist.md`：真实客户端、窗口和安全边界验收清单。
- `docs/github-repository-template.md`：GitHub 新建仓库字段、首次推送和发布注意事项。

## 已知限制

- App Server 只能读取当前账号和服务实际开放的已存 Codex 线程；解析链接不等于历史已读。
- ChatGPT `/c/...` 和 `/s/...` 链接暂不自动读取私有内容。
- “置顶”只控制伴随窗口，不会修改 Codex 主窗口。
- 没有把优化结果自动回填或发送到目标对话，避免越过用户确认。
- npm 审计当前提示来自 Electron 构建链的依赖风险；发布前应复核锁文件和升级窗口版本。

## 参考

- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI 插件文档](https://learn.chatgpt.com/docs/build-plugins)
- [openai/codex](https://github.com/openai/codex)
- [dfones288/codex-desktop](https://github.com/dfones288/codex-desktop)
- [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer)
