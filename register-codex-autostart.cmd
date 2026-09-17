@echo off
setlocal
set "APP=%~dp0release\Context Prompt Assistant-0.2.0-x64-portable.exe"
if not exist "%APP%" (
  echo Portable app not found:
  echo %APP%
  echo Build the app first or edit this file to point to the installed executable.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\register-codex-autostart.ps1" -ExecutablePath "%APP%"
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" pause
exit /b %CODE%
