# Worklog

### 29 agosto 2026 — Routing deterministico immagine Chat → I2V/R2V

- La Chat recupera ora anche “ultima/precedente immagine” e varianti equivalenti, evitando prompt `Picture 1` senza media allegato.
- “Anima/trasforma/crea un video da questa immagine” forza I2V; “come riferimento/reference” forza R2V e l'audio continua a richiedere Reference.
- “Mantieni il formato” usa `keep source aspect` per l'I2V avviato dalla Chat.
- Aggiunte regressioni sulle frasi reali dell'ultimo job, sulla precedenza I2V/R2V e sul voice reference.

### 29 agosto 2026 — Durata Chat collegata al multishot

- Le richieste video della Chat non ignorano più `durationSeconds`: 30 secondi vengono inviati allo Studio come `3 × 10 s`.
- Il default resta 10 secondi, FAST, 0,5 MP e un candidato; la Chat può pianificare fino a 12 shot e 180 secondi complessivi.
- Aggiunte regressioni per default, 30, 120, 180 secondi e rifiuto delle durate superiori.

### 29 agosto 2026 — I2V con visual lock e monoshot continuo

- Picture 1 viene ora inviata al planner Vision a 384 px solo in I2V; il render H3 continua a usare la sorgente originale.
- Il planner non può più inventare outfit, ambienti, luce, composizione o punto macchina quando non sono richiesti dall'utente.
- Nei job I2V da uno shot, il parser converte automaticamente eventuali `[Shot 2+]` in azioni temporali dello stesso `[Shot 1]`, evitando tagli e reframing impliciti.
- Aggiunte regressioni automatiche sul routing Vision e sul flattening dei marker interni.

### 29 agosto 2026 — Upscale con aspect ratio sorgente

- Corretto il post-process Upscale: non forza più `megapixels + format` sui job creati con `Mantieni proporzioni`.
- I job Keep Aspect conservano il collegamento Picture/Video usato dal nodo dimensionale H3; i formati espliciti mantengono il proprio preset e i vecchi job manuali vengono scalati sulla stessa proporzione.
- Aggiunte regressioni automatiche per Keep Aspect, 9:16 e dimensioni manuali verticali/orizzontali.

### 29 agosto 2026 — Filtro categorie nella Libreria

- Aggiunto un filtro compatto con conteggi reali per Tutto, Montaggi, Asset, Immagini, Esterni e Video.
- Il filtro nasconde solo le sezioni non pertinenti: rinomina, invio allo Studio, cancellazione e selezione multipla restano disponibili sugli elementi mostrati.
- La barra è orizzontalmente scorrevole sugli schermi stretti.

## 29 agosto 2026 — Multishot 1–12 nello Studio

- Rimosso il vincolo implicito `shot_count=1`: ogni candidato usa ora da 1 a 12 shot concatenati dallo stesso sampler con frame memory.
- Aggiunti durata totale indicativa, crediti/ETA corretti, persistenza SQLite v23, rigenerazione e durata timeline moltiplicata.
- Ogni Picture, Video e Audio può essere pianificato su Auto, Tutti o shot espliciti; planner e prompt builder emettono schedule separati.
- Il reference bank filtra fisicamente i blocchi inattivi per shot e ricompatta i marker, inclusi i gruppi Video+Audio accoppiati.
- Aggiunti `test:multishot`, copertura FAST 12-shot e regressione della durata timeline; CI Windows aggiornata.

## 27 agosto 2026 — Chat LLM Vision per progetto

- Aggiunta la voce Chat sopra lo Studio con conversazioni SQLite indipendenti per progetto, cronologia, pulizia e composer responsive.
- Collegata la Libreria con pulsante `+`, trigger `@`, miniature e fino a otto allegati; LLM analizza direttamente fino a quattro immagini.
- Implementato il routing strutturato verso Video H3, generazione Krea, edit Flux.2 Klein e Anima; i video Chat usano sempre 10s, FAST 8-step, 0,5 MP e un candidato.
- Aggiunto un profilo Admin separato per modello LLM, projector, contesto, layer GPU, thread e sampling, senza contaminare i modelli H3 o Flux.
- Creato e installato il nodo nodo Chat locale incluso: rileva il runtime llama.cpp locale, avvia un server MTMD loopback effimero e lo termina prima di ogni render.
- Verificati end-to-end testo, JSON strutturato, lettura Vision di una schermata e rilascio del modello; aggiunto `test:chat` alla CI.

## 27 agosto 2026 — Continue allineato al Multishot

