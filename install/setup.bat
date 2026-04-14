@echo off
echo TrashApp Mastermind -- PC Setup
echo ==================================

REM Check Node.js
node --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
  echo Node.js not found. Please install from nodejs.org then re-run this script.
  start https://nodejs.org
  pause
  exit /b 1
)
echo Node.js found

REM Set install directory
SET INSTALL_DIR=%USERPROFILE%\Desktop\Trashapp\Mastermind

REM Clone or pull repo
IF EXIST "%INSTALL_DIR%" (
  echo Mastermind folder found - pulling latest...
  cd /d "%INSTALL_DIR%" && git pull origin main
) ELSE (
  echo Cloning Mastermind repo...
  mkdir "%USERPROFILE%\Desktop\Trashapp"
  git clone https://github.com/isaak-stack/trashapp-mastermind.git "%INSTALL_DIR%"
  cd /d "%INSTALL_DIR%"
)

REM Install dependencies
echo Installing dependencies...
cd /d "%INSTALL_DIR%" && npm install

REM Create .env if missing
IF NOT EXIST "%INSTALL_DIR%\.env" (
  copy "%INSTALL_DIR%\.env.example" "%INSTALL_DIR%\.env"
  echo.
  echo ACTION REQUIRED: Fill in your .env file
  echo Open: %INSTALL_DIR%\.env
  notepad "%INSTALL_DIR%\.env"
)

REM Verify installation
echo Running verification...
node "%INSTALL_DIR%\install\verify.js"

REM Install service
node "%INSTALL_DIR%\install-service.js"

echo.
echo TrashApp AI OS installed successfully
echo Dashboard: http://localhost:3000
pause
