@echo off
setlocal
cd /d "%~dp0"

set "H3_CODEX_NODE_DIR=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
set "H3_NODE_OK=0"

where node.exe >nul 2>nul
if not errorlevel 1 (
  node -e "const [major,minor,patch]=process.versions.node.split('.').map(Number); const ok=major>22||(major===22&&(minor>16||(minor===16&&patch>=0))); process.exit(ok?0:1)" >nul 2>nul
  if not errorlevel 1 set "H3_NODE_OK=1"
)

if "%H3_NODE_OK%"=="0" if exist "%H3_CODEX_NODE_DIR%\node.exe" (
  set "PATH=%H3_CODEX_NODE_DIR%;%PATH%"
  node -e "const [major,minor,patch]=process.versions.node.split('.').map(Number); const ok=major>22||(major===22&&(minor>16||(minor===16&&patch>=0))); process.exit(ok?0:1)" >nul 2>nul
  if not errorlevel 1 (
    set "H3_NODE_OK=1"
    echo [H3 Studio] Uso il runtime Node incluso in Codex.
  )
)

if "%H3_NODE_OK%"=="0" (
  echo [ERRORE] Serve Node.js 22.16.0 o superiore. Installalo da https://nodejs.org/
  pause
  exit /b 1
)

node -e "console.log('[H3 Studio] Node '+process.versions.node)"

if not exist "node_modules" (
  echo [H3 Studio] Prima installazione delle dipendenze...
  call npm install
  if errorlevel 1 (
    echo [ERRORE] Installazione dipendenze fallita.
    pause
    exit /b 1
  )
)

set "H3_BRIDGE_HOST_RESOLVED="
set "H3_BRIDGE_PORT_RESOLVED="
set "H3_BRIDGE_URL_RESOLVED="
for /f "tokens=1,2,3" %%H in ('node --env-file-if-exists=.env -e "const rawHost=String(process.env.H3_BRIDGE_HOST??'').trim();const host=rawHost.length?rawHost:'127.0.0.1';const parsed=Number.parseInt(String(process.env.H3_BRIDGE_PORT??''),10);const port=Number.isInteger(parsed)&&parsed>0&&parsed<=65535?parsed:8787;if (!/^[A-Za-z0-9._:-]+$/.test(host)) process.exit(2);const target=host==='0.0.0.0'?'127.0.0.1':host==='::'?'::1':host;const url='http://'+(target.includes(':')?'['+target+']':target)+':'+port;console.log(host,port,url)"') do (
  set "H3_BRIDGE_HOST_RESOLVED=%%H"
  set "H3_BRIDGE_PORT_RESOLVED=%%I"
  set "H3_BRIDGE_URL_RESOLVED=%%J"
)
if not defined H3_BRIDGE_HOST_RESOLVED (
  echo [ERRORE] H3_BRIDGE_HOST o H3_BRIDGE_PORT non validi.
  pause
  exit /b 1
)

echo [H3 Studio] Verifica bridge precedente su %H3_BRIDGE_HOST_RESOLVED%:%H3_BRIDGE_PORT_RESOLVED%...
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%CD%\scripts\prepare-bridge-port.ps1" -ProjectRoot "%CD%" -HostAddress "%H3_BRIDGE_HOST_RESOLVED%" -Port %H3_BRIDGE_PORT_RESOLVED%
set "H3_BRIDGE_PREFLIGHT_EXIT=%ERRORLEVEL%"
set "H3_BRIDGE_REUSE=0"
if "%H3_BRIDGE_PREFLIGHT_EXIT%"=="25" set "H3_BRIDGE_REUSE=1"
if not "%H3_BRIDGE_PREFLIGHT_EXIT%"=="0" if not "%H3_BRIDGE_PREFLIGHT_EXIT%"=="25" (
  echo [ERRORE] L'endpoint bridge non puo essere preparato in sicurezza.
  echo Chiudi il processo indicato sopra oppure verifica la configurazione H3_BRIDGE_HOST/H3_BRIDGE_PORT.
  pause
  exit /b 1
)

if "%H3_BRIDGE_REUSE%"=="0" (
  echo [H3 Studio] Avvio bridge su %H3_BRIDGE_URL_RESOLVED%
  start "H3 Studio - Bridge" cmd /c "cd /d ""%~dp0"" && node --env-file-if-exists=.env node_modules\tsx\dist\cli.mjs bridge\server.ts"
) else (
  echo [H3 Studio] Bridge gia attivo: avvio soltanto l'interfaccia.
)

echo [H3 Studio] Avvio interfaccia su http://localhost:3000
start "H3 Studio - Web" cmd /k "cd /d ""%~dp0"" && node_modules\.bin\vinext.cmd dev --hostname 127.0.0.1"

if /i "%H3_ENABLE_TAILSCALE%"=="1" (
  where tailscale.exe >nul 2>nul
  if errorlevel 1 (
    echo [AVVISO] Tailscale richiesto ma tailscale.exe non e nel PATH.
  ) else (
  tailscale.exe serve --bg --yes --https=443 http://127.0.0.1:3000
  tailscale.exe serve --bg --yes --https=%H3_BRIDGE_PORT_RESOLVED% %H3_BRIDGE_URL_RESOLVED%
  )
)

timeout /t 5 /nobreak >nul
start "" "http://localhost:3000"

echo.
echo H3 Studio avviato. Lascia aperte le due console.
echo Locale:    http://localhost:3000
echo Al primo avvio configura password Admin e collegamento ComfyUI nel browser.
timeout /t 3 /nobreak >nul
endlocal