- Corretto `VIDEO EXTENSION`: il video sorgente non viene più reinserito per intero nel reference bank, dove poteva essere reinterpretato o riprodotto invece di continuato.
- Il frame finale esterno segue ora lo stesso percorso di raccordo degli shot interni: keyframe al frame 0 e memoria visiva del text encoder; le Picture restano riferimenti espliciti separati.
- Eliminato dal segmento di continuazione il frame di confine duplicato, come già avviene tra gli shot Multishot, conservando l'audio sorgente come riferimento solo-audio.
- Aggiunto `test:continuation` per bloccare regressioni di questi tre invarianti.
- Il Composer ora ripara in modo deterministico il difetto LLM in cui il paragrafo `Continuity Bible` chiude prematuramente `description` e il successivo `[Shot 1]` viene emesso come stringa JSON senza chiave; aggiunto un test isolato che verifica riparazione e no-op sui JSON validi.
- Il Continue separato ora usa automaticamente 22 frame consecutivi della coda MP4 tramite H3 Motion Context, inclusa la coda audio: il last-frame keyframe resta come ancora, ma la direzione del movimento non viene più indovinata da una singola immagine. Gli shot interni continuano invece a preferire il latent AV nativo senza ricodifica.

## 25 agosto 2026

- Creato e installato lo scaffold H3 Studio in `F:\H3-Studio`.
- Scelto Node.js/TypeScript/Fastify come bridge locale.
- Definiti output da 5 o 10 secondi.
- Definiti preset 0,5 / 0,7 / 1,0 MP.
- Confermato supporto a T2V, I2V, Reference, Keyframes, Continue ed Edit.
- Definita griglia adattiva da 1 a 4 candidati.
- Realizzata prima UI Candidate Studio con progresso blurred e trasformazione in risultato.
- Aggiunti costo preventivo e saldo crediti dimostrativi.
- Definiti utenti pending/active/blocked e console admin.
- Definito bucket iniziale di 500 crediti, senza rinnovo.
- Definiti reserve, settle, refund e ledger immutabile.
- Avviata e verificata la prima preview locale.
- Invertito il layout in stile chatbot: candidati sopra e composer compatto/sticky in basso.
- Sostituita la griglia adattiva con una film strip fissa a quattro slot uguali, allineati da sinistra e scorrevoli orizzontalmente sui browser stretti.
- Build completata; audit runtime segnala advisory nello stack Next/PostCSS/Sharp da risolvere prima di autenticazione o pubblicazione, senza aggiornamenti forzati.

### Prossimo lavoro

- Feedback visivo sulla Product Shell.
- Bridge Fastify e health check ComfyUI.
- Primo candidato T2V reale.

## 25 agosto 2026 — Milestone 2

- Creato bridge locale Fastify su loopback.
- Aggiunto client ComfyUI con timeout, `/system_stats` e `/queue`.
- Aggiunto `/api/health` e canale WebSocket `/api/events`.
- Collegato l'indicatore della UI allo stato reale Bridge/ComfyUI.
- Formalizzato il montaggio non distruttivo con clip autonomi, playback virtuale ed export FFmpeg.
- Aggiunto il Workflow Store con copia UI separata, firma SHA-256 e cattura validata dell'ultimo prompt API FINAL dall'history di ComfyUI.
- Aggiunti `GET /api/workflow/status` e `POST /api/workflow/capture`; in assenza di un run riconoscibile il bridge blocca la cattura senza inviare nulla alla GPU.
- Catturato il FINAL eseguito: copia UI da 30 nodi ed export API validato da 23 nodi, senza modificare il workflow sorgente.
- Aggiunto builder FAST T2V per 1–4 candidati con prompt, seed, 5/10 secondi, 0,5/0,7/1,0 MP, Turbo 8-step e prefix isolato per candidato.
- I LoRA non-Turbo presenti nello snapshot vengono disattivati automaticamente nel job Studio; aggiunti dry-run e invio reale separati.
- Calibrata la prima stima ETA sui run locali: circa 172–180 secondi per 5s / 0,5 MP / Turbo 8-step; l'interfaccia mostra un intervallo prudente scalato per durata, MP e candidati.
- Aggiunto il selettore formato con tutti gli 11 aspect ratio realmente dichiarati da `H3AspectMegapixelSize`; la scelta viene validata e applicata nel prompt API.
- Aggiunti monitoraggio di stato per promptId, individuazione dell'MP4 nell'history e proxy streaming `/api/media` con supporto Range per il player web.
- Aggiunta configurazione FAST persistente per Admin: workflow visibile, modello H3, LoRA/strength e step modificabili; modelli e LoRA sono validati contro gli elenchi reali di ComfyUI.
- Sostituita la simulazione del pulsante Genera con invio reale al bridge, polling per promptId e player MP4; nessun render viene avviato finché l'utente non preme Genera.
- Collegati step e LoRA FAST dell'Admin a badge, costo ed ETA dello Studio; le percentuali durante sampling sono esplicitamente stimate finché non arriva il progresso WebSocket.
- Rimosso il falso avanzamento temporale che poteva mostrare finalizzazione durante il caricamento; aggiunto tracker WebSocket ComfyUI per fase nodo e percentuale sampling reale.
- Confrontati i primi run: 198,9 s Studio contro 171,7 s cached. Il delta di 27,2 s deriva dal planner/autoprompter non in cache (8 nodi cached contro 17), non da modello, LoRA o bridge; ETA aggiornata con 28 s cold-start una volta per job.
- Aggiunta persistenza SQLite locale con migrazione versionata per job, candidati, snapshot API, impostazioni FAST, promptId e metadati output; i blob video restano nel filesystem ComfyUI.
- Aggiunto recupero dei job attivi e degli snapshot di progresso dopo il riavvio del bridge, oltre a `GET /api/jobs` per la cronologia recente.
- Collegato il ripristino automatico dell'ultimo job alla UI: prompt, durata, MP, formato, candidati e player vengono ricostruiti dal database all'apertura.
- Aggiunto importatore idempotente della precedente history `video/H3_STUDIO`, utile per migrare nel database i job prodotti prima della persistenza.
- Aggiunta migrazione SQLite v2 e API per conservare il candidato selezionato, con validazione che il risultato sia completato e abbia un output video.
- Aggiunta la schermata Progetti/Cronologia: elenca i job SQLite, mostra l'output disponibile e riapre prompt, formato, durata, seed e candidati nello Studio.
- Collegato il pulsante Scegli alla selezione persistente; verificata la conservazione del candidato dopo due riavvii del bridge.
- Verificati typecheck, build, migrazioni v1/v2 e risposta HTTP locale senza avviare nuovi render.

