@echo off
setlocal
cd /d "%~dp0"
call npm.cmd run build
if errorlevel 1 exit /b 1
call npx.cmd vsce package --no-dependencies --allow-missing-repository
if errorlevel 1 exit /b 1
for %%f in (antigravity-chatgpt-*.vsix) do set VSIX=%%f
call "%LOCALAPPDATA%\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension "%VSIX%" --force
echo.
echo Installed %VSIX%. Reload the Antigravity window.
