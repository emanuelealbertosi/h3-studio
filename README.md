# H3 Studio

H3 Studio è un client web local-first per orchestrare ComfyUI e i workflow MiniMax H3 senza gestire direttamente grafi complessi.

Copyright (C) 2026 Emanuele. Il codice originale H3 Studio è distribuito con
licenza **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`): le
versioni modificate distribuite o offerte tramite rete devono rendere disponibile
il relativo codice sorgente. I componenti di terze parti conservano le proprie
licenze e attribuzioni, incluso il nodo H3 Multishot derivato dall'upstream MIT.
Vedi [LICENSE](LICENSE) e le note nelle rispettive cartelle.

Il prodotto organizza prompt, personaggi, asset, candidati e continuazioni. ComfyUI rimane il motore di rendering; H3 Studio gestisce progetti, coda, confronto, crediti e riproducibilità.

La voce **Chat** aggiunge un assistente LLM Vision locale con conversazioni
multiple raggruppate per progetto, titoli automatici modificabili e memoria
indipendente. Può conversare, analizzare fino a quattro immagini della Libreria e,
su richiesta esplicita, avviare Video H3, il motore video opzionale LTX 2.5, immagini Krea, still MiniMax H3
(T2I/I2I/Reference), edit Flux.2 Klein o immagini Anima. Le immagini allegate possono inoltre diventare keyframe iniziali,
intermedi o finali, con posizioni automatiche, percentuali o tempi espliciti. I
video H3 avviati dalla Chat usano il profilo standard controllato
dal server: 10 secondi, un candidato, 0,5 MP e 8 step sul modello H3 standard/Hybrid. LTX 2.5 parte
solo dal selettore dedicato o quando viene nominato esplicitamente. Il modello LLM resta
caricato fra i messaggi, ma viene scaricato automaticamente prima di ogni render
per restituire VRAM a ComfyUI. I riferimenti impliciti come “modificala” usano
l'ultimo media generato o allegato nella conversazione; **Rigenera** permette di
correggere il prompt in un popup e avviare una variante con seed nuovo.

Lo Studio e la Chat includono inoltre **Masking H3** come modalità selettiva
opzionale: SAM3 segue un soggetto descritto a parole, MaskVid stabilizza il crop
e ricompone l'area modificata sul video originale. Il normale Video editing H3
resta disponibile separatamente per le trasformazioni full-frame.

## Stato

Fase attuale: **Milestone 4 — montaggio locale, Continue/Edit e workflow multimodali**.

La UI è disponibile localmente con `npm run dev` usando Node 22.16.0 o superiore. Il workflow ComfyUI stabile non viene modificato: il bridge usa una copia UI e un export API dedicati nella cartella `workflows`.

I job sono persistiti in `data/h3-studio.sqlite`. I video restano negli output di ComfyUI; il database conserva metadati, promptId, seed, impostazioni e snapshot del workflow API.

La sezione **Progetti** mostra la cronologia locale e permette di riaprire un job nello Studio. Anche il candidato scelto viene salvato in SQLite e ripristinato dopo il riavvio del bridge.

La sezione **Montaggi** offre timeline non distruttive: le clip possono essere
riordinate, copiate o spostate fra progetti, tagliate con una filmstrip a doppia
maniglia e reinquadrate con crop/zoom. Due tracce audio esterne mostrano la forma
d’onda e supportano posizione, trim, volume, mute, solo, loop e fade, oltre al
gain dell’audio H3 originale. Il composer supporta il mapping dei sei modi H3 e
conserva asset, keyframe e ruoli Reference; nessun render parte senza il pulsante
Genera. L’export FFmpeg produce un MP4 H.264/AAC applicando realmente tagli,
crop e mix multitraccia.

Ogni candidato video può contenere da **1 a 12 shot H3 concatenati con frame
memory**. La durata scelta è per shot e la UI mostra durata totale indicativa,
costo ed ETA moltiplicati. In Reference, ogni Picture, Video o Audio può essere
lasciato su Auto, obbligato in tutti gli shot oppure assegnato a shot precisi;
il planner produce lo schedule e il reference bank filtra fisicamente i media
inattivi prima del conditioning.

I controlli creativi Camera, Obiettivo ed Effetti aggiungono direttive leggibili
al prompt senza nascondere o sostituire il testo dell’utente.

In **I2V**, Picture 1 viene usata dal render come frame iniziale ma non viene
inviata al planner LLM, così il workflow resta compatibile con i backend GGUF
text-only. Un continuity lock testuale impone di conservare identità, abiti,
ambiente e inquadratura; nei monoshot il parser impedisce inoltre al planner di
introdurre da solo un secondo taglio.

Lo Studio espone quattro preset H3: **8 / 12 / 20 / 30**. Tutti usano il
workflow standard/Hybrid e lo stack di modello e LoRA configurato nell'Admin. Il
vecchio profilo Alibaba PDD-Acc è stato ritirato: pesi, nodo custom e workflow
dedicato non fanno più parte dell'installazione.

Come alternativa esplicita, lo Studio e la Chat espongono **LTX 2.5 RedGraft
INT8** con audio nativo. **LTX Fast** usa il single-stage a 8 step e supporta
T2V/I2V con una sola immagine, segmenti da 5/10/15/20 secondi e 0,5/0,7/0,98/
1,5/2 MP. **LTX Quality** aggiunge upscale latent 2× e refine a 3 step, con base
0,5/0,7/0,98 MP. I profili più pesanti sono marcati sperimentali su GPU da
16 GB; H3 rimane sempre il motore predefinito.

Il tab **Assets/Libreria** gestisce ora personaggi e oggetti persistenti,
reference multiple tramite drag-and-drop e character/object sheet con Krea 2.
Il pulsante **Usa nel video** trasferisce le immagini alla modalità H3 Reference
e compila automaticamente i ruoli Picture.

Ogni immagine, video o audio caricato da disco nello Studio viene inoltre
registrato automaticamente nella sezione **Libreria → Esterni**. Il file resta
riutilizzabile dal picker e dal menu `@` anche dopo un riavvio e fra progetti
diversi; il progetto attivo viene conservato come origine. Un nuovo caricamento
con lo stesso nome originale, tipo e dimensione riusa la voce già registrata.

Lo **Studio Immagini** condivide progetti e layout con lo Studio Video. Genera
da uno a quattro candidati con Krea 2 oppure esegue edit Flux.2 Klein con un
massimo di quattro reference ordinate. Un selettore motore opzionale usa MiniMax
H3 per T2I, I2I o Reference fino a nove immagini, mantenendo Krea come default
di generazione e Flux come default di edit. I preset di composizione Libero,
Character sheet/turnaround, Primo piano, Mezzo busto, Figura intera, Oggetto
sheet e Paesaggio arricchiscono il prompt senza sostituire il testo dell'utente;
il prompt effettivo resta ispezionabile prima del lancio. Ogni candidato può
essere taggato come Personaggio, Oggetto o Paesaggio e condiviso singolarmente
con altri progetti. Dal selettore media dello Studio Video le immagini generate
del progetto, e in seconda battuta quelle riutilizzabili degli altri progetti,
possono essere collegate come reference senza un nuovo upload. Il profilo Flux predefinito è il 4B
Distilled FP8 a quattro step e CFG 1; workflow, modello, encoder, VAE, cache e
attention backend sono gestiti dall’Admin.
Il Prompt Compiler AI usa il modello LLM configurato nella Chat per trasformare una
richiesta naturale multilingua nel formato specifico di Krea, Flux Edit o Anima;
il risultato resta modificabile e il modello LLM viene scaricato prima del render.

### Planner AI locale o remoto

La card **Admin → Planner AI** può usare il GGUF locale oppure qualsiasi endpoint
OpenAI-compatible che esponga `POST /chat/completions`. La scelta vale per il
planner Video H3 e per i compiler Image H3, Krea, Flux Edit, Anima, TTS e Musica:

- **Locale** usa il modello e il projector GGUF della Chat tramite ComfyUI;
- **Remoto** usa soltanto URL e modello API configurati e segnala l'errore senza
  caricare il GGUF locale;
- **Automatico** prova prima l'API e usa il GGUF locale se la richiesta remota
  fallisce, quindi richiede che anche il runtime Chat locale sia configurato.

URL, modello, timeout, token, temperature e top-p sono salvati nelle impostazioni
runtime locali. La chiave API è separata dalla password Admin, resta nel solo
bridge in `data/planner-api-key.txt` e non viene restituita al browser né inserita
nei job. **Verifica connessione** prova i valori correnti prima del salvataggio.
L'opzione **Usa il modello remoto anche per conversazione e memoria Chat** è
disattivata per impostazione predefinita: se rimane spenta, la Chat continua a
usare il proprio GGUF anche quando i planner usano l'API.


Lo **Studio Audio** è la terza modalità dello stesso progetto. **Higgs Audio
v3 TTS** genera parlato e supporta il cloning one-shot da un campione caricato
o già presente in Libreria; il runtime viene avviato in un processo isolato e
terminato sempre dopo output, errore o Stop, così il modello non resta in VRAM.
Il TTS Planner conserva la lingua richiesta e prepara testo e prosodia Higgs.
Le reference vocali vengono trascritte automaticamente da Whisper Small
multilingua in un processo separato che termina prima del caricamento TTS;
il testo riconosciuto rimane sempre correggibile.

**MiniMax Music 3** usa invece i nodi nativi di ComfyUI con caption, lyrics a
sezioni, durata fino a sei minuti, seed e decode tiled. Entrambi espongono
progresso, interruzione, player, download, tempo di esecuzione e registrano
l'output come audio riutilizzabile in Libreria.

Nel Video Studio, la card `Audio 1` espone anche **Audio esatto + lip-sync
(I2V/R2V)**: parlato, canto o musica vengono suddivisi sulle finestre H3 e ogni
shot riceve la porzione temporale corretta come `<Soundtrack>`. In I2V,
`Picture 1` rimane il frame iniziale esatto; in Reference resta una reference
visiva. Il master conserva l'audio originale invariato. Quando la durata è
disponibile il numero di shot viene calcolato automaticamente (massimo 12);
questa modalità usa il sampler H3 standard a 8 step.

La modalità **Parlato → brano** prende un audio da disco o Libreria, ne usa
trascrizione e durata reale per progettare una base strumentale con il planner
LLM, quindi produce un unico WAV stereo con voce preservata, ducking regolabile,
limiter e mix automatico tramite FFmpeg.

La modalità **Canzone col mio timbro** genera prima un brano cantato con
MiniMax Music, separa voce e accompagnamento con BS-RoFormer Q8, trasferisce
solo il timbro di una reference tramite Seed-VC Q8 e ricrea il mix stereo con
FFmpeg. `INSTALL_AUDIO_VOICE.bat` installa il runtime audio.cpp v0.7 e i pesi
esterni; ciascun processo è effimero e viene terminato anche su Stop o errore.
Nella Chat, immagine + audio allegati a una richiesta di animazione/parlato
attivano I2V con frame iniziale esatto, audio originale preservato e lip-sync.
Reference H3 rimane disponibile quando l'immagine deve essere soltanto un
riferimento o quando viene usato un video reference.

Ogni candidato completato espone derivati non distruttivi **Face**, **Upscale
1 MP** e **Upscale 2 MP**. I target compaiono soltanto quando superano la
risoluzione della sorgente: un originale da 0,98 MP propone quindi solo 2 MP.
L'upscale rigenera lo stesso seed con il Latent Upscaler 3D verso 0,98 o 1,96
MP; non è un semplice resize del file MP4. Selezionando un Upscale pronto e
premendo Face si ottiene una vera catena **Upscale → Face**, senza rieseguire
l'upscale e conservando l'audio della variante scelta. L'originale rimane
sempre disponibile; la versione attiva può essere usata per Continue/Edit
oppure assegnata alla singola clip della timeline. Lineage, target e stato del
post-process sono persistiti nel database e recuperati dopo il riavvio del
bridge. Ogni Upscale richiede una conferma esplicita con target e avviso
tempo/VRAM; un controllo di contratto blocca la coda se browser e bridge non
sono aggiornati alla stessa versione. Se il bridge è precedente, il dialog
resta visibile, spiega l'incompatibilità e disabilita la conferma senza inviare
nulla a ComfyUI. Le didascalie terminali mostrano inoltre il tempo trascorso,
comprensivo dell'attesa in coda.

Durante generazione, Face o Upscale, il pulsante **Interrompi** elimina dalla
coda i prompt del job e ferma il prompt attivo soltanto se non risultano altri
run ComfyUI estranei in esecuzione.

L'Admin include **Riavvia server**: riavvia soltanto il bridge H3, mantiene
ComfyUI e i suoi job attivi e ricarica automaticamente l'interfaccia quando il
collegamento torna disponibile.

Dopo l'installazione o un aggiornamento dei nodi Face/Upscale è necessario
riavviare ComfyUI. Il bridge esegue un preflight e non accoda un render costoso
se il processo attivo espone ancora la vecchia definizione dei nodi.

I video completati possono essere eliminati dal cestino presente sia sulla
scheda candidato sia nella Libreria media. L'operazione chiede conferma, rimuove
la sorgente da tutti i montaggi, elimina le varianti derivate e cancella i file
video corrispondenti dall'output ComfyUI.

## Documentazione

- `docs/PROJECT-PLAN.md`: specifica e tracking principale.
- `docs/ARCHITECTURE.md`: componenti e flussi tecnici.
- `docs/GENERATION-MODES.md`: mapping verificato di T2V, I2V, Reference, Keyframes, Continue ed Edit.
- `docs/CREATIVE-LIBRARY.md`: personaggi, oggetti, reference e sheet Krea 2.
- `docs/IMAGE-STUDIO.md`: generazione Krea/Anima, edit Flux Klein, reference e condivisione immagini fra progetti.
- `docs/CHAT.md`: assistente LLM Vision, allegati, azioni e runtime locale.
- `docs/AUDIO-STUDIO.md`: Higgs TTS, voice cloning, MiniMax Music, Parlato → brano e rilascio VRAM.
- `docs/INSTALLATION.md`: clone, primo avvio, sicurezza e dipendenze ComfyUI.
- `docs/GITHUB-RELEASE.md`: sanitizzazione, CI e checklist di pubblicazione.
- `docs/WORKLOG.md`: cronologia sintetica del lavoro.

Test locali principali: `npm run test:projects`, `npm run test:export`,
`npm run test:library`, `npm run test:external`, `npm run test:krea-contract`,
Il bootstrap e l'autenticazione locale si verificano con `npm run test:setup`.
Il contratto completo Image Studio si verifica con `npm run test:images`.
Il contratto della Chat locale si verifica con `npm run test:chat`.

## Avvio rapido

1. Installa Node.js 22.16.0 o superiore e prepara una ComfyUI funzionante.
2. Clona il repository ed esegui una volta `INSTALL_COMFY_DEPENDENCIES.bat` su
   Windows oppure `./INSTALL_COMFY_DEPENDENCIES.sh --comfy-root /percorso/ComfyUI`
   su Linux.
3. Avvia `START_H3_STUDIO.bat` su Windows o `./START_H3_STUDIO.sh` su Linux.
4. Al primo avvio crea la password Admin e configura URL, cartella output e workflow.
5. Riavvia una volta H3 Studio e apri `http://localhost:3000`.

