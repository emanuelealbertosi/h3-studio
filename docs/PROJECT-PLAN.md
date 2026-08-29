# H3 Studio — Documento di progetto e tracking

Ultimo aggiornamento: 26 agosto 2026  
Stato: **Milestone 4–7 utilizzabili; packaging GitHub pronto, utenti/crediti e collaudo GPU completo ancora da completare**

## 1. Visione

H3 Studio deve offrire un'esperienza da studio video moderno sopra ComfyUI. L'utente lavora con progetti, personaggi, scene, candidati e continuazioni; il client traduce queste operazioni in esecuzioni riproducibili del workflow MiniMax H3.

Principio guida: **ComfyUI è il motore, H3 Studio è lo studio di produzione**.

## 2. Obiettivi

- Generare da 1 a 4 candidati dello stesso shot con seed differenti.
- Eseguire i candidati in sequenza per non moltiplicare la VRAM.
- Mostrare ogni job nello stesso riquadro: blurred, progresso, risultato riproducibile.
- Confrontare e selezionare un candidato senza cancellare le alternative.
- Continuare o editare un video sorgente lungo fino a 10 secondi.
- Conservare prompt, seed, modelli, LoRA e tutti i parametri.
- Gestire personaggi e riferimenti in una libreria riutilizzabile.
- Controllare accessi e consumi mediante utenti, autorizzazioni e crediti.
- Restare local-first; hosting e sincronizzazione cloud sono opzionali.

## 3. Vincoli di prodotto approvati

### Durata

- Output selezionabile: **5 oppure 10 secondi**.
- Nessuna durata superiore nel generatore singolo.
- `Continue video`: accetta una sorgente fino a 10 secondi e aggiunge 5 o 10 secondi.
- `Edit video`: accetta una sorgente fino a 10 secondi e mantiene di default la stessa durata.
- Video lunghi: costruiti come sequenze di chunk collegati nella timeline.

### Risoluzione

- `MIN`: 0,5 MP.
- `MID`: 0,7 MP.
- `MAX`: 0,98 MP, allineato alla risoluzione H3 nativa. I vecchi job a 1,0 MP vengono normalizzati a 0,98 MP.
- Formato selezionabile fra tutti gli 11 aspect ratio esposti dal nodo H3: 16:9, 9:16, 1:1, 4:3, 3:4, 3:2, 2:3, 21:9, 9:21, 5:4 e 4:5.

### Candidati

- Numero selezionabile: 1, 2, 3 o 4.
- Film strip fissa con quattro slot di uguale dimensione, riempiti da sinistra.
- Gli slot non cambiano dimensione quando varia il numero dei candidati.
- Su browser stretti scorre orizzontalmente senza mandare i candidati a capo.
- I job vengono accodati, non eseguiti contemporaneamente sulla GPU.

### Modalità

- Text to video.
- Image to video.
- Reference to video.
- Keyframes.
- Continue video.
- Edit video.
- Refine/upscale come fase separata.
- Continuità video e audio quando il workflow la supporta.

## 4. Preset qualità

### FAST

- Motore separato Alibaba PDD-Acc a 8 NFE.
- Modello base dedicato Ref2VA o FL2VA non-pruned, abbinato obbligatoriamente al PDD della stessa famiglia; varianti AdaLN pruned/8-wide sono bloccate prima della coda.
- Ricetta bloccata: Euler, sigmas PDD, CFG 1, SigmaShift video/audio 12/3, strength trunk/head 1.
- Nessun Turbo/distill LoRA e nessun cache pack; sono ammessi fino a tre LoRA creativi/personaggio.
- 5 o 10 secondi.
- Risoluzione predefinita 0,5 MP, modificabile fino a 0,98 MP.
- Scopo: selezione rapida di idea, seed, composizione e movimento.

### 8 / 12 / 20 / 30

