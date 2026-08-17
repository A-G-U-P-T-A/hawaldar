@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

echo Stopping leftover Hawaldar/Electron (Cursor is left running)...
taskkill /IM Hawaldar.exe /F >nul 2>nul
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like '*hawaldar-app*' } | Stop-Process -Force -ErrorAction SilentlyContinue"
timeout /t 1 /nobreak >nul

if not exist "node_modules\electron-vite" (
  echo Missing node_modules. Run scripts\setup.bat once, then this script again.
  echo Do not chain setup/dev/dist. dist is a separate step after you stop dev.
  exit /b 1
)

set "ELECTRON_EXE=node_modules\electron\dist\electron.exe"
if exist "%ELECTRON_EXE%" (
  if not exist "node_modules\electron\path.txt" (
    echo electron.exe> "node_modules\electron\path.txt"
  )
  echo Electron binary present. Skipping ensure-electron.
) else (
  echo Electron binary missing. Restoring...
  node scripts\ensure-electron.mjs
  if errorlevel 1 exit /b 1
)

if not exist "node_modules\.bin\electron-vite.cmd" (
  echo electron-vite is missing. Run scripts\setup.bat once.
  exit /b 1
)

echo Starting electron-vite dev...
call node_modules\.bin\electron-vite.cmd dev
