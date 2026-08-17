@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
if not exist node_modules (
  call npm install
  if errorlevel 1 exit /b 1
)
node scripts\ensure-electron.mjs
if errorlevel 1 exit /b 1
call npm run typecheck
if errorlevel 1 exit /b 1
call npm run dist
set DIST_ERR=%ERRORLEVEL%
node scripts\ensure-electron.mjs
if not %DIST_ERR%==0 exit /b %DIST_ERR%
echo Dist finished. Electron binary restored for npm run dev.