- Workflow H3 standard con modello e massimo tre LoRA scelti nel pannello Admin H3.
- 8 step è il test standard rapido senza PDD; 12/20/30 aumentano progressivamente l'effort.
- Nessun cambio implicito di modello o LoRA passando fra i quattro valori.

### FINAL

- 5 o 10 secondi.
- 0,7 o 0,98 MP consigliati.
- Step e modello definitivi.
- Opzione A: refine/upscale del candidato selezionato per preservare il movimento.
- Opzione B: rigenerazione dopo CONFIRM, accettando possibili differenze.

### Avvertenza di coerenza

Lo stesso seed non garantisce lo stesso video passando dal modello/PDD FAST al
motore H3 standard. FAST è una selezione creativa, non una proxy pixel-perfect
della final; per un confronto controllato fra step usare 8/12/20/30 sul motore standard.

## 5. Esperienza principale

### Explore

1. L'utente sceglie modalità, prompt, asset, durata, qualità e numero candidati.
2. Il costo in crediti viene mostrato prima dell'invio.
3. I riquadri compaiono immediatamente blurred.
4. Ogni riquadro mostra fase corrente, percentuale e progress bar.
5. I candidati vengono eseguiti in sequenza.

### Choose

1. Lo stesso riquadro blurred diventa il player del video completato.
2. L'utente può riprodurre e confrontare i candidati.
3. `Scegli` marca il vincitore senza eliminare gli altri.

### Continue

1. `Continua` usa automaticamente il candidato selezionato come sorgente.
2. L'utente sceglie 5 o 10 secondi per il nuovo chunk.
3. Può generare nuovamente 1–4 continuazioni.
4. Il nuovo shot mantiene il legame con il genitore nella timeline.

### Edit

1. `Edita` apre la modalità VIDEO EDITING con sorgente già compilata.
2. Prompt, riferimenti e maschere/guide vengono aggiunti senza copiare manualmente file.
3. La durata predefinita corrisponde alla sorgente, massimo 10 secondi.

### Montaggio non distruttivo

- Ogni generazione produce un file clip autonomo e immutabile da 5 o 10 secondi.
- `Continue` usa la coda del clip genitore come contesto, ma salva soltanto il nuovo spezzone.
- Se il workflow restituisce sorgente e continuazione unite, il bridge separa automaticamente la parte nuova.
- `Edit` crea una nuova versione sostitutiva; non sovrascrive il clip sorgente.
- La timeline conserva ordine, clip scelti, punti in/out, transizioni e diramazioni.
- Il playback dello Studio concatena virtualmente i clip selezionati senza creare un nuovo file.
- Soltanto `Esporta` genera il video unico finale tramite FFmpeg.
- Eventuali frame di contesto o overlap vengono conservati come dati tecnici e rimossi dal playback per evitare duplicazioni alle giunzioni.

## 6. Server e persistenza

### Bridge locale

Scelta: **Node.js + TypeScript + Fastify**.

Responsabilità:

- API stabile verso il browser.
- connessione HTTP/WebSocket a ComfyUI su endpoint configurabile;
- mapping e override controllato del workflow;
- coda sequenziale dei candidati;
- stato live, errori e cancellazione;
- indicizzazione output e metadati;
- autorizzazioni e calcolo crediti server-side.

### Dati

- SQLite locale per progetti, utenti, ledger crediti, shot e candidati.
- Filesystem locale per immagini, video, audio, workflow e thumbnail.
- Il database non contiene blob video.
- Firebase potrà aggiungere Auth, hosting e sync selettivo in una fase successiva.
- ComfyUI non deve essere esposto direttamente a Internet.

## 7. Utenti e console admin

### Stati utente

- `pending`: autenticato ma non ancora abilitato.
- `active`: autorizzato a usare lo Studio.
- `blocked`: accesso e nuove generazioni revocati.

### Console `/admin`

