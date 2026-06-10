@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
set "PORTABLE_NODE=%REPO_ROOT%\runtime\node\node.exe"

if not exist "%PORTABLE_NODE%" goto :try_system_node
"%PORTABLE_NODE%" "%SCRIPT_DIR%pcoder.cjs" %*
exit /b %errorlevel%

:try_system_node
where node >nul 2>nul
if not %errorlevel% equ 0 goto :no_node
node "%SCRIPT_DIR%pcoder.cjs" %*
exit /b %errorlevel%

:no_node
echo Error: node not found. Bundle runtime\node or install node in PATH.
exit /b 1