## 25 agosto 2026 — Milestone 3/4

- Aggiunte modalità seed Random, Base +1 e Bloccato; verificati su quattro candidati in dry-run.
- Aggiunti Play, Pausa e Da capo sincronizzati per confrontare i candidati pronti.
- Aggiunte migrazioni SQLite fino alla v6 per strategia seed, progetti, timeline e parametri multimodali.
- Implementati progetti locali e clip non distruttive con aggiunta da cronologia, riordino, copia e spostamento fra progetti.
- Implementato playback virtuale concatenato: ogni video resta un file autonomo e la timeline passa alla clip successiva.
- Aggiunto test isolato del repository progetti; verificati create, add, copy, move e reorder su database temporaneo.
- Esteso il builder ai sei modi reali del workflow: T2V, I2V, R2V, KEYFRAMES, VIDEO EXTENSION e VIDEO EDITING.
- Aggiunto upload proxy verso la route ufficiale del MiniMax H3 Media Loader, con validazione dei tipi.
- Persistiti media state, ruoli Reference, posizioni Keyframe e politica audio.
- Imposto sempre `H3SaveContinuation.prepend_source_video = false`: Continue produce soltanto il nuovo segmento.
- Aggiunti pulsanti Continua/Edita su candidati e clip della timeline.
- Aggiunti preset creativi Camera, Obiettivo ed Effetti che inseriscono direttive leggibili nel prompt.
- Implementato export MP4 della timeline tramite FFmpeg locale, con concat stream-copy e fallback H.264/AAC.
- Aggiunti pulsante Esporta MP4, stato di avanzamento e download diretto nel pannello montaggio.
- Aggiunto test non-GPU dell’export su un candidato già esistente: MP4 prodotto e temporanei rimossi correttamente.
- Verificati in dry-run tutti i sei modi con asset ComfyUI esistenti, due seed candidati e coda GPU rimasta vuota.
- Verificati typecheck, build, migrazioni v1-v6, indice timeline usato dal query planner, repository progetti, API e frontend HTTP 200.

## 26 agosto 2026 — Milestone 6 / Libreria creativa

- Attivato il tab Personaggi e aggiunta una libreria comune per personaggi e oggetti.
- Aggiunta migrazione SQLite v7 con asset, reference multiple e cronologia generazioni Krea 2.
- Implementati CRUD, drag-and-drop immagini, ruoli automatici e massimo 12 reference.
- Costruito un grafo API Krea 2 compatto da 11 nodi per sheet a quattro viste, 1536×1024 e 8 step.
- Verificata la presenza del workflow sorgente, modello FP8, encoder, VAE, Rebalance e Sharpen nella ComfyUI attiva.
- Aggiunti dry-run senza GPU, invio esplicito a ComfyUI e recupero automatico dell'output come reference principale.
- Collegato **Usa nel video** alla modalità H3 Reference con compilazione automatica di `reference_roles`.
- Test isolato CRUD/migrazione/indice/dry-run superato; test API temporaneo creato e ripulito; coda GPU rimasta vuota.

## 26 agosto 2026 — Collaudo end-to-end autonomo

