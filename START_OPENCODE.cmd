@echo off
setlocal
for %%I in ("%~dp0.") do set "PROJECT_DIR=%%~fI"
cd /d "%PROJECT_DIR%"

where opencode >nul 2>nul
if errorlevel 1 goto fallback
call opencode %*
exit /b %ERRORLEVEL%

:fallback
set "OPENCODE_EXE=%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe"
if not exist "%OPENCODE_EXE%" goto missing
"%OPENCODE_EXE%" %*
exit /b %ERRORLEVEL%

:missing
echo OpenCode не найден в PATH.
echo Установите OpenCode и снова запустите этот файл.
exit /b 1
