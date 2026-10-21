@echo off
setlocal
title Niveshaay Communication Center
cd /d "%~dp0"

echo.
echo  ===============================================
echo   Niveshaay Communication Center - local start
echo  ===============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install Node.js 22 LTS from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/5] Installing dependencies - first run only, this takes a few minutes...
  call npm install
  if errorlevel 1 goto :fail
) else (
  echo [1/5] Dependencies already installed.
)

if not exist ".env" (
  echo [2/5] Creating .env from .env.example...
  copy /y ".env.example" ".env" >nul
)
node scripts\wait-for.mjs ensure-key
echo [2/5] Configuration ready (.env). Live sending stays OFF unless ALLOW_LIVE_SEND=true.

node scripts\wait-for.mjs tcp 5433 1
if errorlevel 1 (
  echo [3/5] Starting the local database in a separate window - keep that window open...
  start "Niveshaay Database" /min cmd /k "npm run db:start"
  node scripts\wait-for.mjs tcp 5433 120
  if errorlevel 1 (
    echo [ERROR] The database did not start within 2 minutes. Check the "Niveshaay Database" window.
    goto :fail
  )
) else (
  echo [3/5] Database already running on port 5433.
)

echo [4/5] Applying database migrations...
call npx prisma migrate deploy
if errorlevel 1 goto :fail
rem The seed only loads labelled MOCK data into an empty database; it skips if clients exist.
call npm run db:seed
if errorlevel 1 goto :fail

node scripts\wait-for.mjs tcp 3000 1
if not errorlevel 1 (
  echo [5/5] The app is already running. Opening http://localhost:3000
  start "" "http://localhost:3000"
  goto :end
)

echo [5/5] Starting the app. The browser opens when it is ready.
echo.
echo   URL:      http://localhost:3000
echo   Sign in:  admin@niveshaay.local  /  Niveshaay@Dev2026
echo   Stop:     press Ctrl+C here, and close the "Niveshaay Database" window.
echo.
if not defined NCC_NO_BROWSER start "" /b node scripts\wait-for.mjs open http://localhost:3000/api/health 240 http://localhost:3000
call npm run dev
goto :end

:fail
echo.
echo [ERROR] Startup failed - see the messages above.
pause
exit /b 1

:end
endlocal