- Verificati build con Node 24, ESLint, repository progetti, libreria creativa, contratto Krea 2 ed export timeline.
- Eseguita una generazione Krea 2 reale da 1536×1024 in circa 99 s; la sheet è stata registrata automaticamente come reference primaria.
- Eseguito un R2V reale da 5 s / 0,5 MP / 8 step con modello hybrid INT8 e Turbo v4 600 EMA in circa 213 s.
- Verificati output H.264/AAC, coerenza visiva su quattro fotogrammi, persistenza di job/asset/reference dopo restart e coda ComfyUI libera al termine.
- Corretto lo stato terminale dei candidati: la history `ready/failed` ora prevale su un eventuale progresso WebSocket rimasto obsoleto.
- Aggiunto `docs/TEST-REPORT-2026-08-26.md` con risultati, artefatti e limite del browser in-app.
- Allineato il preset MAX alla risoluzione nativa H3: `0,98 MP` al posto di `1,00 MP` nell'app e nei workflow principali.
- Corretto `H3AspectMegapixelSize` alla convenzione ComfyUI `1024² pixel/MP`: 0,5 → 960×544, 0,7 → 1152×640, 0,98 → 1344×768 in 16:9.
- Mantenuta compatibilità con i vecchi job a 1,00 MP, normalizzati automaticamente a 0,98 quando vengono riaperti o inviati.

## 26 agosto 2026 — Progetti persistenti e Montaggi v2

- Aggiunte migrazioni SQLite v8/v9 con relazione job → progetto e job → sorgente, montaggi multipli per progetto, trim e mixer audio persistenti.
- Associati automaticamente i quattro job storici al primo progetto locale; le future continuazioni restano nello stesso progetto come segmenti autonomi.
- Separata la UI **Progetti** dalla nuova voce **Montaggi**: il nome progetto è visibile nella topbar, nel filtro e sui job.
- Aggiunta nello Studio una strip dei batch del progetto, così una nuova generazione/continuazione non nasconde più il batch precedente.
- Aggiunto un montaggio principale automatico e la possibilità di creare più timeline per lo stesso progetto.
- Implementati trim in/out a 0,05 s, volume per clip, riordino, playback concatenato e salvataggio non distruttivo.
- Aggiunti upload di audio esterno, gain indipendente per audio H3 e traccia esterna, loop e rimozione traccia.
- Esteso l’export FFmpeg: applicazione trim, normalizzazione H.264/AAC, concatenazione e mux/mix della traccia esterna.
- Aggiunti controlli espliciti per mutare audio diegetico e/o non diegetico durante la generazione; sono direttive di prompt perché H3 produce una sola traccia mixata.
- Creato backup pre-migrazione: data/h3-studio.sqlite.before-timelines-v8-20260826.
- Verificati typecheck, build, API HTTP, migrazioni, repository su DB temporaneo e export reale trim da 1 secondo (518.651 byte).

## 26 agosto 2026 — Audit piano e preparazione post-produzione

- Installati nella ComfyUI NVMe `ComfyUI-H3-FaceRefine`, `ComfyUI-H3-NativeAudioLock` e il detector `face_yolov8m.pt`.
- Installate e verificate le dipendenze Python FaceRefine senza sostituire OpenCV mentre ComfyUI era attiva.
- Confermato che InsightFace usa attualmente ONNX CPU; la migrazione a ONNX GPU resta una decisione separata da collaudare.
- Confermata la presenza locale del Latent Upscaler H3, ma non ancora la sua integrazione nel bridge H3 Studio.
- Auditato il piano contro API, UI, database e test reali: coda ordinata, indicizzazione output, libreria media `@`, montaggi ed export risultano implementati.
- Corrette le voci obsolete su stato progetto, risoluzione massima 0,98 MP, Engine H3/Krea e milestone già completate.
- Aggiunta una milestone dedicata a Face/Upscale e varianti immutabili, più backlog esplicito per retry/cancel, transizioni, storage, health check e test GPU.

## 26 agosto 2026 — Face Refiner, Latent Upscaler e varianti nell'app