- Login amministratore protetto.
- Elenco utenti e ricerca.
- Autorizza, blocca e riattiva.
- Saldo crediti e cronologia movimenti.
- Assegnazione o revoca manuale con motivazione.
- Ultimo accesso e stato sessioni.
- Audit log delle azioni amministrative.
- Sezione `Engine`: workflow backend H3 e grafo Krea visibili; liste reali lette da ComfyUI; modello, step e fino a tre LoRA/strength configurabili separatamente per H3 e Krea. Gli altri parametri restano sui default validati.

### Sicurezza

- Password mai salvate nel codice o nel browser.
- Hash resistente e sessione HttpOnly protetta.
- Ogni autorizzazione viene verificata server-side.
- Il blocco invalida le sessioni e impedisce nuovi job.
- Nel passaggio cloud, Firebase Auth identifica l'utente ma il bridge mantiene l'allowlist applicativa.

## 8. Sistema crediti

### Principi

- I crediti rappresentano effort relativo della GPU.
- Il costo è calcolato dal server e mostrato prima dell'esecuzione.
- Dotazione iniziale predefinita: **500 crediti per utente**, modificabile dall'admin.
- Nessun rinnovo automatico nella prima versione.
- Nessun saldo negativo.

### Formula iniziale

```text
costo = base × durata × megapixel × step × modalità × candidati
```

Unità di riferimento: 5 secondi, 0,5 MP, FAST PDD 8 NFE, un candidato = **20 crediti**. Il vecchio 4-step non viene esposto.

- 10 secondi: ×2.
- 0,7 MP: ×1,4.
- 0,98 MP: ×1,96.
- 8 step: ×2 rispetto al costo legacy 4-step.
- 12 step: ×3.
- 20 step: ×5.
- Ogni candidato moltiplica linearmente.
- Reference/Keyframes: coefficiente iniziale 1,15.
- Continue/Edit: coefficiente iniziale 1,20.
- I coefficienti verranno calibrati con telemetria reale senza cambiare retroattivamente i job.

### Transazioni

- `grant`: crediti assegnati dall'admin.
- `reserve`: costo prenotato quando il job entra in coda.
- `settle`: addebito definitivo.
- `refund`: rimborso.
- `revoke`: sottrazione amministrativa motivata.

Regole:

- Cancellazione prima dell'avvio: rimborso completo.
- Errore di validazione/configurazione: rimborso completo.
- Job iniziato: addebito proporzionale al lavoro registrato, fino al costo massimo preventivato.
- Ogni movimento è immutabile e riconducibile a utente, job e amministratore.

## 9. Modello dati essenziale

### Project

id, proprietario, nome, workflow, preset, cartella dati, date.

### Sequence

id, projectId, nome, percorso di candidati scelti, ordine e impostazioni globali.

### Shot

id, sequenceId, parentCandidateId, prompt originale/elaborato, modalità, durata e qualità.

### Candidate

id, shotId, indice 1–4, seed, stato, promptId ComfyUI, output, thumbnail e snapshot immutabile.

### Character

id, proprietario, nome, descrizione identitaria, reference multiple, look, voce e dati di origine.

### User

id, identityProviderId, email, ruolo, stato, saldo derivato e ultimo accesso.

### CreditTransaction

id, userId, jobId opzionale, tipo, quantità firmata, motivazione, actorId e timestamp.

## 10. API prevista

