@echo off
setlocal
cd /d "%~dp0"

net session >nul 2>nul
if not "%ERRORLEVEL%"=="0" (
  echo [H3 Studio] Richiesta autorizzazione amministratore...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\enable-h3-studio-lan-firewall.ps1"
if errorlevel 1 (
  echo.
  echo [ERRORE] Configurazione Firewall non completata.
) else (
  echo.
  echo Ora ricarica H3 Studio dal dispositivo remoto.
)
pause
endlocal
