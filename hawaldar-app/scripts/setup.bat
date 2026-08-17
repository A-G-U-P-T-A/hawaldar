@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node 22+ is required.
  exit /b 1
)
for /f "usebackq delims=" %%v in (`node -p "process.versions.node.split('.')[0]"`) do set NODE_MAJOR=%%v
if not defined NODE_MAJOR (
  echo Node 22+ is required.
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  echo Node 22+ is required ^(found Node %NODE_MAJOR%^).
  exit /b 1
)

if exist package-lock.json (
  call npm ci
) else (
  call npm install
)
if errorlevel 1 exit /b 1
node scripts\ensure-electron.mjs
if errorlevel 1 exit /b 1
echo Setup complete. Run scripts\dev.bat or npm run dev.
