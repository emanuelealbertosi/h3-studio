# Audio Studio

Audio è la terza modalità dello Studio e usa lo stesso progetto di Video e
Immagini. Gli output completati restano disponibili nel pannello, sono
scaricabili e vengono registrati automaticamente in **Libreria → Esterni**.

## Higgs Audio v3 TTS

Il motore primario è l'installazione locale di Higgs Audio Studio configurata
in Admin. H3 Studio non tiene un server TTS persistente: per ogni job avvia il
Python embedded di Higgs su una porta localhost effimera, attende il modello,
salva lo stream WAV nell'output ComfyUI e termina l'intero albero del processo.
La terminazione viene eseguita nel blocco `finally` anche in caso di errore o
Stop. Prima dell'avvio il bridge chiede inoltre a ComfyUI di scaricare i modelli
residenti per evitare una contesa VRAM.

Il **TTS Planner AI**, attivo per impostazione predefinita, usa il modello LLM della
Chat come Prompt Compiler: accetta una richiesta in qualunque lingua, separa le
indicazioni di voce/prosodia dal testo pronunciato e conserva la lingua richiesta.
Il copione Higgs prodotto resta visibile e modificabile. LLM viene scaricato
prima del caricamento di Higgs; disattivando il Planner si torna al testo diretto.

Per il cloning one-shot si può caricare un file audio oppure sceglierne uno
dalla Libreria. Un campione breve, pulito e con una singola voce funziona
meglio. H3 Studio lo trascrive automaticamente con `openai/whisper-small`,
multilingua, in un processo isolato. Whisper termina e libera la VRAM prima di
Higgs; la trascrizione resta modificabile e, in caso di errore, si può compilare
manualmente oppure lasciare che Higgs usi il solo campione audio.

## MiniMax Music 3

Il **Music Planner AI**, attivo per impostazione predefinita, usa il modello LLM
configurato nella Chat per convertire una richiesta naturale in una caption
tecnica inglese e, quando richiesto, in lyrics strutturate. Il piano resta
visibile e modificabile prima della generazione. LLM viene sempre scaricato
prima che MiniMax Music inizi a caricare; disattivando il Planner rimane
disponibile l'input manuale.

Music usa i nodi nativi di ComfyUI e i tre pesi configurati in Admin:

- `minimax_music3_dit_fp16.safetensors`
- `minimax_music3_text_encoder_pruned_int8_convrot.safetensors`
- `minimax_music3_dav.safetensors`

Il composer accetta una descrizione del brano, una durata da 5 a 360 secondi e
un seed. Per i brani cantati, le lyrics possono usare sezioni come `[Intro]`,
`[Verse]`, `[Chorus]`, `[Bridge]` e `[Outro]`. Il decode tiled è attivo per
default per ridurre i picchi di memoria.

Nella Chat, richieste esplicite di voce o cantato disattivano
deterministicamente la modalità strumentale e le parole fornite dall'utente
vengono conservate nella loro lingua. Il popup **Rigenera** mostra separatamente
caption tecnica e lyrics, entrambe modificabili.

## Music video e lip-sync H3

Un parlato, brano o audio importato può essere inviato al Video Studio e
impostato, nella card `Audio 1`, come **Audio esatto + lip-sync (I2V/R2V)**.
Non è un semplice mux e non chiede a H3 di ricreare la traccia:

- la durata rilevata determina automaticamente il numero di shot H3;
- il sampler riceve per ogni shot la porzione temporale corrispondente come
  `<Soundtrack>`;
- il planner descrive performance, bocca e respiro sincronizzati senza
  inventare o trascrivere il testo;
- l'audio H3 generato viene scartato e il file originale diventa il master
  finale;
- video e audio sono rifilati alla durata esatta del brano;
- PDD/Turbo viene escluso automaticamente perché non è compatibile con il
  sampler musicale; il preset FAST diventa standard 8-step.