| Metodo | Endpoint | Funzione |
|---|---|---|
| GET | `/api/health` | Bridge, ComfyUI e storage |
| GET | `/api/capabilities` | Modelli, LoRA, modalità e preset |
| CRUD | `/api/projects` | Progetti |
| CRUD | `/api/library` | Personaggi, oggetti e riferimenti |
| POST | `/api/library/:id/krea/dry-run` | Verifica sheet senza GPU |
| POST | `/api/library/:id/krea/generate` | Genera sheet Krea 2 |
| POST | `/api/shots/:id/candidates` | Accoda 1–4 candidati |
| POST | `/api/candidates/:id/select` | Seleziona candidato |
| POST | `/api/candidates/:id/continue` | Crea shot figlio |
| POST | `/api/candidates/:id/edit` | Prepara VIDEO EDITING |
| POST | `/api/candidates/:id/refine` | Refine/upscale |
| GET | `/api/candidates/:id/variants` | Elenca originale e derivati face/upscale |
| POST | `/api/candidates/:id/variants` | Crea face refine, upscale o pipeline combinata |
| POST | `/api/candidates/:id/retry` | Riprova soltanto il candidato fallito |
| POST | `/api/jobs/:id/cancel` | Cancella job/candidati non ancora conclusi |
| GET | `/api/jobs` | Coda corrente |
| GET | `/api/credits/estimate` | Preventivo server-side |
| GET | `/api/credits/ledger` | Movimenti dell'utente |
| GET | `/api/admin/users` | Utenti e saldi |
| POST | `/api/admin/users/:id/status` | Autorizza/blocca |
| POST | `/api/admin/users/:id/credits` | Assegna/revoca crediti |
| WS | `/api/events` | Progressi ed eventi live |

## 11. Strategia workflow

- Non modificare il workflow stabile.
- Creare `FINAL-MiniMax H3 AIO AUTOPROMPT ULTRA - STUDIO BACKEND.json`.
- Versionare anche l'export API.
- Mappare gli input con nomi semantici e firma del workflow.
- Applicare override a prompt, seed, modalità, durata, MP, profilo engine, step, sampler, scheduler, modello, PDD, LoRA, reference, keyframe, memory, anchor e output prefix.
- Salvare per ogni candidato il prompt API realmente inviato.

## 12. Roadmap

Legenda: `[x]` completato e verificato; `[~]` parziale o presente solo a livello UI/ComfyUI; `[ ]` mancante.

### Milestone 0 — Fondamenta

- [x] Visione local-first.
- [x] Stack frontend e bridge.
- [x] Vincoli durata, qualità e candidati.
- [x] Preset FAST/8/12/20/30 con engine FAST separato.
- [x] Modello admin e crediti.
- [x] Scaffold installato su `F:\H3-Studio`.
- [x] Documento di progetto e architettura.

### Milestone 1 — Product shell

- [x] Layout Studio riconoscibile.
- [x] Selettore 1–4 candidati.
- [x] Selettore 5/10 secondi.
- [x] Selettore 0,5/0,7/0,98 MP.
- [x] Modalità principali visibili.
- [x] Stima crediti dimostrativa.
- [x] Stati blurred, progresso e risultato.
- [x] Azioni Scegli/Continua/Edita visibili.
- [~] Rifinitura responsive dopo feedback utente; restano test sistematici su portatile, tablet e mobile.

### Milestone 2 — Bridge ComfyUI

- [x] Scaffold Fastify e configurazione locale.
- [x] `/api/health` e connessione ComfyUI.
- [x] Canale WebSocket eventi predisposto.
- [x] Copia workflow Studio Backend e mappa input.
- [x] Dry-run FAST PDD e 8 standard con override e validazione della coppia Ref2VA/FL2VA.
- [x] Invio reale 1–4 promptId, monitoraggio history e player MP4 via bridge.
- [x] Primo job T2V reale, output MP4 verificato e importato nella cronologia persistente.
- [x] Indicizzazione output MP4 da history ComfyUI e persistenza del riferimento nel database.

### Milestone 3 — Candidate Studio reale

- [x] Coda ordinata 1–4 affidata alla coda seriale di ComfyUI, senza esecuzione GPU parallela.
- [x] Seed fixed/base/random.
- [x] Stima costo/tempo lato client per feedback immediato.
- [ ] Costo autorevole server-side e reserve/settle/refund.
- [x] Player reali e confronto sincronizzato.
- [x] Selezione persistente.
- [ ] Errori e retry per singolo candidato.
- [ ] Cancellazione di job e candidati in coda con rimborso coerente.
- [x] Persistenza SQLite locale di job, candidati, prompt API, seed e output.
- [x] Recupero promptId e risultati dopo riavvio del bridge.

