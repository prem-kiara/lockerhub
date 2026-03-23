@echo off
echo.
echo   LockerHub - Locker Management System
echo   =====================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo   ERROR: Node.js is not installed!
    echo   Please download and install from: https://nodejs.org
    echo.
    pause
    exit /b
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo   Installing dependencies (first time only)...
    npm install
    echo.
)

:: Run setup if no database exists
if not exist "data\lockerhub.db" (
    echo   First run detected! Starting setup wizard...
    echo.
    node server.js &
    timeout /t 2 >nul
    node setup.js
    echo.
    echo   Server is running! Open http://localhost:8080 in your browser.
) else (
    echo   Starting server...
    node server.js
)

pause
