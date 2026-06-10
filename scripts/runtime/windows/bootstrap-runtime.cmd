@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "BOOTSTRAP_PS1=%SCRIPT_DIR%bootstrap-runtime.ps1"

if not exist "%BOOTSTRAP_PS1%" (
  echo Error: missing bootstrap script: %BOOTSTRAP_PS1%
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP_PS1%" %*
exit /b %errorlevel%
