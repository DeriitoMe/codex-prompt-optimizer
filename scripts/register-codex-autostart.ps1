[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ExecutablePath,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder 'Context Prompt Assistant (Codex watcher).lnk'

if ($Uninstall) {
  if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host 'Removed the Codex auto-start entry.'
  } else {
    Write-Host 'No auto-start entry found.'
  }
  exit 0
}

if (-not $ExecutablePath) {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $candidate = Join-Path $repoRoot 'release\Context Prompt Assistant-0.2.0-x64-portable.exe'
  if (Test-Path -LiteralPath $candidate) { $ExecutablePath = $candidate }
}

if (-not $ExecutablePath -or -not (Test-Path -LiteralPath $ExecutablePath)) {
  throw 'Companion app not found. Use -ExecutablePath with the full path to the portable or installed executable.'
}

$resolved = (Resolve-Path -LiteralPath $ExecutablePath).Path
$shell = New-Object -ComObject 'WScript.Shell'
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $resolved
$shortcut.Arguments = '--watch-codex'
$shortcut.WorkingDirectory = Split-Path -Parent $resolved
$shortcut.Description = 'Show Context Prompt Assistant when Codex starts.'
$shortcut.Save()

Write-Host ('Codex auto-start watcher registered at: ' + $shortcutPath)
Write-Host 'The app will show after codex.exe is detected and hide after Codex exits.'
