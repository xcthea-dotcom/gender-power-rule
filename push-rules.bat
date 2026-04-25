@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0"

set "GIT_EXE=C:\Program Files\Git\cmd\git.exe"

if not exist "%GIT_EXE%" (
  echo [ERROR] Git was not found here:
  echo %GIT_EXE%
  pause
  exit /b 1
)

echo.
echo === Current changes ===
"%GIT_EXE%" status --short
echo.

"%GIT_EXE%" add .
if errorlevel 1 (
  echo [ERROR] git add failed.
  pause
  exit /b 1
)

set "COMMIT_MSG="
set /p COMMIT_MSG=Commit message (press Enter to use "update site"): 
if "%COMMIT_MSG%"=="" set "COMMIT_MSG=update site"

echo.
echo === Committing ===
"%GIT_EXE%" commit -m "%COMMIT_MSG%"
if errorlevel 1 (
  echo.
  echo [STOP] Nothing was committed.
  echo This usually means:
  echo 1. there were no file changes, or
  echo 2. commit failed for another reason.
  echo.
  echo === git status ===
  "%GIT_EXE%" status
  pause
  exit /b 1
)

echo.
echo === Pushing to GitHub ===
"%GIT_EXE%" push
if errorlevel 1 (
  echo [ERROR] git push failed.
  pause
  exit /b 1
)

echo.
echo [OK] Push completed.
echo Vercel should start a new deployment automatically.
pause
