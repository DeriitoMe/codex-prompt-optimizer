[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ExecutablePath,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder 'Context Prompt Assistant (Codex watcher).lnk'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValue = 'Context Prompt Assistant'

if ($Uninstall) {
  if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
  }
  Remove-ItemProperty -LiteralPath $runKey -Name $runValue -ErrorAction SilentlyContinue
  Write-Host 'Removed the Codex auto-start entry.'
  exit 0
}

if (-not $ExecutablePath) {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  $candidates = @(
    (Join-Path $repoRoot 'release\Context Prompt Assistant-0.4.1-x64-portable.exe'),
    (Join-Path $localAppData 'Programs\Context Prompt Assistant\Context Prompt Assistant.exe'),
    (Join-Path $localAppData 'Programs\context-prompt-assistant\Context Prompt Assistant.exe')
  )
  $ExecutablePath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

if (-not $ExecutablePath -or -not (Test-Path -LiteralPath $ExecutablePath)) {
  throw 'Companion app not found. Use -ExecutablePath with the full path to the portable or installed executable.'
}

$resolved = (Resolve-Path -LiteralPath $ExecutablePath).Path
$command = '"' + $resolved + '" --watch-codex'
New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -LiteralPath $runKey -Name $runValue -Value $command -PropertyType String -Force | Out-Null

Write-Host ('Codex auto-start watcher registered in: ' + $runKey)
Write-Host 'The app will show after codex.exe is detected and hide after Codex exits.'
