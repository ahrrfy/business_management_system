@echo off
chcp 65001 > nul
setlocal
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\uninstall.ps1"
pause
exit /b %ERRORLEVEL%