- Aggiunta migrazione SQLite v11 con `candidate_variants` e collegamento opzionale della variante alla clip di timeline.
- Implementato il servizio persistente per `Face`, `Upscale` e pipeline combinata `Face + Upscale`, senza sovrascrivere il candidato originale.
- Integrato il Latent Upscaler 3D direttamente nel sampler H3: prima generazione a risoluzione ridotta, upscale latent e breve refine alla risoluzione richiesta con audio bloccato.
- Costruito il workflow API FaceRefine per crop/tracking per-frame, denoise progressivo, reinserimento sul video e conservazione dell'audio nativo.
- Aggiunti nell'interfaccia selettore versione, azioni di post-produzione, progressi e scelta del derivato per Continue, Edit e timeline.
- Il montaggio risolve ora il file della variante selezionata e permette di tornare all'originale in qualunque momento.
- Aggiunti preflight sui nodi ComfyUI: un processo non riavviato viene fermato prima della coda con un messaggio esplicito.
- Verificati typecheck bridge, build Vinext, repository progetti, export timeline, libreria creativa e contratto Krea 2.
- Installato il loader PDD-Acc dedicato e spostati i due pesi ufficiali FL2VA/Ref2VA in `models/pdd_acc`; 13 test del nodo superati. Il profilo resta sperimentale perché richiede un modello base corrispondente e non va sommato al Turbo.
- Aggiunta l'icona cestino sui candidati completati e sui video della Libreria media.
- La cancellazione rimuove atomicamente il candidato da ogni timeline, rinumera le clip residue, elimina le varianti Face/Upscale e cancella soltanto i file confinati nella cartella output ComfyUI.
- Bloccata la cancellazione di candidati o varianti ancora in esecuzione; se era l'ultimo candidato viene rimosso anche il batch rimasto vuoto.
- Esteso il test repository: verificata la rimozione dello stesso candidato da tre montaggi e del relativo job vuoto.

## 26 agosto 2026 — FAST Alibaba PDD-Acc in produzione applicativa

- Separato il motore FAST dal workflow H3 standard: l'interfaccia espone ora `FAST / 8 / 12 / 20 / 30` senza l'ambiguo interruttore Turbo.
- FAST usa un workflow API derivato dedicato, PDD-Acc a 8 NFE, Euler, sigmas PDD, CFG 1 e SigmaShift 12/3; i preset numerici mantengono il motore H3 standard.
- Aggiunto in Admin un pannello FAST indipendente con modello base, file PDD reale da `models/pdd_acc` e fino a tre LoRA creativi.
- Bloccati Hybrid/Ref-Delta, coppie Ref2VA/FL2VA discordanti e LoRA Turbo/distill/cache nello stack FAST.
- Esteso il sampler `H3ReferenceMemorySampler` con applicazione PDD interna e preflight sul processo ComfyUI attivo.
- Aggiunta migrazione SQLite v12: ogni job registra `engine_profile` e `pdd_file` oltre allo snapshot API.
- Verificati typecheck, build Vinext, migrazioni/repository, sintassi Python e test non-GPU FAST/8 standard.

## 26 agosto 2026 — Packaging GitHub e onboarding locale

- Rimossi dal launcher e dai default applicativi i percorsi personali `C:/Users`, `D:` e `F:`.
- Aggiunto wizard di primo avvio con creazione password Admin, URL ComfyUI, cartella output, FFmpeg e associazione dei workflow inclusi.
- Password derivata con `scrypt`, sessioni Admin HTTP-only e protezione server-side di tutte le rotte `/api/admin/*`.
- Aggiunti catalogo workflow, grafo Krea 2 pronto e manifest interrogabile di custom node/modelli richiesti.
- L'Admin mostra lo stato reale delle dipendenze e permette di cambiare server e profili; le modifiche infrastrutturali richiedono riavvio esplicito.
- Aggiornati launcher first-run, `.env.example`, `.gitignore`, metadati package e guida di installazione portabile.
- Sanitizzati gli snapshot UI/API: rimossi preset, prompt, media e LoRA personali; lo stack viene popolato soltanto dalle impostazioni Admin.
- Incluso lo snapshot esteso del nodo H3 Studio con licenza MIT upstream, commit base e sole risorse attive.
- Aggiunto installer ComfyUI recuperabile con backup del nodo H3 esistente, clone dei nodi esterni e requirements Python opzionali.
- Esteso il manifest ai workflow video, FAST, Krea, Face e Upscale, con verifica live di nodi e pesi e cartelle visibili nell'Admin.
- Aggiunta CI GitHub Windows per sanitizzazione, typecheck, test principali e build.

## 26 agosto 2026 — Stop sicuro, Upscale 1 MP e fix FAST PDD