### Milestone 4 — Continue, Edit e timeline

- [x] Continue 5/10 secondi con relazione al progetto e job sorgente.
- [x] Edit di sorgenti fino a 10 secondi.
- [x] Builder Continue/Edit validato in dry-run per 5/10 secondi.
- [x] Clip autonomi con estrazione della sola continuazione.
- [x] Playback virtuale concatenato.
- [x] Timeline a chunk.
- [x] Montaggi multipli per progetto.
- [x] Trim in/out e volume per clip.
- [x] Audio esterno con gain, loop e mux/mix FFmpeg.
- [x] Copia e spostamento non distruttivo delle clip fra progetti.
- [ ] Albero versioni.
- [~] Continuità video/audio: mapping Continue/Edit e policy audio presenti; manca il collaudo GPU completo di tutte le combinazioni e degli overlap.
- [ ] Transizioni visive/audio reali fra clip oltre al taglio diretto.
- [x] Export finale FFmpeg con concat rapido, fallback H.264/AAC e download dalla UI.

### Milestone 5 — Admin e utenti

- [x] Console Engine locale per H3 e Krea con liste reali ComfyUI, modelli, step e tre LoRA.
- [x] Bootstrap amministratore al primo avvio con password derivata via scrypt.
- [x] Login Admin e sessioni HTTP-only protette server-side.
- [x] URL ComfyUI, output, FFmpeg e associazione workflow configurabili dall'Admin.
- [x] Riavvio controllato del bridge direttamente dall'Admin, senza interrompere ComfyUI.
- [x] Checklist live di custom node e pesi con nomi/cartelle reali.
- [ ] Stati pending/active/blocked.
- [ ] Ledger e dotazione 500 crediti.
- [ ] Console autorizza/blocca/crediti.
- [ ] Audit log.

### Milestone 6 — Libreria personaggi

- [x] Import reference multiple per personaggi e oggetti.
- [x] Drag and drop nella scheda e passaggio diretto allo shot.
- [x] Ruoli subject/picture/reference compilati automaticamente.
- [x] Character/Object sheet con builder Krea 2 e dry-run validato.
- [x] Picker media nel prompt tramite `@`, riuso diretto dalla libreria e didascalia/ruolo per asset.
- [ ] Versioni look/abiti/voce.

### Milestone 7 — Studio immagini

- [x] Selettore Video/Immagini nello Studio e layout candidati/composer coerente.
- [x] Generazione Krea 2 generica con uno-quattro candidati e seed riproducibili.
- [x] Generazione Anima con workflow core e profilo Admin indipendente (modello, encoder, VAE, step, CFG e tre LoRA).
- [x] Rigenerazione rapida per singolo candidato o intero batch, su video e immagini, con impostazioni conservate e seed nuovi.
- [x] Edit Flux.2 Klein 4B Distilled con una-quattro reference ordinate.
- [x] Ruoli Base/Soggetto/Stile/Posa/Sfondo tradotti nella mappa reference del prompt.
- [x] Tag Personaggio/Oggetto/Luogo per candidato e per progetto.
- [x] Condivisione molti-a-molti delle singole immagini senza esporre il resto del batch.
- [x] Persistenza SQLite, recupero polling, scelta, cancellazione e riuso output come reference.
- [x] Workflow, modello, encoder, VAE, step, CFG, attention e KV Cache configurabili nell’Admin.
- [x] Preflight live di workflow, nodi e pesi prima della creazione del job.
- [x] Profilo pubblico core confrontato con il vecchio Multi Input Compact 9B/5-reference.
- [~] Pesi ufficiali Flux 4B, Qwen 3 4B e Flux2 VAE in download verificato su F; manca il primo test GPU reale.

### Milestone 8 — Face refine, upscale e varianti

