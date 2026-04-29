@echo off
title Roll Together + Chatroom Updater
color 0A

echo =====================================================
echo   Roll Together + Chatroom - Auto Updater
echo =====================================================
echo.

:: Check if git is installed
where git >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Git is not installed or not in PATH.
    echo Please install Git from https://git-scm.com/download/win
    echo Then re-run this file.
    pause
    exit /b 1
)

:: Check if node is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org
    echo Then re-run this file.
    pause
    exit /b 1
)

:: Check if this is already a git repo, if not clone it
if not exist ".git" (
    echo First time setup - cloning the repo...
    echo.
    git clone https://github.com/theone4542-afk/CR-WatchParty-with-Chatroom- .
    if %errorlevel% neq 0 (
        color 0C
        echo [ERROR] Failed to clone the repo. Check your internet connection.
        pause
        exit /b 1
    )
) else (
    echo Pulling latest changes from GitHub...
    git pull origin master
    if %errorlevel% neq 0 (
        color 0C
        echo [ERROR] Git pull failed. Check your internet connection.
        pause
        exit /b 1
    )
)

echo.
echo Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

echo.
echo Building extension...
call npm run build
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Build failed. Please contact the developer.
    pause
    exit /b 1
)

echo.
color 0A
echo =====================================================
echo   Update complete!
echo =====================================================
echo.
echo Next step: Go to chrome://extensions 
echo and click the RELOAD button (circular arrow) on
echo "Roll Together + Chatroom"
echo.
echo You can copy this address:
echo chrome://extensions
echo.
pause