- Diagnosticato il primo run FAST: il modello pruned espone AdaLN 8-wide mentre il PDD ufficiale richiede la matrice AdaLN completa; la combinazione viene ora bloccata prima della coda.
- Impostato come default FAST il Ref2VA INT8 ConvRot ufficiale non-pruned e aggiornati workflow, Admin, manifest dipendenze e test.
- Aggiunto Stop per generazioni e varianti: i prompt pendenti del job vengono rimossi e il prompt attivo viene interrotto soltanto in assenza di run ComfyUI estranei.
- Persistito il motivo `Interrotto su richiesta` sui candidati e reso evidente l'avanzamento di Face/Upscale sopra il player.
- Corretto Upscale affinché punti esplicitamente a 0,98 MP; le azioni UI ora distinguono `Upscale 1 MP` e `Face + 1 MP`.
- Verificati JSON, typecheck, test completi, sanitizzazione e build di produzione.
- Aggiunto nell'Admin il riavvio controllato del solo bridge H3, con riconnessione e ricarica automatica della pagina; ComfyUI e i job GPU restano attivi.
- Corretto il footer delle preview: Face/Upscale e le azioni principali usano due griglie interne a tre colonne, mentre le versioni scorrono orizzontalmente senza uscire dalla card.
- Le esecuzioni fallite non mostrano più una barra di avanzamento indeterminata e possono essere eliminate anche quando ComfyUI non ha prodotto alcun file.
- Montaggi ora include il browser delle candidate appartenenti al progetto, con anteprima e selezione preventiva di Originale, Face, Upscale o Face + Upscale; la versione resta sostituibile anche dopo l’aggiunta in timeline.

## 27 agosto 2026 — Abbinamento sicuro FAST PDD Ref2VA/FL2VA

- Centralizzata la matrice delle due coppie ufficiali non-pruned: Ref2VA con PDD Ref2VA e FL2VA con PDD FL2VA; il backend rifiuta modelli simili ma non ufficiali oltre a mismatch, pruned e GGUF.
- L’Admin auto-abbina la patch quando cambia il modello FAST e mostra nel selettore soltanto i file PDD compatibili con la famiglia attiva.
- Esteso il manifest dipendenze con entrambi i modelli base INT8 ConvRot ufficiali; ne basta uno con la patch corrispondente, mentre entrambi permettono il cambio famiglia dall’Admin.
- Esteso il test FAST con il percorso positivo FL2VA, la selezione automatica della patch, il filtro anti-mismatch, il manifest e il rifiuto dei modelli non ufficiali.
- Verificati `npm run test:fast`, `npm run typecheck -- --incremental false` e build Vinext con Node 24, senza coda GPU né avvio dei server.

## 27 agosto 2026 — Studio Immagini e Flux.2 Klein

- Unificati Studio Video e Studio Immagini nello stesso progetto con selettore dedicato, batch da uno-quattro candidati e composer coerente.
- Aggiunti Generate Krea 2 ed Edit Flux.2 Klein 4B Distilled con massimo quattro reference, ruoli espliciti, formati sotto 2 MP e seed Random/Base/Bloccato.
- Persistiti job, candidati, prompt API, output, reference ordinate e collegamenti per-candidato molti-a-molti fra progetti nella migrazione SQLite v15.
- Aggiunti tag Personaggio/Oggetto/Paesaggio per progetto, riuso immediato dell’output come base edit, download, scelta, cancellazione, stop e recupero dopo riavvio.
- Collegati realmente i blueprint workflow selezionati nell’Admin; modello, encoder, VAE, step, CFG, attention e Flux KV Cache sono configurabili con preflight live.
- Scelto come default il profilo core 4B Distilled FP8 a quattro step/CFG 1; il vecchio Multi Input Compact 9B/5-reference resta solo un riferimento perché più pesante e meno portabile.
- Corrette condivisione isolata per candidato, annotation input/output, polling fra progetti, ripristino dei draft edit, thumbnail upload e routing automatico alle azioni Video.
- Aggiunti guida Image Studio, manifest modelli, workflow API sanitizzato, test di regressione e job CI dedicato.

## 27 agosto 2026 — Upscale 1/2 MP e Face sulla variante attiva

- Aggiunti target Upscale 1 MP (0,98 interno) e 2 MP (1,96 interno), mostrati soltanto quando aumentano realmente la risoluzione del candidato.
- Resa reale la sorgente selezionata: Face può partire dall'originale o da un Upscale pronto e usa il relativo file video/audio senza rieseguire l'upscale.
- Persistiti `source_variant_id` e `target_megapixels` nella migrazione SQLite v16, con backfill delle varianti legacy a 1 MP.
- Propagati lineage e target nelle timeline, nella cronologia e nelle etichette delle versioni; l'originale resta immutabile.
- Bloccate lato server sorgenti di altro job/candidato, non pronte, non Upscale e target non superiori alla sorgente.
- Aggiunti test dedicati per prompt 0,98/1,96 MP, catena Upscale→Face, audio del parent, migrazione, validazioni e cambio variante in timeline; CI Windows aggiornata.
- Verificati typecheck, repository, export, Image Studio, Krea, FAST, cancellazione, restart, sanitizzazione e build Vinext. Resta il test GPU manuale di 2 MP e sincronizzazione A/V.
- Diagnosticato un run richiesto a 2 MP ma realmente partito a 0,98 MP: il frontend aggiornato stava parlando con un bridge precedente che ignorava il nuovo target.
- Aggiunto `postprocessContract: 2` all'health del bridge; Upscale e Face da variante vengono bloccati prima della coda se il contratto manca.
- Aggiunto un dialog accessibile di conferma obbligatoria per ogni Upscale, con target, sorgente, avviso tempo/VRAM, Escape, focus trap e layout mobile.
- Esposto `processingSeconds` per candidati e varianti terminali usando i timestamp persistiti; footer, versioni e cronologia mostrano il tempo comprensivo della coda.
- Protetti i timestamp terminali da aggiornamenti tardivi e aggiunti test di regressione per durata storica, lineage timeline e immutabilità dello stato concluso.
- Rinominato il tag immagini `Sfondo` in `Paesaggio` e la voce di navigazione `Personaggi` in `Assets`; i valori persistiti e il ruolo reference `Sfondo` restano invariati per compatibilità.

