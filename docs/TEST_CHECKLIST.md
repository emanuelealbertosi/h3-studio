# H3 Studio — Checklist di collaudo

Aggiornamento: 29 agosto 2026

## Legenda

- [x] Eseguito e superato
- [ ] Da eseguire o da riconfermare dopo una modifica
- 🟡 In esecuzione; esito qualitativo ancora da verificare
- ⚠️ Eseguito, ma fallito o parziale

## Sessione automatica non-GUI — 29 agosto 2026

- [x] Setup/Auth, repository progetti, export timeline FFmpeg, Libreria creativa, media esterni e migrazioni SQLite.
- [x] Contratti Krea, Image Studio, Chat, Audio Studio, FAST/PDD, post-process, riparazione tempi e controllo runtime LLM.
- [x] Multishot 1–12 con filtro fisico delle reference per shot, continuazione boundary e riparazione JSON Composer.
- [x] Cancellazione ComfyUI confinata ai job H3 Studio e helper di riavvio bridge.
- [x] Workflow bundled sanitizzati senza differenze residue; test layout statico, typecheck e build di produzione superati.
- ⚠️ Lint non verde: 20 errori e 37 warning già presenti. Errori principali: 17 `react-hooks/set-state-in-effect`, più un caso ciascuno di `preserve-manual-memoization`, `refs` e `rules-of-hooks`. La build e il typecheck restano verdi, ma il debito va corretto separatamente.

Non inclusi in questa sessione: interazioni browser/GUI, render GPU reali, valutazione visiva o sonora, verifica VRAM, LAN/Tailscale e installazione su una seconda macchina.

## Avvio e Admin

- [x] Avvio H3 Studio e collegamento a ComfyUI.
- [x] Recupero automatico dell'Admin quando ComfyUI termina l'avvio.
- [x] Apertura Admin senza `Not Found` con ComfyUI già online.
- [x] Liste reali di modelli, LoRA, encoder e VAE.
- [x] Persistenza modello Anima/Nova dopo Salva, cambio pagina e riapertura.
- [x] Persistenza CFG e step Anima dopo Salva e riapertura.
- [x] Persistenza CFG/step degli altri engine configurabili.
- [ ] Indipendenza tra configurazioni H3, Krea, Anima e Flux/Klein.
- [ ] Comando termina LLM con rilascio effettivo della VRAM.
- [ ] Riavvio server dall'Admin.
- [ ] Accesso LAN e Tailscale.

## Progetti e Chat

- [x] Apertura di un progetto esistente.
- [x] Creazione di una chat di progetto e risposta LLM.
- [ ] Nuovo progetto con apertura diretta nello Studio.
- [ ] Filtro corretto di media, chat e montaggi per progetto.
- [ ] Titolo automatico, rinomina ed eliminazione chat.
- [ ] Eliminazione chat conservando i media.
- [ ] Sidebar conversazioni fissa durante lo scorrimento.
- [ ] Memoria e riassunto automatico di una chat lunga.
- [ ] Dicitura generica `LLM`, senza riferimenti al modello specifico.
- [ ] Placeholder, avanzamento e Interrompi durante i job Chat.
- ⚠️ `Apri nello Studio` ha aperto un vecchio media invece di quello appena creato.
- [ ] Interruzione job Chat con pulizia coda, RAM e VRAM.

## Video H3

- [x] Generazione completa di un video dallo Studio.
- [x] Generazione e visualizzazione di candidati.
- [ ] T2V, I2V, Reference e Keyframes.
- [ ] Formati 16:9, 9:16, 1:1 e 4:3.
- [ ] `Keep aspect ratio` in I2V, Edit e Keyframes.
- ⚠️ `Keep aspect ratio` risultava assente in Keyframes.
- [ ] FAST, 8, 12, 20 e 30 step verificati dal log ComfyUI.
- [ ] Turbo realmente opzionale e nessuna patch residua quando è spento.
- [ ] Durate 5, 10 e 15 secondi.
- [x] Contratto statico 1–12 shot, wiring esatto, persistenza e durata timeline.
- [ ] GPU: 2 shot T2V con raccordo fluido e output unico.
- [ ] GPU: 3 shot Reference con una Picture attiva soltanto nello shot 2.
- [ ] GPU: schedule Video/Audio per-shot verificato dal log `[H3Refs]`.
- [x] Contratto automatico `Audio esatto + lip-sync`: soundtrack codificato nel latent AV, maschera denoise video=1/audio=0, start frame I2V e fallback standard senza PDD/Turbo.
- [x] Contratto automatico `Solo voce/timbro`: I2V e Keyframes inoltrano `voice_ref`, conservano il nuovo dialogo del prompt e non copiano le parole della reference.
- 🟡 GPU: I2V + audio esatto da 34,28 s completato in 4 shot da circa 10 s con processo ComfyUI riavviato dopo il nodo aggiornato, Hybrid INT8, 0,5 MP, 8 step standard e nessun LoRA/PDD. Output: 544×960, 24 fps, 34,125 s, AAC stereo 48 kHz; elaborazione 1.063,9 s. Resta la valutazione visiva.
- [ ] Sul render lungo verificare lip-sync percepibile, identità, continuità ai tre confini, audio senza tagli e durata finale uguale alla sorgente.
- [ ] GPU rapido definitivo: I2V + parlato di circa 2 s, primo piano o mezzo busto frontale, per isolare e confermare il movimento labiale.
- [ ] GPU `Solo voce/timbro`: I2V e Keyframes con reference vocale, battuta diversa scritta nel prompt, voce coerente e parole della reference assenti.
- [ ] Stress test 6 e 12 shot con recupero dopo riavvio e misurazione VRAM/tempo.
- [ ] A 15 secondi, 1 MP disabilitato e massimo 0,7 MP.
- [ ] Seed random, base+1, bloccato e batch 1–4.
- [ ] Tempo stimato coerente con caricamento, sampling e finalizzazione.
- [ ] Tempo effettivo mostrato sui job completati.
- ⚠️ I media in corso sparivano lasciando e riaprendo lo Studio.

