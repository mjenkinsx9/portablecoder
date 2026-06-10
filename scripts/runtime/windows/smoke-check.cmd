@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "SMOKE_PS1=%SCRIPT_DIR%smoke-check.ps1"

if not exist "%SMOKE_PS1%" (
  echo Error: missing smoke check script: %SMOKE_PS1%
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SMOKE_PS1%" %*
exit /b %errorlevel%
