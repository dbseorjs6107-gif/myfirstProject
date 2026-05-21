@echo off
cd /d "%~dp0"
start /b node server.js > nul 2>&1
timeout /t 3 /nobreak >nul
start chrome http://localhost:3000
exit