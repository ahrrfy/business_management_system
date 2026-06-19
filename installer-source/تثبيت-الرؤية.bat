@echo off
chcp 65001 > nul
REM Al-Ruya ERP Store Installer entrypoint
REM Double-click this file to install the system on this computer.
setlocal
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\install.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo Install failed (code %RC%). See %LOCALAPPDATA%\AlruyaERP\install.log
  echo.
  pause
)
exit /b %RC%