## 27 agosto 2026 — Bridge precedente e recupero tempi

- Individuata la causa dei tempi mancanti e del click Upscale 2 MP apparentemente inerte: un bridge locale precedente era sopravvissuto al riavvio sulla porta `8787`, quindi non esponeva `postprocessContract: 2` né `processingSeconds`.
- Reso fail-closed il launcher: termina soltanto il processo Node che esegue `bridge/server.ts` nella stessa `ProjectRoot`; un listener estraneo, ambiguo o cambiato durante la verifica blocca l'avvio senza essere terminato.
- Il dialog Upscale ora si apre anche con un backend precedente, mostra l'errore di contratto e disabilita la conferma, così il problema non appare più come un click ignorato e non raggiunge la coda ComfyUI.
- Aggiunto `repair:processing-times`: dry-run predefinito, apply consentito solo con `--bridge-stopped`, backup SQLite verificato, controllo dei percorsi reali nell'output ComfyUI e aggiornamenti condizionali dei soli candidati idonei.
- Sei tempi legacy risultano ricostruibili dal file MP4; un job importato ha un output precedente alla creazione del candidato e viene escluso dalla riparazione anziché ricevere una durata inventata.

## 27 agosto 2026 — Continuità nativa fra job Continue

- Ogni candidato H3 Studio salva ora il proprio latent H3 AV nativo in uno slot deterministico separato dal video consegnato.
- Continue riconosce job e candidato dal media selezionato, carica il latent video+audio e lo passa a Motion Context senza decodifica e ricodifica.
- La catena Continue 1→2→3 conserva quindi lo stesso contesto transitivo usato internamente dal multishot, pur mantenendo segmenti e job separati.
- I video legacy, importati o generati a una risoluzione incompatibile continuano a funzionare con il fallback degli ultimi 22 frame decodificati.
- La cancellazione di un candidato rimuove anche il relativo cache latent; i path sorgente accettano soltanto UUID di job e indici candidato 1–4.
- Verificati sintassi Python, regressione Continue, mapping FAST/standard, cancellazione repository e typecheck con Node 24.

## 27 agosto 2026 — Motore immagini Anima

- Aggiunta la modalità Anima accanto a Genera/Edit nello Studio Immagini, mantenendo preset, seed, batch e progetti esistenti.
- Creato un workflow API core Anima e un profilo Admin separato con checkpoint, encoder, VAE, step, CFG e fino a tre LoRA.
- Rilevati tramite gli external path i pesi locali Anima; impostato il default Turbo a 8 step/CFG 1 senza LoRA applicati implicitamente.
- Estesi wizard, catalogo, dipendenze, preflight, persistenza compatibile e test automatici; la modalità chat resta pianificata per un incremento successivo.

## 27 agosto 2026 — Rigenera candidato e batch

- Aggiunta l'azione Rigenera a ogni video e immagine completata, inclusi Generate, Edit e Anima.
- Aggiunta Rigenera batch, che conserva il numero originale di candidati (uno-quattro) e tutte le impostazioni persistite.
- La rigenerazione crea un nuovo job non distruttivo e garantisce seed diversi da quelli del batch sorgente; l'originale resta nel progetto.

## 28 agosto 2026 — Prompt Compiler universale e TTS reference automatiche

- Esteso LLM come Prompt Compiler specializzato per Krea, Flux.2 Klein Edit, Anima e Higgs TTS; le richieste possono essere scritte in qualunque lingua e il prompt tecnico resta modificabile.
- In Edit il compiler conserva ordine e ruolo delle reference e istruisce il motore a mantenere invariati gli elementi non richiesti; Anima riceve una descrizione illustrativa dedicata.
- Il TTS Planner mantiene la lingua pronunciata, separa regia e copione e usa soltanto la whitelist reale di token Higgs per emotion, prosody, style e sfx.
- Aggiunta trascrizione automatica delle reference con `openai/whisper-small`: processo Python separato, cache locale, testo correggibile, fallback manuale e rilascio VRAM prima di Higgs.
- Verificati realmente TTS Planner italiano, Flux Edit da richiesta italiana, `loaded: false` dopo LLM e trascrizione Whisper con processo terminato.