Per arrestare completamente frontend, bridge e relativi processi figli usa
`STOP_H3_STUDIO.bat` su Windows o `./STOP_H3_STUDIO.sh` su Linux. Lo stop non
termina ComfyUI e lascia attivi gli eventuali proxy Tailscale.

Il launcher installa automaticamente le dipendenze npm quando mancano e avvia
bridge e interfaccia in due console separate. I workflow pronti, il manifest
delle dipendenze e il nodo H3 Studio esteso sono inclusi; modelli e media
rimangono esterni al repository. Prima dell'avvio controlla l'endpoint bridge
configurato (predefinito `127.0.0.1:8787`): riusa un bridge H3 Studio sano
della stessa installazione e sostituisce soltanto un'istanza non responsiva
appartenente alla stessa cartella del progetto e interrompe l'avvio se il
listener è estraneo o non verificabile.

L'accesso Admin è protetto dalla password creata nel wizard. Prima di esporre
l'app direttamente a Internet va aggiunta autenticazione anche alle API utente;
la configurazione attuale è pensata per localhost, LAN fidata o Tailscale.

Per l'accesso diretto dalla LAN, impostare localmente `H3_WEB_HOST=0.0.0.0` e
`H3_BRIDGE_HOST=0.0.0.0`, aggiungendo a `H3_WEB_ORIGINS` soltanto gli URL
dei client autorizzati, per esempio `http://192.168.1.17:3000`. Questa scelta
espone frontend e API sulla rete locale: usare password Admin robusta e una rete
fidata. Le impostazioni locali restano nel file `.env`, escluso da Git.

Se Windows Firewall blocca il bridge sul dispositivo remoto, eseguire
`ENABLE_H3_STUDIO_LAN_FIREWALL.bat` e approvare il popup UAC. La regola apre
soltanto TCP 3000/8787 sull'indirizzo LAN corrente e accetta esclusivamente
client della subnet locale; non cambia il profilo generale della rete.
