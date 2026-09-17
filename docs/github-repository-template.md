# GitHub 仓库创建模板

这份模板对应截图中的 GitHub `github.com/new` 页面，适用于把当前项目发布到 `DeriitoMe/codex-prompt-optimizer`。

## 新建仓库页面填写

| 字段 | 建议值 | 说明 |
|---|---|---|
| 所有者 | `DeriitoMe` | 截图中已选定的账号 |
| 仓库名称 | `codex-prompt-optimizer` | 截图输入空格后会自动规范化为这个名称 |
| 描述 | `A Windows companion app and Codex plugin for context-aware prompt optimization.` | 350 字符以内，说明第三方性质和核心用途 |
| 可见性 | `公开` | 公开后源码、文档和提交历史都可见 |
| 添加 README | 关闭 | 本地项目已有 README，避免远程先生成一次提交 |
| 添加 .gitignore | `无` | 本地项目已有 `.gitignore` |
| 添加许可证 | `无` | 本地项目已有 MIT `LICENSE` 文件 |

确认这些字段后点击“创建存储库”。不要在 GitHub 表单中粘贴 API Key、Codex token、`auth.json`、Cookie 或真实项目私密对话内容。

## 首次推送本地项目

仓库创建完成后，在 PowerShell 中执行：

```powershell
cd D:\CodexProjects\context-prompt-assistant
git init -b main
git add .
git status
git commit -m "Release context prompt assistant 0.3.0"
git remote add origin https://github.com/DeriitoMe/codex-prompt-optimizer.git
git push -u origin main
git tag v0.3.0
git push origin v0.3.0
```

如果本地已经初始化过 Git，不要重复执行 `git init` 或 `git remote add`；先用 `git remote -v` 检查远程地址。

## GitHub Release 建议

源码仓库中保留源码和构建配置，Windows 安装包放在 GitHub Release 的附件中：

- `Context Prompt Assistant-0.3.0-x64-setup.exe`
- `Context Prompt Assistant-0.3.0-x64-portable.exe`
- `context-prompt-assistant-v0.3.0.zip`

Release 标题建议为 `v0.3.0 — Windows companion app and Codex plugin`。发布说明必须明确：这是第三方项目；Codex App Server 历史读取需要本地账号和客户端实测；ChatGPT 私有链接暂不保证自动读取。

## 推送前检查

```powershell
npm run check
npm test
npm run validate
git status --ignored
```

重点确认以下内容没有被加入提交：

- `.env`、`auth.json`、Codex 或 ChatGPT 登录缓存。
- API Key、访问令牌、Cookie、项目私密链接和真实对话导出。
- `node_modules/`、`.cache/` 和临时构建缓存。
- 不打算放在源码仓库中的本地安装包或个人测试数据。

首次 push 后，在 GitHub 的 Actions 页面确认 `Verify` 工作流通过，再创建 Release。不要把“GitHub 仓库创建成功”描述为“已通过 Codex 官方插件市场审核”；两者是不同流程。
