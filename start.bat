@echo off
cd /d "%~dp0"
echo Starting Trading Terminal...
echo.
start "Trading Terminal Server" cmd /k "node server.js"
timeout /t 2 >nul
start "" http://127.0.0.1:4321
