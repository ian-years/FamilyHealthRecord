@echo off
rem ============================================================
rem  Personal Health Records Workbench - local launcher (Windows)
rem  This file is intentionally ASCII-only to avoid encoding issues.
rem  It starts server.py, which serves the app on 127.0.0.1 and
rem  optionally bridges to the local parsing tool.
rem ============================================================
cd /d "%~dp0"
chcp 65001 >nul

set "PY="
where py >nul 2>nul
if not errorlevel 1 set "PY=py -3"
where python >nul 2>nul
if not errorlevel 1 if not defined PY set "PY=python"

if not defined PY goto nopython

%PY% "server.py" --port 8765
echo.
echo Server stopped.
pause
exit /b 0

:nopython
echo.
echo [ERROR] Python 3 was not found on this computer.
echo.
echo   1. Install Python 3.8 or newer from https://www.python.org/downloads/
echo   2. During setup, tick "Add python.exe to PATH".
echo   3. Then run this file again.
echo.
echo The workbench needs Python only to serve the page locally, because
echo browsers disable local database access for file:// pages.
echo.
pause
exit /b 1
