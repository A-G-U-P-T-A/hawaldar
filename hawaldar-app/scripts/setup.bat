@echo off
setlocal EnableExtensions EnableDelayedExpansion
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

echo Stopping leftover Hawaldar/Electron processes ^(Cursor is left running^)...
taskkill /IM Hawaldar.exe /F >nul 2>nul
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like '*hawaldar-app*' } | Stop-Process -Force -ErrorAction SilentlyContinue"
timeout /t 1 /nobreak >nul

set "SKIP_NPM=0"
set "ASAR=node_modules\electron\dist\resources\default_app.asar"
if exist "%ASAR%" (
  ren "%ASAR%" "default_app.asar.tmpmove" >nul 2>nul
  if exist "%ASAR%" (
    echo default_app.asar is locked. Skipping npm ci/i so npm does not tear down electron.
    set "SKIP_NPM=1"
  ) else (
    ren "node_modules\electron\dist\resources\default_app.asar.tmpmove" "default_app.asar" >nul 2>nul
    echo Removing node_modules\electron for a clean install...
    rmdir /s /q node_modules\electron 2>nul
  )
)

set "NPM_ERR=1"
if "!SKIP_NPM!"=="0" (
  echo Installing dependencies...
  if exist package-lock.json (
    call npm ci
    set "NPM_ERR=!ERRORLEVEL!"
    if not "!NPM_ERR!"=="0" echo npm ci failed ^(exit !NPM_ERR!^), falling back to npm install...
  )
  if not "!NPM_ERR!"=="0" (
    call npm install
    set "NPM_ERR=!ERRORLEVEL!"
  )
) else (
  echo Skipping npm because Electron files are locked.
)

if not exist node_modules\.bin\electron-vite.cmd set "NEED_TEMP=1"
if not exist node_modules\.bin\tsc.cmd set "NEED_TEMP=1"
if not exist node_modules\electron\install.js set "NEED_TEMP=1"

if "!NEED_TEMP!"=="1" (
  echo Restoring node_modules via temp folder...
  node scripts\install-deps.mjs
  if not "!ERRORLEVEL!"=="0" (
    echo Install failed. Close Hawaldar.exe / electron.exe and run scripts\setup.bat again.
    exit /b 1
  )
)
if not exist node_modules\.bin\electron-vite.cmd (
  echo Install incomplete: node_modules\.bin\electron-vite is missing.
  exit /b 1
)
if not exist node_modules\.bin\tsc.cmd (
  echo Install incomplete: node_modules\.bin\tsc is missing.
  exit /b 1
)

node scripts\ensure-electron.mjs
if not "!ERRORLEVEL!"=="0" (
  echo Failed to restore the Electron binary.
  exit /b 1
)
echo Setup complete. Run scripts\dev.bat or npm run dev.
