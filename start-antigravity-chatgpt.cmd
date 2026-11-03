@echo off
setlocal
cd /d "%~dp0"
call npm.cmd run build
if errorlevel 1 exit /b 1
call npx.cmd vsce package --no-dependencies --allow-missing-repository
if errorlevel 1 exit /b 1
for %%f in (antigravity-chatgpt-*.vsix) do set "VSIX=%%f"
set "AGY=%LOCALAPPDATA%\Programs\Antigravity IDE\bin\antigravity-ide.cmd"
rem Older local builds used a different publisher; remove them so two copies
rem cannot register the same commands and proxies at once.
call "%AGY%" --uninstall-extension local.antigravity-chatgpt >nul 2>&1
call "%AGY%" --install-extension "%VSIX%" --force
echo.
echo Installed %VSIX%. Reload the Antigravity window.
