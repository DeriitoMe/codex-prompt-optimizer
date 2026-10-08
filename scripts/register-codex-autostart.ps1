[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ExecutablePath,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder 'Context Prompt Assistant (Codex watcher).lnk'
$runKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run'
$runValue = 'Context Prompt Assistant'

if ($Uninstall) {
  if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
  }
  & reg.exe DELETE $runKey /v $runValue /f 2>$null | Out-Null
  if ($LASTEXITCODE -gt 1) { throw 'Could not remove the Run registry value.' }
  Write-Host 'Removed the Codex auto-start entry.'
  exit 0
}

if (-not $ExecutablePath) {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  $candidates = @(
    (Join-Path $localAppData 'Programs\Context Prompt Assistant\Context Prompt Assistant.exe'),
    (Join-Path $localAppData 'Programs\context-prompt-assistant\Context Prompt Assistant.exe'),
    (Join-Path $repoRoot 'release\Context Prompt Assistant-0.4.2-x64-portable.exe')
  )
  $ExecutablePath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

if (-not $ExecutablePath -or -not (Test-Path -LiteralPath $ExecutablePath)) {
  throw 'Companion app not found. Use -ExecutablePath with the full path to the portable or installed executable.'
}

$resolved = (Resolve-Path -LiteralPath $ExecutablePath).Path
$command = '"' + $resolved + '" --watch-codex'
& reg.exe ADD $runKey /v $runValue /t REG_SZ /d $command /f | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not register the Run registry value.' }

Write-Host ('Codex auto-start watcher registered in: HKCU:\' + $runKey)
Write-Host 'The app will show after codex.exe is detected and hide after Codex exits.'
