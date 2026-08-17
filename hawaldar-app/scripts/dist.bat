@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
echo Dist is a separate step. Do not chain this after scripts\dev.bat — stop dev first ^(Ctrl+C^), then run dist in a new command.
if not exist node_modules (
  call "%~dp0setup.bat"
  if errorlevel 1 exit /b 1
)
node scripts\ensure-electron.mjs
if errorlevel 1 exit /b 1
call npx tsc --noEmit -p tsconfig.node.json
if errorlevel 1 exit /b 1
call npx tsc --noEmit -p tsconfig.web.json
if errorlevel 1 exit /b 1
call npx electron-vite build
if errorlevel 1 exit /b 1
call npx electron-builder
set DIST_ERR=%ERRORLEVEL%
node scripts\ensure-electron.mjs
if not %DIST_ERR%==0 exit /b %DIST_ERR%
echo Dist finished. Electron binary restored for npm run dev.
