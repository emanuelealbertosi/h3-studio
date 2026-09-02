# Installazione portabile

H3 Studio è progettato per essere clonato senza modificare il codice o i file
workflow. Stato locale, password, database, log e media non vengono versionati.

## Requisiti

- Windows 10/11 oppure una distribuzione Linux x86_64 con driver NVIDIA.
- Node.js 22.16.0 o superiore.
- ComfyUI già funzionante e raggiungibile via HTTP.
- FFmpeg nel `PATH` oppure il suo percorso configurato nell'Admin.
- I modelli MiniMax H3, Krea e Flux.2 Klein scelti dall’Admin nelle cartelle ComfyUI corrette.
- Per la Chat: un modello LLM GGUF compatibile con llama.cpp e il relativo `mmproj` nella cartella `llm`
  visibile a ComfyUI e un `llama-server` recente con supporto MTMD/Vision.

La versione minima 22.16.0 è necessaria anche per il backup SQLite consistente
usato dallo strumento di riparazione dei tempi storici.

## Avvio

```powershell
git clone <URL-DEL-REPOSITORY>
cd H3-Studio
.\INSTALL_COMFY_DEPENDENCIES.bat
.\START_H3_STUDIO.bat
```

Il primo BAT chiede la cartella `ComfyUI`, installa il nodo H3 Studio incluso e
clona i custom node esterni necessari ai workflow configurati. Se trova già
`ComfyUI-H3-Multishot`, crea prima un archivio recuperabile in
`custom_nodes/_h3_studio_backups/`. Non sovrascrive né scarica i pesi.

Per installare anche i `requirements.txt` con il Python della portable:

```powershell
.\scripts\INSTALL_COMFY_DEPENDENCIES.ps1 -ComfyRoot "D:\ComfyUI\ComfyUI" -InstallPythonRequirements
```

La modalità predefinita è conservativa: per i requisiti Python si può usare
anche ComfyUI Manager. Il secondo launcher esegue `npm install` soltanto se le
dipendenze web non sono presenti, poi apre `http://localhost:3000`.

Per chiudere H3 Studio senza lasciare bridge o worker in background:

```powershell
.\STOP_H3_STUDIO.bat
```

Lo script riconosce soltanto i processi appartenenti alla stessa cartella del
progetto, arresta l'intero albero di frontend e bridge e verifica le porte 3000
e bridge. Non termina ComfyUI, non chiude il servizio Tailscale e rifiuta di
terminare un eventuale listener estraneo. Per l'uso non interattivo è
disponibile `STOP_H3_STUDIO.bat --no-pause`.

Su Linux gli equivalenti sono:

```bash
git clone <URL-DEL-REPOSITORY>
cd H3-Studio
chmod +x INSTALL_COMFY_DEPENDENCIES.sh START_H3_STUDIO.sh STOP_H3_STUDIO.sh
./INSTALL_COMFY_DEPENDENCIES.sh --comfy-root /percorso/ComfyUI
./START_H3_STUDIO.sh
```

Lo script Linux non scarica i pesi, conserva un backup dei nodi inclusi già
presenti e non installa i `requirements.txt` Python salvo l'opzione esplicita
`--install-python-requirements`. `START_H3_STUDIO.sh` salva PID e log in
`data/` e può essere arrestato con `./STOP_H3_STUDIO.sh`.

### Protezione dal bridge precedente

Prima di avviare il bridge, `START_H3_STUDIO.bat` e `START_H3_STUDIO.sh` leggono anche
`H3_BRIDGE_HOST` e `H3_BRIDGE_PORT` da `.env`, quindi verifica il listener
dell'endpoint configurato (predefinito `127.0.0.1:8787`). Se trova un processo
Node la cui command line punta esattamente a `bridge/server.ts` nella stessa
`ProjectRoot`, interroga `/api/health`: se il bridge è sano lo riusa e avvia
soltanto il frontend; se non risponde lo termina e attende che la porta si
liberi prima di sostituirlo. Il riconoscimento comprende sia il collegamento
`node_modules/tsx` sia il percorso fisico pnpm usato dopo un riavvio Admin.
Se il listener appartiene a un altro programma, non è verificabile
oppure cambia durante il controllo, il launcher interrompe l'avvio senza
terminare processi estranei.

