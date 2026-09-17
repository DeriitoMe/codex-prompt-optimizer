[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ExecutablePath,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupFolder "Context Prompt Assistant (Codex watcher).lnk"

if ($Uninstall) {
  if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "已移除 Codex 自动启动项。"
  } else {
    Write-Host "未找到自动启动项。"
  }
  exit 0
}

if (-not $ExecutablePath) {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $candidate = Join-Path $repoRoot "release\Context Prompt Assistant-0.2.0-x64-portable.exe"
  if (Test-Path -LiteralPath $candidate) { $ExecutablePath = $candidate }
}

if (-not $ExecutablePath -or -not (Test-Path -LiteralPath $ExecutablePath)) {
  throw "找不到伴随应用。请用 -ExecutablePath 指定 Context Prompt Assistant.exe 或 portable.exe 的完整路径。"
}

$resolved = (Resolve-Path -LiteralPath $ExecutablePath).Path
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $resolved
$shortcut.Arguments = "--watch-codex"
$shortcut.WorkingDirectory = Split-Path -Parent $resolved
$shortcut.Description = "在 Codex 进程启动时打开 Context Prompt Assistant"
$shortcut.Save()

Write-Host "已启用 Codex 自动启动监视：$shortcutPath"
Write-Host "应用会在检测到 codex.exe 后显示窗口；关闭 Codex 后窗口会隐藏。"
