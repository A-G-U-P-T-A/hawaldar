@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
if not exist node_modules (
  call npm install
  if errorlevel 1 exit /b 1
)
node scripts\ensure-electron.mjs
if errorlevel 1 exit /b 1
call npm run dev
