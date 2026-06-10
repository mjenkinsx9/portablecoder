@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "STOP_PS1=%SCRIPT_DIR%stop-vm.ps1"

if not exist "%STOP_PS1%" (
  echo Error: missing stop script: %STOP_PS1%
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%STOP_PS1%" %*
exit /b %errorlevel%