- [x] Nodo `Comfyui_Minimax_h3_latent_Upscaler` presente nella ComfyUI NVMe.
- [x] `ComfyUI-H3-FaceRefine`, `ComfyUI-H3-NativeAudioLock` e `face_yolov8m.pt` installati; attivazione al prossimo riavvio ComfyUI.
- [~] Dipendenze FaceRefine verificate; InsightFace usa attualmente ONNX CPU, scelta conservativa per non sostituire il runtime mentre ComfyUI è attiva.
- [~] Workflow API FaceRefine rettangolare/per-frame costruito e validato staticamente; manca il test GPU dopo il riavvio ComfyUI.
- [~] Latent Upscaler 3D integrato nel sampler con target espliciti 0,98 e 1,96 MP, validazione source < target e test statici; manca il test GPU a 2 MP.
- [x] Modello dati immutabile `CandidateVariant`: originale, face, upscale e face+upscale con lineage e target MP persistiti.
- [~] Servizio derivati persistente con coda, progressi, tempo terminale, recupero, errori indipendenti e cancellazione sicura; retry ed ETA calibrata restano da aggiungere.
- [x] Pulsanti per clip/candidato e selezione esplicita della variante inviata a Studio o timeline.
- [x] Conferma obbligatoria prima di Upscale e contratto health che blocca browser/bridge non allineati prima della coda.
- [x] Render timeline `Originale` o con il derivato scelto per ciascuna clip.
- [x] Cancellazione candidato dalla scheda o dalla Libreria con rimozione atomica da tutti i montaggi, varianti e file output.
- [~] Ordine supportato fissato a upscale→face, con Face applicato al file Upscale pronto senza rigenerarlo; manca il confronto GPU qualità/tempo a 1 e 2 MP. Face→upscale è escluso perché perderebbe il ritocco tornando al latent originale.

### Milestone 9 — Produzione e cloud opzionale

- [ ] Aggiornare le dipendenze runtime segnalate dall'audit senza usare fix forzati.
- [x] Packaging GitHub portabile con launcher Node, wizard first-run e dati locali esclusi.
- [x] Workflow distribuiti sanitizzati e stack LoRA configurato soltanto da Admin.
- [x] Nodo H3 Studio esteso incluso con licenza/provenienza e installer ComfyUI recuperabile.
- [x] Manifest completo delle dipendenze e CI Windows per build/test/sanitizzazione.
- [x] Codice originale H3 Studio rilasciato con GNU AGPL-3.0-only; licenze upstream conservate separatamente.
- [x] Export sequenza locale FFmpeg.
- [ ] Backup/ripristino.
- [ ] Quote disco, monitor spazio, retention e pulizia recuperabile di cache/output.
- [ ] Telemetria locale di tempi, VRAM, errori e qualità per calibrare ETA e crediti.
- [ ] Test end-to-end ripetibili per T2V, I2V, Reference, Keyframes, Continue, Edit, Face e Upscale.
- [ ] Firebase Hosting/Auth/Firestore opzionali.
- [ ] Pairing sicuro UI ospitata ↔ bridge locale.

### Milestone 10 — Audio Studio

- [x] Modalità Audio nello Studio, associata al progetto e coerente con Video/Immagini.
- [x] Higgs Audio v3 TTS locale con voci installate e cloning one-shot da Libreria/upload.
- [x] Processo Higgs effimero con Stop e terminazione garantita in `finally` dopo successo, errore o cancellazione.
- [x] MiniMax Music 3 via ComfyUI con caption, lyrics, durata, seed, progresso e decode tiled.
- [x] Output persistenti, player, download, tempo di esecuzione e registrazione in Libreria.
- [x] Configurazione Admin separata per TTS e Music e manifest dei modelli Music.
- [x] Prompt Compiler LLM condiviso da Krea, Flux Edit, Anima e Higgs TTS, con input naturale multilingua, prompt tecnico modificabile e unload dopo ogni piano.
- [x] Trascrizione automatica multilingua delle reference vocali con Whisper Small in processo isolato e fallback manuale.
- [x] Routing esplicito TTS/Music alla Chat multimodale con reference audio.
- [x] Pipeline `Canzone col mio timbro`: MiniMax Music → BS-RoFormer → Seed-VC → remix stereo, con Stop e unload garantiti.
- [x] Video H3 parlante da Chat: reference timbrica, dialogo letterale e istruzione lip-sync nel prompt R2V.
- [ ] Collaudare la conversione timbrica completa sulla GPU reale dopo il download dei modelli audio.cpp.
- [ ] Collaudare voice clone italiano e una generazione Music lunga su GPU reale.