Questa protezione evita che un frontend aggiornato continui a parlare con un
bridge rimasto attivo da una versione precedente. In quel caso potevano
mancare il contratto Upscale 2 MP e `processingSeconds`; ora il dialog Upscale
rimane visibile con un errore esplicito e non accoda nulla a ComfyUI.

## Primo avvio

Il browser mostra un wizard che richiede:

1. una nuova password Admin di almeno 10 caratteri;
2. l'URL della ComfyUI, per esempio `http://127.0.0.1:8188`;
3. la cartella `output` della stessa installazione ComfyUI;
4. i workflow associati ai ruoli Video, FAST, Krea, Flux Klein Edit e Anima;
5. il comando o percorso di FFmpeg.

La password viene derivata con `scrypt`; nel database non viene salvata in
chiaro. Dopo il wizard è necessario riavviare una volta H3 Studio. Lo Studio
resta utilizzabile senza login, mentre l'area Admin richiede una sessione locale
HTTP-only della durata di 12 ore.

## Workflow inclusi

- `workflows/studio-backend.ui.json`: AIO H3 da aprire in ComfyUI.
- `workflows/studio-backend.api.json`: snapshot API usato dal bridge.
- `workflows/studio-krea2.api.json`: generazione immagini Krea 2.
- `workflows/studio-flux2-klein-edit.api.json`: edit Flux.2 Klein 4B Distilled con una-quattro reference.
- `workflows/studio-anima.api.json`: generazione anime Anima con profilo separato.
- LTX 2.5 viene composto dal bridge con nodi core/LTX aggiornati, senza duplicare
  un grande workflow JSON. `scripts/download-ltx25-models.ps1` scarica encoder e
  VAE opzionali nella cartella indicata esplicitamente con `-ModelRoot`; non usa
  mai un disco predefinito. Indicare la cartella `models` della ComfyUI collegata
  oppure un model store già dichiarato in `extra_model_paths.yaml`. Il checkpoint
  RedGraft resta un download distinto da Civitai. Il profilo Quality richiede
  inoltre `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` nella cartella
  `latent_upscale_models`; l'Admin lo espone e lo verifica separatamente.
- `workflows/catalog.json`: ruoli e associazioni disponibili.
- `workflows/dependencies.json`: nodi e modelli richiesti.

L'Admin interroga la ComfyUI collegata e mostra quali dipendenze risultano
presenti, includendo cartella e nome dei pesi mancanti. I pesi dei modelli non
sono inclusi nel repository.

Il pacchetto esteso `comfyui_nodes/ComfyUI-H3-Multishot` è necessario: il
repository H3 Multishot originale da solo non contiene autoprompter AIO, motion
memory e router Studio. Provenienza e commit base sono documentati nel file
`H3-STUDIO-NOTICE.md` della cartella.

Il pacchetto incluso `comfyui_nodes/H3-Studio-Gemma4-Chat` non richiede il
servizio LM Studio. Su Windows rileva automaticamente il `llama-server.exe`
più recente installato fra i backend locali di LM Studio e lo avvia soltanto
durante la conversazione, in ascolto su una porta loopback casuale. In
alternativa si può copiare una distribuzione completa di llama.cpp nella
sottocartella `runtime` del nodo (eseguibile e DLL adiacenti) oppure impostare
la variabile di ambiente `H3_CHAT_LLAMA_SERVER` nel processo che avvia ComfyUI.
Su Linux il nodo cerca `llama-server` nel `PATH`, nella sottocartella `runtime`
o nel percorso indicato dalla stessa variabile. L'Admin rileva e termina in
sicurezza il processo effimero sia su Windows sia su Linux.
Il server effimero viene terminato prima di Video, Image, Face e Upscale, quindi
LM Studio non deve essere aperto e il modello non rimane in VRAM durante i render.

## Planner AI OpenAI-compatible

Il planner può restare interamente locale oppure usare un servizio remoto che
implementi la Chat Completions API in formato OpenAI. Non occorre cambiare i
workflow: il bridge invia i messaggi a `POST /chat/completions`, aggiungendo il
percorso all'URL base quando non è già presente, e inoltra `Authorization: Bearer`
solo quando è stata configurata una chiave.

