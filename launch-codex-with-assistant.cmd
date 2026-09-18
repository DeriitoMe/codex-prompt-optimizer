@echo off
setlocal
set "APP=%~dp0release\Context Prompt Assistant-0.4.0-x64-portable.exe"
if not exist "%APP%" set "APP=%LOCALAPPDATA%\Programs\Context Prompt Assistant\Context Prompt Assistant.exe"
if not exist "%APP%" set "APP=%LOCALAPPDATA%\Programs\context-prompt-assistant\Context Prompt Assistant.exe"
if not exist "%APP%" (
  echo Context Prompt Assistant was not found.
  echo Install the app or place the portable package in the release folder.
  pause
  exit /b 1
)
start "" "%APP%" --launch-codex
endlocal
