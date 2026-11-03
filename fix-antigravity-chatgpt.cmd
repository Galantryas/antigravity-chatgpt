@echo off
setlocal
title Antigravity ChatGPT - repair
echo.
echo This repairs an Antigravity install that was left pointing at the dead
echo local ChatGPT proxy, and removes the old extension build.
echo.
echo Close Antigravity completely before continuing.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-antigravity-chatgpt.ps1"
if errorlevel 1 goto :error

set "AGY=%LOCALAPPDATA%\Programs\Antigravity IDE\bin\antigravity-ide.cmd"
if exist "%AGY%" (
  echo Removing the old local extension build...
  call "%AGY%" --uninstall-extension local.antigravity-chatgpt >nul 2>&1
) else (
  echo Could not find the Antigravity IDE command line tool at:
  echo   %AGY%
  echo Remove the extension from the Extensions view instead.
)

set "VSIX="
for %%f in ("%~dp0antigravity-chatgpt-*.vsix") do set "VSIX=%%~ff"
if defined VSIX (
  if exist "%AGY%" (
    echo Installing %VSIX%...
    call "%AGY%" --install-extension "%VSIX%" --force
  ) else (
    echo.
    echo Install %VSIX% manually after Antigravity starts.
  )
) else (
  echo.
  echo No antigravity-chatgpt-*.vsix file was found next to this script.
  echo Install the latest VSIX manually after Antigravity starts.
)

echo.
echo Done. Start Antigravity, sign in with Google, then run
echo "Antigravity ChatGPT: Sign in with ChatGPT".
pause
exit /b 0

:error
echo.
echo Repair failed. See the message above.
pause
exit /b 1