## Rigenerazione e job

- [x] Rigenerazione con seed diverso.
- [x] Popup Rigenera con modifica del prompt precedente.
- [ ] Rigenerazione dell'intero batch.
- [ ] Rigenerazione di un solo candidato del batch.
- [ ] Indicazione chiara dello snapshot engine usato.
- [ ] Interruzione durante caricamento modello e sampling.
- [ ] Nessuna barra animata sui job falliti.
- [ ] Eliminazione definitiva di un job fallito.

## Continue video

- [x] Continuazione salvata come nuovo segmento autonomo.
- [ ] Un solo video sorgente usato per la boundary memory.
- [ ] Ultimo frame usato senza duplicare il sorgente come reference completa.
- [ ] Reference personaggi mantenute.
- ⚠️ Stacco ancora troppo netto tra sorgente e continuazione.
- ⚠️ Una prova ha duplicato il sorgente e perso la reference del personaggio.
- [ ] Confronto diretto con Multishot usando parametri identici.

## Immagini, Edit e Anima

- [x] Generazione Krea.
- [x] Generazione Anima.
- [ ] Nuova generazione Nova verificata dal log, non tramite Rigenera storico.
- [ ] Batch immagine da 1, 2 e 4 candidati.
- [ ] Primo piano, mezzo busto, figura intera, character sheet, object sheet e luogo.
- ⚠️ `Character sheet / turnaround` ha generato soltanto un primo piano.
- [ ] Edit Flux/Klein con una e quattro reference.
- [ ] `Keep aspect ratio` in Edit.
- [ ] Pulsante Video sull'immagine per inviarla al tab Video come reference.
- [ ] Zoom, download e rimozione immagini.

## Assets e Libreria

- [x] Contratto statico del filtro categorie Libreria e layout responsive.
- [ ] Filtro Libreria: verificare Tutto, Montaggi, Asset, Immagini, Esterni e Video, inclusi conteggi e stato attivo.
- [ ] Filtro Libreria: selezionare più elementi, cambiare categoria e verificare che selezione e cancellazione multipla restino coerenti.

- [x] Eliminazione multipla degli asset.
- [x] Conservazione dei media prodotti da Chat/Studio.
- [ ] Persistenza dei file esterni con origine `Esterno`.
- [ ] Rinomina di immagini, video e audio.
- [ ] Selettore Libreria con miniature.
- [ ] Menu `@` con miniature e pulsante Inserisci.
- [ ] `Invia allo Studio` verso progetto e tab corretti.
- ⚠️ Personaggi, Oggetti e Luoghi non mostravano tutti gli asset taggati.
- [ ] Terminologia `Luoghi` coerente in tutta l'app.
- [ ] Eliminazione video con rimozione dai montaggi collegati.

## TTS

- [x] TTS dalla Chat con voce di riferimento.
- [x] Invio TTS allo Studio.
- [ ] TTS diretto dallo Studio.
- [ ] Reference dalla Libreria e da disco.
- [ ] Auto-trascrizione/reference script e pronuncia italiana.
- [ ] Planner senza alterare il testo letterale da pronunciare.
- [ ] Output stereo e conversione automatica del mono.
- [ ] Normalizzazione e assenza di clipping.
- [ ] Interruzione e offload del modello con rilascio VRAM.

## Musica H3

