@echo off
cd /d "%~dp0.."
where node >nul 2>&1 || (echo Install Node.js first. & pause & exit /b 1)
if not exist "node_modules\ws" call npm ci
if errorlevel 1 (pause & exit /b 1)
choice /c QS /t 5 /d Q /m "Q = all tools with private queue, S = standard tools only"
if errorlevel 2 (set "tester_mode=--standard") else (set "tester_mode=")
node manual/server.mjs --open %tester_mode%
if errorlevel 1 pause
