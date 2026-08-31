# Architettura H3 Studio

```text
┌──────────────────────────────────────────────────────────┐
│ H3 Studio Web                                            │
│ Chat · Projects · Composer · Candidates · Timeline · Admin│
└────────────────────────────┬─────────────────────────────┘
                             │ HTTP + WebSocket autenticati
┌────────────────────────────▼─────────────────────────────┐
│ H3 Studio Bridge — Node.js / Fastify                     │
│ AuthZ · Credits · Queue · Workflow Mapper · Media Index  │
└───────────────┬───────────────────────────┬──────────────┘
                │                           │
        HTTP / WebSocket                    │ SQLite + filesystem
                │                           │
┌───────────────▼──────────────┐   ┌────────▼──────────────┐
│ ComfyUI :9000               │   │ H3 Studio Data        │
│ Studio Backend workflow     │   │ projects/assets/meta  │
└─────────────────────────────┘   └───────────────────────┘
```

## Confini

- Il browser non modifica direttamente JSON ComfyUI.
- Il bridge ascolta su loopback per impostazione predefinita.
- ComfyUI non viene esposto pubblicamente.
- SQLite conserva dati strutturati; il filesystem conserva i media.
- Firebase è un'estensione opzionale, non il server di rendering.

## Flusso candidato

1. Il client richiede un preventivo crediti.
2. Il bridge valida utente, saldo, asset e parametri.
3. Crea Candidate e riserva il costo nel ledger.
4. Applica gli override a una copia del prompt API.
5. Accoda i candidati in ordine.
6. Registra `prompt_id` e progressi WebSocket.
7. Indicizza video, thumbnail e snapshot.
8. Regola l'addebito e rimborsa l'eventuale residuo.

## Flusso Continue

`Continue` crea uno Shot figlio, assegna il candidato scelto a VIDEO EXTENSION, eredita gli asset desiderati e genera altri 5 o 10 secondi. Non è un upscale.

## Flusso Edit

`Video editing H3` usa il video scelto come sorgente `VIDEO EDITING`, fino a
180 secondi, e conserva l'originale come genitore immutabile. Il bridge inoltra
il job al percorso nativo dell'Ultra AIO Composer con il modello H3 standard/
Hybrid. Non è un flusso Reference, non aggiunge maschere esterne e non usa PDD FAST.

`Masking H3` riusa `VIDEO EDITING` ma aggiunge una pipeline opzionale separata:
SAM3 segmenta e propaga un bersaglio testuale, MaskVid crea un crop temporale
stabile, il sampler H3 elabora il crop e `Subject Uncrop` ripristina sui frame
originali tutti i pixel esterni alla maschera. Il bridge chiude il worker SAM3
non appena il sampler H3 può procedere senza di esso.
## Clip e montaggio

I media generati sono oggetti immutabili. Una Sequence non contiene un MP4 progressivamente riscritto: contiene riferimenti ordinati ai Candidate selezionati e istruzioni di montaggio. Il player passa da un clip al successivo e applica in/out e transizioni in tempo reale. FFmpeg interviene soltanto durante l'esportazione o per normalizzare clip incompatibili.

La continuazione usa internamente il tail del genitore come conditioning. Il risultato pubblico dello shot contiene solo i nuovi 5 o 10 secondi; source+continuation e frame di overlap, se prodotti dal workflow, restano artefatti tecnici non inseriti due volte in timeline.

## Crediti

Il saldo visualizzato è una vista derivata dalle transazioni immutabili. Reserve e settle devono avvenire in transazioni atomiche per impedire doppia spesa quando arrivano richieste simultanee.

Indici SQLite iniziali saranno creati soltanto per query reali: job per stato/utente, candidati per shot, transazioni per utente/data e utenti per stato/email.

## Deployment futuro

Il frontend può essere ospitato; il bridge rimane sul PC con la GPU. L'interfaccia ospitata si associa al bridge senza aprire la porta 9000. I video restano locali salvo upload esplicito.

## Bootstrap e distribuzione

Al primo avvio il bridge non possiede credenziali. Il wizard locale crea la
password Admin, salva soltanto derivazione scrypt e sessioni hashate, quindi
registra URL ComfyUI, output, FFmpeg e profili workflow in `data/`. Tutte le
rotte `/api/admin/*` sono protette server-side.

I workflow versionati sono snapshot sanitizzati: nessun media, prompt personale
o LoRA dell'autore viene distribuito. Il bridge sostituisce a runtime modello,
step e fino a tre LoRA usando la configurazione Admin.

Il custom node H3 Studio è incluso in `comfyui_nodes/` perché alcune classi
sono estensioni locali non presenti nell'upstream. L'installer crea un backup
dell'eventuale nodo esistente, applica lo snapshot e clona i repository esterni.
I pesi restano fuori da Git e sono verificati tramite gli endpoint
`/models/<folder>` della ComfyUI collegata.

## Chat locale

Ogni progetto possiede una conversazione persistita in `chat_threads` e
`chat_messages`. Il browser invia testo e riferimenti annotati al bridge; il
bridge aggiunge un prompt di routing strutturato e chiama gli endpoint locali
del nodo Chat locale incluso. Il nodo risolve soltanto file confinati
nelle directory `models/llm` e negli input/output ComfyUI, comprime le immagini
per l'analisi e avvia un `llama-server` MTMD su una porta loopback casuale.

LLM restituisce sempre una risposta naturale e, opzionalmente, una singola
azione validata dal bridge. I parametri di esecuzione non sono affidati al
modello: i video Chat sono fissati a 10 secondi, 0,5 MP, un candidato e FAST
8-step; generazione Krea, edit Klein e Anima passano invece ai servizi immagini
già esistenti. Prima di qualsiasi azione o render avviato dallo Studio, il
bridge chiama `/h3_studio/chat/unload`, termina il subprocess e libera la VRAM.
