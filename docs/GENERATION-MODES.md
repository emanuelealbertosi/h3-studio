# Modalità di generazione H3 Studio

Questo documento descrive il mapping verificato tra H3 Studio e il workflow
`FINAL-MiniMax H3 AIO AUTOPROMPT ULTRA - OFFICIAL SKILL EXPERIMENT`.

## Mapping

| Modalità Studio | Valore workflow | Asset minimi | Routing |
|---|---|---|---|
| Text to video | `T2V` | Nessuno | Il Media Loader viene svuotato intenzionalmente. |
| Image to video | `I2V` | Picture 1 | Picture 1 diventa il frame iniziale; il planner resta text-only. |
| Reference | `R2V` | Almeno un'immagine, video o audio | Gli asset seguono l'ordine del Media Loader e i ruoli dichiarati. |
| Keyframes | `KEYFRAMES` | Almeno Picture 1 | Picture 1..N diventano anchor sulla timeline globale; Studio e Chat accettano distribuzione automatica, percentuali o secondi espliciti. |
| Continue video | `VIDEO EXTENSION` | Video 1, fino a 180 secondi nello Studio | Il router continua dall'ultimo frame decodificato e salva soltanto il nuovo segmento. |
| Video editing H3 | `VIDEO EDITING` | Video 1, fino a 180 secondi nello Studio | Video 1 resta la sorgente temporale; l'Ultra AIO Composer applica con H3 standard/Hybrid la trasformazione descritta nel prompt. |
| Masking H3 · SAM3 | `VIDEO EDITING` + maschera | Esattamente Video 1 e un bersaglio testuale | SAM3 segue il bersaglio, MaskVid crea un crop stabile e ricompone l'area elaborata sul video originale. |

## Video editing nativo H3

Questa modalità usa il percorso `VIDEO EDITING` già presente nell'Ultra AIO
Composer. Il video sorgente rimane la base temporale da trasformare; il prompt
descrive il risultato, gli eventi e gli elementi da preservare. Non vengono
aggiunte maschere o dipendenze SAM/MaskVid.

Il modello è quello H3 standard configurato nell'Admin (Hybrid per default).
PDD FAST resta escluso intenzionalmente dall'editing: con richieste strutturali
il percorso standard è più prevedibile. Per usare invece il video soltanto come
ispirazione o riferimento scegli `Reference / Remix H3`.

## Masking H3 selettivo

`Masking H3 · SAM3` è distinto dal Video editing nativo. Si usa quando la
trasformazione deve riguardare un solo soggetto o oggetto, per esempio
`vestito della donna` o `automobile rossa`. SAM3 produce una maschera temporale,
MaskVid ritaglia una finestra stabile attorno al soggetto, H3 lavora a risoluzione
nativa sul ritaglio e MaskVid lo ricompone sui frame originali. L'esterno della
maschera non viene rigenerato.

Lo Studio permette di allargare la maschera e limitare l'intervento a un intervallo
in secondi; `0–0` indica l'intera clip. Il latent upscale è intenzionalmente escluso
da questa modalità: si usa una risoluzione H3 nativa fino a 0,98 MP. Le dipendenze
opzionali sono ComfyUI-SAM3, MaskVidExperiments e il peso `models/sam3/sam3.pt`.
Il worker SAM3 viene scaricato dalla memoria prima che inizi il sampling H3.

### Contratto full-reference ufficiale

Il formatter applica il contratto full-reference ufficiale anche quando il piano
LLM è incompleto: definisce `<Video 1>`, corregge il tipo del `summary`, completa
la retention della sorgente e, solo quando esiste davvero una traccia audio,
definisce `<Audio 1>` con `fully_copy` o `reference`. Poiché il planner dello
Studio è text-only, non gli è consentito inventare volto, abbigliamento, ambiente
o altri attributi non esplicitati; il prompt finale conserva esattamente tutti
gli elementi del fotogramma sorgente che l'utente non chiede di modificare.
## Multishot 1–12

Il controllo **Shot** sceglie esattamente da 1 a 12 clip generate nello stesso
job. **Durata** resta la durata di ogni singolo shot; ad esempio `6 × 10 s`
produce circa un minuto. I candidati restano seriali e ogni candidato contiene
l'intera sequenza. Il planner deve restituire esattamente il numero scelto e il
sampler usa la frame memory già presente nel workflow fra una clip e la successiva.

In modalità Reference ogni asset espone tre criteri:

- `Auto`: il planner sceglie il più piccolo insieme utile di shot;
- `Tutti`: la reference è obbligatoria in ogni shot;
- numeri `1..12`: la reference è consentita solo negli shot selezionati.

Il piano conserva separatamente `active_ref_images`, `active_ref_videos` e
`active_ref_audios`. Prima del text encoding, il reference bank elimina i blocchi
inattivi e ricompatta localmente i marker `<Picture N>`, `<Video N>` e `<Audio N>`.
Un video con soundtrack accoppiata rimane un unico blocco fisico, quindi video e
audio abbinati vengono attivati insieme.

## Blocco di continuità I2V

In I2V il planner riceve solo testo: Picture 1 resta collegata direttamente al
conditioning H3 come frame iniziale e non passa dal backend LLM. Lo Studio
aggiunge al prompt una direttiva che impone di conservare identità, volto, corpo,
capelli, abbigliamento, colori, ambiente, composizione e stile, animando soltanto
l'azione richiesta. Questo evita di richiedere capacità Vision ai backend GGUF
text-only. Con un solo shot il parser elimina inoltre eventuali `[Shot 2+]`
inventati dal planner, conservandone soltanto le azioni come beat temporali
continui dentro `[Shot 1]`.

## Invarianti dello Studio

- Ogni candidato e ogni continuazione restano file video autonomi.
- `H3SaveContinuation.prepend_source_video` è sempre `false`.
- Continue salva esclusivamente il nuovo segmento, senza duplicare il video sorgente.
- Il montaggio concatena virtualmente le clip durante il playback; non modifica i file originali.
- Copy e Move fra progetti cambiano soltanto i riferimenti della timeline.
- Prompt, asset, ruoli, keyframe, seed e impostazioni FAST sono persistiti con il job.
- Numero di shot, schedule reference e durata totale sono ripristinati in cronologia, rigenerazione e timeline.
- Gli upload usano la route ufficiale `/minimax_h3/upload` del Media Loader installato.

## Media state

Il bridge conserva il JSON ordinato del Media Loader. Ogni asset include almeno:

- `kind`: `picture`, `video` o `audio`;
- `file`: percorso annotato ComfyUI `[input]`, `[output]` o `[temp]`;
- `name` e `uid`;
- per i video, quando disponibile, durata, dimensioni, presenza audio e routing audio.

Il bridge rifiuta percorsi assoluti, traversal `..`, tipi sconosciuti e asset oltre
i limiti reali H3: 9 immagini, 3 video e 3 audio.

## Verifica senza GPU

La route `POST /api/jobs/dry-run` costruisce il prompt API completo senza
accodarlo. I sei modi sono verificati con asset reali già presenti in ComfyUI;
il dry-run espone anche `shotCount`, `mediaAssetCount`, seed candidati e
`continuationOnly`.
