@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-audio-cpp-voice.ps1"
if errorlevel 1 (
  echo.
  echo Installazione non completata. Consulta data\runtimes\audio-cpp\install.log
  pause
  exit /b 1
)
echo.
echo Runtime e modelli audio installati correttamente.
pause