- [x] Generazione musicale dalla Chat.
- [x] Riproduzione del file prodotto.
- [x] Invio Musica allo Studio.
- [ ] Generazione Musica diretta dallo Studio.
- [ ] Durata, genere, BPM, strumenti e atmosfera.
- ⚠️ Una richiesta cantata è stata generata senza canto e senza lyrics nel prompt.
- [ ] Lyrics letterali separate dalla descrizione musicale.
- [ ] Modalità strumentale senza voci.
- [ ] Modalità cantata con lingua e testo corretti.
- [ ] Rigenerazione modificando descrizione e lyrics.
- [ ] Output stereo e metadati corretti.
- [ ] Interruzione e rilascio VRAM.
- [ ] Futuro: reference stilistica da audio.
- [x] Contratto automatico `Parlato → brano`: planner, route API, stereo, ducking e persistenza job.
- [ ] Collaudo reale `Parlato → brano` con file da disco.
- [ ] Collaudo reale `Parlato → brano` scegliendo il sorgente dalla Libreria.
- [ ] Durata finale uguale al parlato, voce preservata e base senza cantato.
- [ ] Regolazione Voce/Musica/Ducking e assenza di clipping.
- [ ] Interruzione durante MiniMax Music e durante il mix.
- [x] Contratto automatico `Canzone col mio timbro`: separazione BS-RoFormer, Seed-VC SVC, F0, remix stereo e cleanup processi.
- [ ] Collaudo reale `Canzone col mio timbro` con reference pulita di 5–20 secondi.
- [ ] Verifica somiglianza timbrica senza perdita evidente di parole, melodia o timing.
- [ ] Interruzione durante separazione e Seed-VC con rilascio VRAM.
- [ ] Chat: audio vocale + richiesta di canzone con «mia voce/mio timbro» instrada la conversione timbrica.
- [x] Contratto Chat: immagine + audio + richiesta di parlato produce I2V, Audio 1 esatto, standard 8-step e Turbo/PDD disattivati.
- [ ] Collaudo GPU Chat: Picture 1 coincide col frame iniziale e il soggetto segue correttamente il parlato allegato.
- [ ] Collaudo GPU Chat/Studio con `Solo voce/timbro`: pronuncia il testo nuovo mantenendo soltanto l'identità vocale della reference.

## Upscale e Face

- [x] Contratto automatico: Upscale conserva Keep Aspect, formato esplicito e proporzioni dei job manuali.
- [x] Avvio di un'elaborazione Upscale.
- [ ] Popup di conferma prima dell'avvio.
- [ ] Target 1 MP e 2 MP verificati da log e dimensioni finali.
- ⚠️ In precedenza 2 MP sembrava avviare 1 MP o non partire.
- [ ] Aggiornamento automatico del frontend al termine ComfyUI.
- [ ] Face sull'originale.
- [ ] Face dopo Upscale.
- [ ] Originale, Face, Upscale e Face+Upscale come varianti dello stesso candidato.
- [ ] Stato, percentuale, tempo e Interrompi visibili.
- [ ] Pulsanti contenuti nel riquadro a tutte le larghezze.

## Montaggi

- [x] Creazione di un montaggio.
- [x] Esportazione in un singolo file riproducibile.
- [ ] Clip del progetto visibili nella pagina Montaggi.
- [ ] Scelta della variante Originale/Face/Upscale/Face+Upscale.
- [ ] Rimozione di una clip inserita per errore.
- [ ] Riordino drag and drop e trimming non distruttivo.
- [ ] Più montaggi nello stesso progetto e rinomina.
- ⚠️ Mancava il comando per eliminare un montaggio.
- [ ] Audio esterno, diegetico/non diegetico, mux e livelli.
- [ ] Export normale e export con refiner/upscale.

## Errori e recupero

- [ ] Stato Fallito con messaggio, Rigenera ed Elimina.
- [ ] Eliminazione persistente dei job falliti.
- [ ] Riconciliazione dei job dopo riavvio H3 Studio.
- [ ] Recupero di un job completato mentre la pagina era chiusa.
- ⚠️ Dopo un errore LLM sono rimasti occupati circa 10 GB di VRAM.
- [ ] Rilascio della VRAM dopo errore o comando termina LLM.
- [ ] Nessun file o record orfano dopo le eliminazioni.

## Distribuzione

- [x] Repository pubblico H3 Studio e CI principale.
- [x] Repository Standalone e prerelease `v0.1.0-dev`.
- [x] Typecheck, test e build Standalone sulla macchina di sviluppo.
- [ ] Installazione H3 Studio su una seconda macchina Windows pulita.
- [ ] Installazione Standalone su una seconda macchina Windows/NVIDIA pulita.
- [ ] Primo avvio, password Admin e configurazione cartelle/endpoint.
- [ ] Aggiornamento senza perdita di database, progetti e configurazione.
- [ ] Smoke test: Chat → generazione → Studio → variante → Timeline → export.

## Prossimo collaudo consigliato

1. Persistenza modello, CFG e step Anima/Nova.
2. Persistenza dei job lasciando e riaprendo lo Studio.
3. Concludere e valutare il render I2V lip-sync da 34,28 s/4 shot; poi ripetere con audio di circa 2 s.
4. Verificare `Solo voce/timbro` su I2V e Keyframes con un dialogo nuovo.
5. Parlato → brano da Libreria, con verifica durata, stereo e ducking.
6. Apertura nello Studio del media corretto creato dalla Chat.
7. Allineamento Assets/Libreria per Personaggi, Oggetti e Luoghi.
8. Continue video senza stacco, duplicazione o perdita reference.
9. Upscale 2 MP e Face sull'upscale.
10. Eliminazione e gestione Montaggi.
11. Audio stereo e rilascio VRAM.
12. Smoke test completo in un progetto nuovo.
