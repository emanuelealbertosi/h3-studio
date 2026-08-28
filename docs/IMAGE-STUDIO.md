# Image Studio

Image Studio porta immagini e video nello stesso progetto. Il selettore in alto
passa da **Video** a **Immagini** senza trasformare le immagini in una libreria
separata.

## Modalità

- **Genera** usa il profilo Krea 2 configurato nell’Admin.
- **Edit** usa Flux.2 Klein e richiede da una a quattro reference.
- Ogni batch può produrre da uno a quattro candidati con seed Random, Base +1
  oppure Bloccato.
- I preset 1:1, 16:9, 9:16, 4:3 e 3:4 restano sotto circa 1,8 megapixel e usano
  dimensioni multiple di 16.

I tag Personaggio, Oggetto e Luogo sono metadati del progetto: servono a
classificare e riusare l’immagine, ma non cambiano da soli il render.

## Preset di composizione

Il composer offre **Libero**, **Character sheet / turnaround**, **Primo piano**,
**Mezzo busto**, **Figura intera**, **Oggetto sheet** e **Luogo**. Libero
invia il testo invariato; gli altri preset aggiungono in coda una direttiva di
inquadratura adatta al caso scelto. Il testo scritto dall'utente non viene
sostituito e rimane modificabile separatamente.

La selezione attiva e la relativa descrizione sono sempre visibili. La voce
**Prompt effettivo inviato al motore** permette inoltre di controllare il testo
completo prima di avviare il batch. Il bridge ricompone e valida lo stesso prompt
prima di costruire il grafo ComfyUI, così un payload incoerente non entra in coda.

Per **Character sheet / turnaround** il formato è vincolato a **16:9
(1792 × 1008)**: un singolo foglio contiene quattro viste intere ordinate
(frontale, tre quarti, profilo e retro), mentre il numero di generazioni indica
quante varianti complete del foglio produrre. Il prompt esclude testo ed etichette,
ma il modello immagini può occasionalmente inventare pseudo-testo o glifi: in quel
caso è consigliabile rigenerare o scegliere un altro candidato.

## Reference Flux.2 Klein

Le reference sono ordinate e limitate a quattro, come nel contratto ufficiale
del modello. Ogni input può avere ruolo Base, Soggetto, Stile, Posa, Sfondo o
Altro. H3 Studio aggiunge al prompt una mappa esplicita Image 1, Image 2 e così
via, quindi ordine e ruolo influenzano realmente l’istruzione inviata a Flux.

Un candidato completato può essere:

- aperto o scaricato;
- scelto come risultato del batch;
- riusato immediatamente come base di un Edit;
- aggiunto alle reference correnti;
- condiviso con altri progetti e taggato diversamente in ciascuno.

La condivisione è per singolo candidato: condividere una immagine di un batch
non espone le altre.

## Riutilizzo nello Studio Video

Nel composer video, **Scegli dalla libreria** mostra prima le immagini generate
e collegate al progetto corrente, quindi le altre immagini riutilizzabili. La
scelta crea una reference Picture che punta direttamente al file di output
ComfyUI (`[output]`): non duplica il file e non esegue un nuovo upload.

Le stesse immagini compaiono nel menu `@` del prompt. Il nome, la didascalia,
le dimensioni e il tag del candidato vengono riportati nella reference; se il
video era in modalità T2V, H3 Studio passa automaticamente a Reference. Un
fallback globale mantiene visibili anche risultati storici privi del vecchio
legame candidato-progetto.

## Generazione Anima

La terza modalità **Anima**, accanto a Genera ed Edit, usa un workflow
indipendente basato sui loader core di ComfyUI. Il profilo Admin sceglie
checkpoint, text encoder, VAE, step, CFG e fino a tre LoRA senza modificare le
impostazioni H3, Krea o Flux. I preset di composizione e la gestione
uno-quattro candidati restano gli stessi dello Studio Immagini.

Il default locale è **anima_turboV10.safetensors** con
**anima_baseV10_txt.safetensors**, **qwen_image_vae.safetensors**,
Euler/simple, 8 step e CFG 1. Il modello base ufficiale può invece essere
configurato con 30 step e CFG 4; l'eventuale Turbo LoRA va selezionato
esplicitamente in Admin. I job Anima sono identificati dallo snapshot del
motore, mentre il database mantiene la modalità Generate per compatibilità con
installazioni precedenti.

## Profilo raccomandato

Il profilo distribuito è **Flux.2 Klein 4B Distilled FP8** con Qwen 3 4B,
Flux2 VAE, Euler, quattro step e CFG 1. È il profilo adatto come default a una
GPU da 16 GB.

Flux KV Cache è disponibile come ottimizzazione sperimentale ma resta
disattivata per impostazione predefinita perché può modificare l’aderenza alle
reference. Il backend attention può essere Auto, PyTorch o Comfy Kitchen, ma
l’Admin mostra soltanto le opzioni realmente esposte dalla ComfyUI collegata.

Il vecchio workflow Multi Input Compact rimane utile come riferimento di
interfaccia, ma non è il profilo pubblico predefinito: usa uno stack 9B più
pesante, cinque reference e dipendenze aggiuntive. H3 Studio usa invece un
blueprint API core versionato. Il workflow scelto nell’Admin viene letto
realmente dal bridge; gli input dinamici, i modelli, i seed e la catena di
reference vengono poi ricostruiti e validati prima dell’invio.

## Persistenza e sicurezza

Job, candidati, seed, reference, preset di composizione, prompt utente, prompt
effettivo, prompt API e legami con i progetti sono persistiti in SQLite o nello
snapshot del job. I file restano nell’output ComfyUI. Dopo un riavvio il
bridge recupera i prompt ancora attivi e il frontend riprende il polling.

Prima di abilitare Genera, l’interfaccia verifica workflow, modelli, VAE,
encoder e nodi richiesti. Un job non viene creato quando il motore selezionato
non è pronto.

## Prompt Compiler AI

Il **Prompt Compiler AI** è attivo per impostazione predefinita in Genera, Edit
e Anima. La richiesta può essere scritta in italiano o in un’altra lingua; LLM
la converte nel formato specifico del motore selezionato. In Edit preserva ciò
che non è stato richiesto di cambiare e mantiene l’ordine delle reference; in
Anima usa una descrizione illustrativa invece della sintassi fotografica.

Il prompt tecnico prodotto è sempre visibile e modificabile prima del render.
Dopo la compilazione il modello LLM viene scaricato dalla memoria, quindi Krea, Flux o
Anima possono caricare senza contendersi la VRAM. Il selettore permette di
disabilitare il Compiler e usare in qualsiasi momento il prompt manuale.
