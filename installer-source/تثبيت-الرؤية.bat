@echo off
REM ============================================================
REM   تثبيت نظام الرؤية العربية — Al-Ru'ya ERP Store Installer
REM   اضغط مرّتين على هذا الملف لبدء التثبيت.
REM ============================================================
chcp 65001 > nul
setlocal
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo فشل التثبيت (رمز %RC%). راجع %LOCALAPPDATA%\AlruyaERP\install.log
  echo.
  pause
)
exit /b %RC%