Configurazione dalla card **Admin → Planner AI**:

1. scegliere **Locale**, **Remoto** o **Automatico**;
2. per Remoto/Automatico indicare l'URL base, per esempio
   `https://api.openai.com/v1`, e il nome esatto del modello esposto dal provider;
3. inserire la chiave API, se richiesta dal server, e regolare timeout, token
   massimi, temperature e top-p;
4. usare **Verifica connessione**: il test usa i valori ancora presenti nel form
   e chiede la risposta breve `H3_OK` senza avviare render;
5. salvare le impostazioni Admin. Lasciare vuoto il campo chiave nei salvataggi
   successivi per conservare quella esistente; **Rimuovi chiave** la elimina.

**Automatico** usa l'API come prima scelta e ripete la richiesta sul GGUF locale
quando la chiamata remota fallisce. Per questo profilo modello, projector e runtime
Chat locali rimangono obbligatori. **Remoto** non esegue fallback: è utile quando
si vuole evitare del tutto il caricamento del planner GGUF, ma un errore API ferma
la relativa operazione. **Locale** ignora URL, modello remoto e chiave.

La scelta copre Video H3 e i compiler per Image H3, Krea, Flux Edit, Anima, TTS e
Musica. La casella **Usa il modello remoto anche per conversazione e memoria Chat**
estende il provider alla conversazione e alla compattazione della memoria; se è
disattivata, la Chat continua a usare il GGUF locale. In modalità Automatico il
fallback locale vale anche per la Chat quando la casella è attiva.

I parametri non sensibili sono memorizzati in `data/runtime-settings.json`. La
chiave non viene salvata nello stesso JSON: usa `data/planner-api-key.txt`, è
gestita solo dalle route Admin autenticate, non viene mai riletta dal browser e
non compare negli snapshot dei job. È distinta sia dalla password Admin sia da
eventuali credenziali ComfyUI. Proteggere comunque la cartella `data/` con i
permessi dell'account che esegue H3 Studio.

## Dati esclusi da Git

Tutto ciò che si trova in `data/`, salvo `.gitkeep`, rimane sul computer:
database, password derivata, sessioni, configurazione dell'installazione,
progetti, log ed esportazioni. Anche `.env` è escluso.

## Configurazione avanzata

Copiare `.env.example` in `.env` è opzionale. Le variabili servono per porte,
origine web o percorsi iniziali; dopo il setup, i parametri gestiti dall'Admin
sono salvati in `data/install-settings.json`.

Completare il primo avvio da localhost. Solo dopo, per Tailscale impostare
`H3_ENABLE_TAILSCALE=1` prima di lanciare il file BAT.
Prima di esporre l'app a utenti non fidati va aggiunta autenticazione anche alle
API di generazione: la password attuale protegge intenzionalmente la sola area
Admin.

## Riparazione dei tempi storici

Un bridge legacy poteva riscrivere il timestamp terminale dei candidati durante
il polling, rendendo inattendibile il tempo mostrato. Il comando seguente
analizza soltanto i candidati `ready` e, per impostazione predefinita, esegue un
dry-run senza modificare il database:

```powershell
npm run repair:processing-times -- --database "data\h3-studio.sqlite" --comfy-output "<cartella-output-comfy>"
```

Per applicare le sole correzioni proposte, arrestare prima il bridge e
confermarlo esplicitamente:

```powershell
npm run repair:processing-times -- --database "data\h3-studio.sqlite" --comfy-output "<cartella-output-comfy>" --apply --bridge-stopped
```

Prima di modificare `candidates.updated_at`, l'apply crea e verifica un backup
SQLite consistente. Il tool accetta soltanto file reali confinati nella
cartella output indicata, ricontrolla stato e timestamp dopo il backup e salta
record mancanti, concorrenti o non ricostruibili invece di stimarne la durata.
Per evitare falsi positivi dovuti alla normale finalizzazione del file o alla
precisione NTFS, considera corrotto soltanto un `updated_at` che superi di oltre
5 minuti il `LastWriteTimeUtc` dell'output.