La modalità accetta `I2V` oppure `Reference` e al massimo 12 shot. In I2V
`Picture 1` è il frame iniziale esatto; in Reference è una reference visiva.
Se la durata dell'audio è nota, gli shot vengono calcolati automaticamente;
altrimenti restano validi durata e numero di shot scelti nello Studio.
**Soundtrack esatto** resta disponibile quando serve soltanto
conservare/muxare l'audio senza il condizionamento temporale dedicato al
lip-sync.

## Parlato → brano

Questa modalità conserva il parlato originale e gli costruisce intorno una base
strumentale. Il file può essere caricato dal disco oppure scelto dalla Libreria.
Whisper ne prepara una trascrizione modificabile; il planner LLM usa testo,
durata reale e direzione creativa per produrre una caption MiniMax Music priva
di voci. LLM viene scaricato prima del render musicale.

Al termine della generazione, FFmpeg crea un unico WAV stereo a 48 kHz:

- la voce mantiene il proprio contenuto e timing;
- la base viene adattata alla durata esatta del parlato;
- il sidechain ducking abbassa automaticamente la musica durante la voce;
- limiter finale e controlli separati di voce, musica e ducking evitano clipping.

La base intermedia viene rimossa dopo un mix riuscito. Il file finale appare nel
pannello Audio e nella Libreria del progetto. Questa funzione non trasforma la
voce in canto.

## Canzone col mio timbro

Questa modalità usa una reference vocale soltanto come identità timbrica. Il
testo e la performance vengono generati da MiniMax Music 3, quindi la pipeline:

1. normalizza brano e reference;
2. separa voce e accompagnamento con BS-RoFormer Q8;
3. converte lo stem vocale con Seed-VC Q8 in modalità SVC, conservando melodia
   e intonazione tramite F0;
4. ricrea un WAV stereo 48 kHz con limiter tramite FFmpeg.

ComfyUI viene scaricata dalla VRAM prima della separazione. BS-RoFormer e
Seed-VC girano come processi audio.cpp distinti: alla loro uscita il modello non
resta residente. Stop termina l'albero attivo e annulla anche l'eventuale job
MiniMax ancora in coda. L'originale intermedio viene eliminato soltanto dopo un
mix finale riuscito.

Eseguire `INSTALL_AUDIO_VOICE.bat` dalla radice del progetto per installare il
runtime ufficiale audio.cpp v0.7 CUDA e i due modelli in `data/runtimes`. I
download sono riprendibili e non vengono inseriti nel repository. In Admin si
possono cambiare root, percorsi dei modelli, backend, step e opzioni F0.

## Voce H3 e lip-sync

Per un video con un soggetto parlante, allegare l'immagine iniziale e l'audio
nella Chat e chiedere esplicitamente di animare l'immagine con quel parlato.
Il router seleziona I2V, mantiene Picture 1 sul frame zero, inietta porzioni
temporali dell'audio nel sampler e conserva la traccia originale nel master.
Senza immagine, oppure chiedendo esplicitamente un riferimento, resta
disponibile Reference H3.

## Stati e cancellazione

Ogni job espone fase e percentuale quando il motore la rende disponibile.
`Interrompi` termina il processo Higgs del solo job TTS, cancella il prompt
MiniMax Music nella coda ComfyUI oppure chiude il processo audio.cpp attivo per
una conversione timbrica. I job falliti o interrotti restano visibili senza
barra animata e possono essere eliminati.

## Configurazione Admin

La scheda Higgs controlla cartella runtime, voce predefinita e parametri di
sampling. La scheda MiniMax Music seleziona DiT, encoder, VAE/DAV, step, CFG e
decode tiled dalle liste reali esposte da ComfyUI. I pesi non sono inclusi nel
repository. La scheda audio.cpp / Seed-VC mostra separatamente lo stato del
runtime e dei due modelli di separazione e conversione.
