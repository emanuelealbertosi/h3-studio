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

Il **TTS Planner AI**, attivo per impostazione predefinita, usa il Gemma della
Chat come Prompt Compiler: accetta una richiesta in qualunque lingua, separa le
indicazioni di voce/prosodia dal testo pronunciato e conserva la lingua richiesta.
Il copione Higgs prodotto resta visibile e modificabile. Gemma viene scaricato
prima del caricamento di Higgs; disattivando il Planner si torna al testo diretto.

Per il cloning one-shot si può caricare un file audio oppure sceglierne uno
dalla Libreria. Un campione breve, pulito e con una singola voce funziona
meglio. H3 Studio lo trascrive automaticamente con `openai/whisper-small`,
multilingua, in un processo isolato. Whisper termina e libera la VRAM prima di
Higgs; la trascrizione resta modificabile e, in caso di errore, si può compilare
manualmente oppure lasciare che Higgs usi il solo campione audio.

## MiniMax Music 3

Il **Music Planner AI**, attivo per impostazione predefinita, usa il Gemma
configurato nella Chat per convertire una richiesta naturale in una caption
tecnica inglese e, quando richiesto, in lyrics strutturate. Il piano resta
visibile e modificabile prima della generazione. Gemma viene sempre scaricato
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

## Stati e cancellazione

Ogni job espone fase e percentuale quando il motore la rende disponibile.
`Interrompi` termina il processo Higgs del solo job TTS oppure cancella il
prompt MiniMax Music nella coda ComfyUI. I job falliti o interrotti restano
visibili senza barra animata e possono essere eliminati.

## Configurazione Admin

La scheda Higgs controlla cartella runtime, voce predefinita e parametri di
sampling. La scheda MiniMax Music seleziona DiT, encoder, VAE/DAV, step, CFG e
decode tiled dalle liste reali esposte da ComfyUI. I pesi non sono inclusi nel
repository.
