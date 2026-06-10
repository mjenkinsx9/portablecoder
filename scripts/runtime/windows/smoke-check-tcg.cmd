@echo off
setlocal EnableExtensions

set "PCODER_VM_ACCEL_MODE=tcg"
set "SCRIPT_DIR=%~dp0"

call "%SCRIPT_DIR%smoke-check.cmd" %*
exit /b %errorlevel%

