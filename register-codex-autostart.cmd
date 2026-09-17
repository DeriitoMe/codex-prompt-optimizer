@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\register-codex-autostart.ps1"
set "CODE=%ERRORLEVEL%"
pause
exit /b %CODE%
