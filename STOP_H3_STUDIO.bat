@echo off
setlocal
cd /d "%~dp0"

set "H3_STOP_SCRIPT=%CD%\scripts\stop-h3-studio.ps1"
if not exist "%H3_STOP_SCRIPT%" (
  echo [ERRORE] Helper di arresto non trovato: %H3_STOP_SCRIPT%
  set "H3_STOP_EXIT=10"
  goto :done
)

echo [H3 Studio] Arresto sicuro di interfaccia, bridge e processi figli...
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%H3_STOP_SCRIPT%" -ProjectRoot "%CD%"
set "H3_STOP_EXIT=%ERRORLEVEL%"

:done
echo.
if "%H3_STOP_EXIT%"=="0" (
  echo H3 Studio arrestato. ComfyUI non e stato toccato.
) else (
  echo [ATTENZIONE] Arresto incompleto. Leggi il dettaglio sopra.
)

if /i not "%~1"=="--no-pause" pause
endlocal & exit /b %H3_STOP_EXIT%
