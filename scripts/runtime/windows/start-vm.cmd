@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "START_PS1=%SCRIPT_DIR%start-vm.ps1"

if not exist "%START_PS1%" (
  echo Error: missing start script: %START_PS1%
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%START_PS1%"
exit /b %errorlevel%
