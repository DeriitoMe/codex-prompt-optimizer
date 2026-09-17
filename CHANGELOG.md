# 更新记录

## 0.2.0 — 2026-09-17

- 增加 Windows Electron 伴随窗口：绑定 Codex 任务链接、刷新上下文、生成优化结果、复制、取消、置顶和重启恢复。
- 增加 Codex App Server 只读适配器及 `thread/list`／`thread/read` 诊断脚本。
- 增加 Codex／ChatGPT 链接解析、上下文覆盖标记、长文本截断、目标隔离和刷新失败状态。
- 增加 Codex 插件清单、只读 MCP 工具、共用 Skill、40 条验收案例和 Windows 打包配置。
- Windows 自动发现 Codex 桌面 CLI，并支持通过 `CODEX_CLI_PATH` 指定完整路径。

### 已知边界

- ChatGPT 私有链接仅在实际能力允许时读取；当前版本不承诺自动读取任意云端历史。
- 真实客户端登录、任务链接映射、独立优化会话和安装体验仍需在用户的 Windows Codex 环境人工验收。
- 本项目是第三方插件与伴随应用，不代表官方 Codex 内置功能。