### 28 agosto 2026 — Libreria immagini sincronizzata e tag Luoghi

- La Libreria usa ora la stessa sorgente dei job immagine mostrati in Assets: Personaggi, Oggetti e Luoghi collegati compaiono in entrambe le viste senza duplicare i file.
- Le immagini senza tag restano visibili in una sezione dedicata; rinomina, eliminazione, selezione multipla e Manda a Studio operano sul medesimo record.
- L'etichetta utente Paesaggio è stata rinominata Luogo; il valore persistito `background` e il ruolo reference Sfondo restano invariati per compatibilità.
### 28 agosto 2026 — Terminologia e selezione LLM neutrali
- Interfaccia, messaggi, errori e documentazione pubblica usano ora le diciture generiche `LLM`, `LLM Vision` e `planner LLM`.
- Admin e nodo Chat elencano qualunque modello GGUF non-projector, senza filtrare il catalogo in base al nome di uno specifico modello.
- Identificatore e cartella legacy del nodo restano invariati soltanto per compatibilità con installazioni e workflow esistenti.

### 28 agosto 2026 — Eliminazione montaggi dalla Libreria
- Ogni montaggio in Libreria dispone ora di cestino con conferma esplicita e supporta anche la selezione multipla.
- L'eliminazione rimuove atomicamente timeline e collegamenti delle clip; video sorgente, varianti e media del progetto restano invariati.
- Aggiunti endpoint DELETE, test della cascata SQLite e regressione UI.


### 28 agosto 2026 — Cantato e lyrics preservate in Chat
- Il routing musicale riconosce deterministicamente cantato, voce, vocalist, testo e ritornello, evitando il precedente fallback strumentale.
- Le parole quotate dall'utente vengono preservate letteralmente e passate al Music Planner come lyrics separate; la richiesta originale resta disponibile al secondo planner.
- Il popup Rigenera dei job musicali mostra e trasmette separatamente caption e lyrics modificabili.
- Aggiunti test sul caso italiano «Buongiornissimo caffè» e sulle richieste esplicitamente strumentali.


### 28 agosto 2026 — Passaggio diretto Immagine → Video
- Le immagini generate nello Studio espongono ora l’azione **Video** al posto del controllo visibile **Scegli**.
- La stessa azione è disponibile sulle reference ricevute da Libreria/Assets o caricate per l’edit.
- Il passaggio apre il tab Video, imposta l’immagine come Picture 1, seleziona Reference e azzera il prompt senza duplicare o ricaricare il file.
- La compatibilità dati con la selezione candidato storica e il relativo endpoint resta invariata.

### 28 agosto 2026 — Persistenza sincrona modello Anima / Nova AM
- La selezione del modello Anima aggiorna ora il riferimento autorevole prima del render React: un click rapido su Salva non può più inviare il precedente anima_turboV10.
- Aggiunta regressione sul percorso Admin per impedire il ritorno del setter asincrono che causava il ripristino del default.

### 28 agosto 2026 — Conversione timbrica locale e lip-sync H3
- Aggiunta la modalità **Canzone col mio timbro**: MiniMax Music genera testo e performance, BS-RoFormer Q8 separa gli stem, Seed-VC Q8 trasferisce il timbro e FFmpeg produce il WAV stereo finale.
- audio.cpp viene avviato per una sola fase alla volta e sempre terminato; Stop annulla sia il prompt ComfyUI sia il processo di separazione/conversione attivo, con scaricamento VRAM nel `finally`.
- Aggiunti configurazione Admin, stato runtime, progressione esplicita nel pannello Audio e installer riprendibile `INSTALL_AUDIO_VOICE.bat` per binari ufficiali v0.7 e modelli esterni.
- La Chat riconosce richieste di canzone «con la mia voce / col mio timbro» e usa automaticamente la reference allegata.
- Per i video con reference vocale il router forza H3 Reference, lega `<Audio 1>` al soggetto parlante, preserva il dialogo e richiede sincronizzazione labiale naturale.

### 29 agosto 2026 — Avvio idempotente dopo il riavvio Admin
- Corretto il riconoscimento del bridge rilanciato dall'Admin, il cui runtime `tsx` usa il percorso fisico pnpm anziché il collegamento diretto in `node_modules`.
- Se il bridge della stessa installazione risponde a `/api/health`, `START_H3_STUDIO.bat` lo conserva e avvia soltanto il frontend; un bridge riconosciuto ma non responsivo viene invece sostituito.
- Restano fail-closed i listener estranei, ambigui o cambiati durante il controllo; aggiunta una regressione Windows che verifica riuso sano, cleanup stale e rifiuto del processo estraneo.
