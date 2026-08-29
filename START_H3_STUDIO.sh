#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

die() { printf '[ERRORE] %s\n' "$*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || die 'Serve Node.js 22.16.0 o superiore.'
node -e "const [a,b,c]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&(b>16||(b===16&&c>=0)))?0:1)" \
  || die "Node $(node --version) non supportato: serve almeno 22.16.0."
printf '[H3 Studio] Node %s · Linux %s\n' "$(node --version)" "$(uname -m)"

if ! command -v nvidia-smi >/dev/null 2>&1; then
  printf '[AVVISO] nvidia-smi non trovato: verifica driver NVIDIA/CUDA prima dei render.\n' >&2
fi
command -v ffmpeg >/dev/null 2>&1 || printf '[AVVISO] FFmpeg non è nel PATH; configurarlo nell’Admin.\n' >&2

if [[ ! -d node_modules ]]; then
  printf '[H3 Studio] Prima installazione delle dipendenze npm...\n'
  npm install
fi

mapfile -t H3_ENDPOINT < <(node --env-file-if-exists=.env - <<'NODE'
const host=String(process.env.H3_BRIDGE_HOST||'127.0.0.1').trim();
const web=String(process.env.H3_WEB_HOST||'127.0.0.1').trim();
const port=Number.parseInt(process.env.H3_BRIDGE_PORT||'8787',10);
if(!/^[A-Za-z0-9._:-]+$/.test(host)||!/^[A-Za-z0-9._:-]+$/.test(web)||!Number.isInteger(port)||port<1||port>65535)process.exit(2);
const target=host==='0.0.0.0'?'127.0.0.1':host==='::'?'::1':host;
console.log(host); console.log(port); console.log(`http://${target.includes(':')?'['+target+']':target}:${port}`); console.log(web);
NODE
)
[[ ${#H3_ENDPOINT[@]} -eq 4 ]] || die 'H3_BRIDGE_HOST, H3_BRIDGE_PORT o H3_WEB_HOST non validi.'
BRIDGE_HOST="${H3_ENDPOINT[0]}"; BRIDGE_PORT="${H3_ENDPOINT[1]}"; BRIDGE_URL="${H3_ENDPOINT[2]}"; WEB_HOST="${H3_ENDPOINT[3]}"

mkdir -p data/run data/logs
set +e
node scripts/prepare-bridge-port.mjs --project-root "$ROOT" --host "$BRIDGE_HOST" --port "$BRIDGE_PORT"
PREFLIGHT=$?
set -e
[[ $PREFLIGHT -eq 0 || $PREFLIGHT -eq 25 ]] || die 'Il bridge non può essere preparato in sicurezza.'

if [[ $PREFLIGHT -eq 0 ]]; then
  printf '[H3 Studio] Avvio bridge su %s\n' "$BRIDGE_URL"
  nohup node --env-file-if-exists=.env node_modules/tsx/dist/cli.mjs bridge/server.ts \
    >>data/logs/bridge.log 2>&1 &
  echo $! > data/run/bridge.pid
else
  printf '[H3 Studio] Bridge sano già attivo: riuso l’istanza.\n'
fi

if node -e "fetch('http://127.0.0.1:3000',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
  printf '[H3 Studio] Interfaccia già attiva su http://localhost:3000\n'
else
  printf '[H3 Studio] Avvio interfaccia su http://localhost:3000\n'
  nohup node_modules/.bin/vinext dev --hostname "$WEB_HOST" >>data/logs/web.log 2>&1 &
  echo $! > data/run/web.pid
fi

for _ in {1..40}; do
  if node -e "fetch(process.argv[1]+'/api/health',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "$BRIDGE_URL"; then break; fi
  sleep .25
done
node -e "fetch(process.argv[1]+'/api/health',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "$BRIDGE_URL" \
  || die 'Il bridge non è diventato pronto; controlla data/logs/bridge.log.'

if [[ "${H3_ENABLE_TAILSCALE:-0}" == "1" ]]; then
  if command -v tailscale >/dev/null 2>&1; then
    tailscale serve --bg --yes --https=443 http://127.0.0.1:3000
    tailscale serve --bg --yes --https="$BRIDGE_PORT" "$BRIDGE_URL"
  else
    printf '[AVVISO] Tailscale richiesto ma non presente nel PATH.\n' >&2
  fi
fi

if command -v xdg-open >/dev/null 2>&1 && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  xdg-open http://localhost:3000 >/dev/null 2>&1 || true
fi

printf '\nH3 Studio avviato.\nLocale: http://localhost:3000\nLog: %s/data/logs\nArresto: ./STOP_H3_STUDIO.sh\n' "$ROOT"
