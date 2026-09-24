# Context Prompt Assistant

面向 Windows Codex 用户的第三方提示词优化伴随应用，同时提供可安装的 Codex 插件。你可以把 Codex 任务链接绑定到小窗口，每次输入口语化原话，应用会在生成前刷新可访问的上下文，再用 Codex 的只读优化会话给出可复制的提示词。

应用只生成文本，不会修改目标项目、续跑源任务或自动发送结果。它使用你当前 Codex CLI 的登录状态，不要求单独配置模型 API Key；优化调用固定使用 `gpt-6-luna` 和 `high` 推理强度。请使用支持 GPT-6 Luna 的 Codex CLI 版本；模型是否可用也取决于账号计划和工作区设置。Codex 的 `chatgpt.com/s/cx_...` 分享链接是只读快照；伴随窗口会尝试读取分享页中实际可见的文本。快照不会随原任务更新，无法访问时会明确降级。普通 ChatGPT 私有链接仍不能承诺读取任意云端历史。

## 当前版本

0.4.1 已包含：

- Electron 伴随窗口：链接绑定、刷新状态、提示词输入、复制、Ctrl+Enter、置顶。
- 随 Codex 自动显示时，助手会在鼠标所在显示器的右侧工作区弹出并垂直居中；手动打开仍沿用上次窗口位置。
- Codex 只读优化调用：通过 `codex exec --model gpt-6-luna --config model_reasoning_effort="high" --json --sandbox read-only --ephemeral` 生成结果。
- 共用上下文核心：Codex 目标解析、数组消息提取、稳定目标标识、截断和失败状态。
- Codex 插件：`resolve_context_target`、`read_context`、`refresh_context` 三个只读 MCP 工具及共用 Skill。
- Windows NSIS／便携包构建配置、GitHub Actions 校验、MIT 许可证和人工验收清单。
- `test/cases.json` 中的 40 条固定验收案例，覆盖保真、指代、刷新、隔离和异常。
- 简单优化／专业化优化模式，以及可持久化的浅色／黑色完整主题。
- 使用原创“提示卡片＋精炼闪光”图标，应用、窗口和托盘共用同一视觉识别。

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

如果 PowerShell 提示找不到 `codex`，先打开一次 Codex 桌面客户端；应用会自动检查 `%LOCALAPPDATA%\OpenAI\Codex\bin`。仍找不到时，可临时指定完整路径：

```powershell
$env:CODEX_CLI_PATH = "$env:LOCALAPPDATA\OpenAI\Codex\bin\<版本目录>\codex.exe"
node scripts/app-server-diagnostics.mjs
```

不要把 `auth.json`、访问令牌或任何凭据提交到仓库；诊断输出只反馈状态、线程 ID 和轮次统计。

启动窗口：

```powershell
npm.cmd run dev
```

插件被调用时不会自动弹出 Electron 窗口：Skill/MCP 运行在 Codex 对话内，伴随窗口是独立客户端。日常使用请从开始菜单启动已安装的 `Context Prompt Assistant`，或在项目目录运行上面的命令；安装包位于 `release/`。

如果 `npm run dev` 后没有看到窗口，可直接运行 `node_modules\\electron\\dist\\electron.exe .` 检查开发环境，或启动 `release\\Context Prompt Assistant-0.4.1-x64-portable.exe`。窗口创建后会在 Codex 旁边独立显示，不会嵌入 Codex 主窗口。

如果 PowerShell 报“禁止运行 npm.ps1”，这是执行策略拦截了 PowerShell shim，项目本身还没有启动。可以使用上面的 `npm.cmd run dev`，或者只对当前窗口临时放行：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
npm run dev
```

也可以双击仓库根目录的 `open-companion.cmd`。

如果希望从一个入口同时启动 Codex 和助手，可双击仓库根目录的 `launch-codex-with-assistant.cmd`；已安装版本优先使用安装路径，找不到时再检查 `release/` 中的便携包。应用内托盘菜单也提供相同的“启动 Codex 并显示助手”操作。

### 随 Codex 启动自动打开

自动弹窗需要一个在 Windows 登录时运行的轻量监视器。它不会修改 Codex，也不会向任务发送消息；检测到 `codex.exe` 后才显示伴随窗口，Codex 关闭后窗口隐藏。推荐在应用“设置”中开启；命令行脚本也会写入当前用户的启动项（无需管理员权限）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\register-codex-autostart.ps1 `
  -ExecutablePath (Resolve-Path '.\\release\\Context Prompt Assistant-0.4.1-x64-portable.exe').Path
```

移除自动启动项：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\register-codex-autostart.ps1 -Uninstall
```

也可以直接双击仓库根目录的 `register-codex-autostart.cmd` 注册，或双击 `unregister-codex-autostart.cmd` 移除，避免 PowerShell 多行命令输入问题。旧版本创建的同名启动快捷方式也会在移除时一并清理。

如果从其他目录执行 PowerShell，必须使用绝对路径；例如：

```powershell
$repoRoot = 'C:\path\to\context-prompt-assistant'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$repoRoot\scripts\register-codex-autostart.ps1" -ExecutablePath "$repoRoot\release\Context Prompt Assistant-0.4.1-x64-portable.exe"
```

这是可选的 Windows 启动项，不会在你未执行注册命令时改变系统设置。

构建 Windows 安装包和便携包：

```powershell
npm run package:win
```

输出在 `release/`。当前个人版构建默认不做 Windows 代码签名，首次启动可能显示系统的未知发布者提示；正式公开分发前应配置自己的签名证书。构建机需要能下载 Electron 二进制；网络受限时可先运行不依赖 Electron 的三项检查。

构建完成后可生成 SHA-256 校验值，确认安装包没有被传输或替换：

```powershell
npm.cmd run verify:release
```

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
- ChatGPT `/c/...` 和 `/share/...` 暂不自动读取历史。Codex 的 `/s/cx_...` 会识别为共享快照，并尝试通过隔离的伴随浏览器读取公开页面文本。
- “置顶”只控制伴随窗口，不会修改 Codex 主窗口。
- 没有把优化结果自动回填或发送到目标对话，避免越过用户确认。
- npm 审计当前提示来自 Electron 构建链的依赖风险；发布前应复核锁文件和升级窗口版本。

## 参考

- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI 插件文档](https://learn.chatgpt.com/docs/build-plugins)
- [openai/codex](https://github.com/openai/codex)
- [dfones288/codex-desktop](https://github.com/dfones288/codex-desktop)
- [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer)