### Milestone 11 — Multishot nello Studio

- [x] Contatore esplicito da 1 a 12 shot per candidato sul workflow H3 standard/FAST esistente.
- [x] Durata per-shot, durata totale indicativa, crediti ed ETA moltiplicati per shot e candidati.
- [x] Persistenza SQLite v23, cronologia, rigenerazione e durata timeline multishot.
- [x] Scheduling UI `Auto` / `Tutti` / shot selezionati per Picture, Video e Audio.
- [x] Planner con campi distinti `active_ref_images`, `active_ref_videos` e `active_ref_audios`.
- [x] Filtro fisico del reference bank e ricompattazione marker per ogni shot.
- [x] Test non-GPU per limite 12, wiring workflow, ETA, timeline e filtro reference.
- [ ] Smoke test GPU 2 shot T2V, quindi 3 shot Reference con asset che entra soltanto nello shot 2.
- [ ] Misurare memoria, tempo e affidabilità su 6 e 12 shot prima di consigliarli come preset ordinari.

### Funzioni mancanti nel piano originario, ora esplicitate

- Varianti derivate immutabili per evitare che Face Refine o Upscale sovrascrivano l'originale.
- Scelta della variante a ogni passaggio: player, Studio, montaggio ed export.
- Retry/cancel granulari e recupero dopo riavvio anche per post-process e export.
- Transizioni reali e gestione overlap audio/video fra continuazioni.
- Gestione spazio disco, retention, backup e ripristino verificato.
- Health check dei nodi/modelli richiesti per ciascun workflow prima di accodare un job costoso.
- Matrice di collaudo GPU e telemetria locale per qualità, tempi e regressioni.

## 13. Criteri MVP

L'MVP è completo quando un utente autorizzato può creare un progetto, stimare e spendere crediti, generare 1–4 candidati reali, seguirne l'avanzamento, selezionarne uno, continuarlo o editarlo e riaprire tutto mantenendo seed e impostazioni.

## 14. Rischi principali

| Rischio | Mitigazione |
|---|---|
| Cambio ID nodi | Mappa semantica versionata e validazione startup |
| Picchi VRAM | Candidati seriali |
| FAST differisce dalla final | Confronto 8/12 standard o refine del candidato |
| Output non associato al job | promptId e prefix univoco |
| Disco pieno | Quote, monitor spazio e pulizia esplicita |
| Crediti manipolati dal client | Calcolo e ledger esclusivamente server-side |
| Browser cloud verso localhost | Bridge locale con pairing sicuro |
| Account bloccato ancora attivo | Revoca server-side e invalidazione sessioni |
| Advisory nelle dipendenze dello scaffold | Restare local-only e aggiornare compatibilmente prima di auth/pubblicazione |

## 15. Prossimo incremento

1. Collaudare su GPU il nuovo profilo Anima locale a 8 step/CFG 1 e almeno un LoRA creativo.
2. Misurare qualità, VRAM e tempi e scegliere l'ordine definitivo della pipeline combinata.
3. Aggiungere ETA calibrata e retry granulari alle varianti; Stop è già disponibile per run e post-process.
4. Eseguire test GPU reali di I2V, Reference, Keyframes, Continue ed Edit e completare la gestione degli overlap.
5. Riavviare ComfyUI e collaudare realmente il profilo FAST PDD-Acc Ref2VA; misurare ETA e qualità contro 8 standard sullo stesso seed.
6. Iniziare auth, utenti e ledger crediti server-side.
