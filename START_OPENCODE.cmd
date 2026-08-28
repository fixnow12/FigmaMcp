@echo off
setlocal
for %%I in ("%~dp0.") do set "PROJECT_DIR=%%~fI"
cd /d "%PROJECT_DIR%"

where opencode >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  opencode %*
  exit /b %ERRORLEVEL%
)

set "OPENCODE_EXE=%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe"
if exist "%OPENCODE_EXE%" (
  "%OPENCODE_EXE%" %*
  exit /b %ERRORLEVEL%
)

echo OpenCode не найден в PATH.
echo Установите OpenCode и снова запустите этот файл.
exit /b 1
