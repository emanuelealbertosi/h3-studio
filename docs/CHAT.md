# Chat locale

La voce **Chat** usa un assistente LLM Vision locale. Ogni progetto può
contenere più conversazioni indipendenti, persistenti in SQLite dopo il riavvio
di H3 Studio. Il sottomenu a sinistra le raggruppa per progetto.

## Uso

- Premi `+` accanto a un progetto per creare una nuova conversazione. Il titolo
  viene proposto dal modello LLM durante la prima risposta, senza una seconda inferenza,
  e può essere modificato con la matita.
- Il cestino elimina la conversazione dopo un popup di conferma. **Conserva i
  media generati** è selezionato per impostazione predefinita: messaggi e memoria
  vengono rimossi, mentre immagini e video rimangono nel progetto e nella
  Libreria. Deselezionandolo vengono rimossi anche i job generati dalla Chat,
  i relativi file, le varianti Face/Upscale e le clip che li usano nei Montaggi.
- Scrivi normalmente per discutere un'idea, migliorare un prompt o chiedere
  consigli; nessun job parte se non chiedi esplicitamente di creare o modificare
  un media.
- Premi `+` oppure digita `@` alla fine del testo per aprire la Libreria. Le
  miniature mostrano immagini, video e media Esterni riutilizzabili.
- Con immagini allegate puoi chiedere un'analisi, un edit Flux.2 Klein, un I2V
  o un Reference H3. LLM può osservare fino a quattro immagini per messaggio;
  il router accetta fino a otto media complessivi per un'azione.
- Sopra il campo di testo scegli **Auto, Video H3, Krea, Anima o Edit**. La
  scelta esplicita prevale sempre sul router del modello LLM, ma non avvia nulla finché
  il testo non contiene una richiesta esplicita di generazione. Se vuoi essere
  certo di ottenere un disegno, seleziona **Anima**; se vuoi una fotografia o
  un'immagine generale, seleziona **Krea**.
- In **Auto**, anime, manga, disegno, illustrazione e cartoon vengono instradati
  ad Anima; le immagini fotografiche o generiche usano Krea.
- Una richiesta video senza durata usa 10 secondi, un candidato, 0,5 MP e FAST
  8-step. Se indichi la durata totale, la Chat attiva automaticamente il
  multishot: per esempio 30 secondi diventano `3 × 10 s`. Sono supportati fino
  a 12 shot; oltre 120 secondi usa chunk da 15 secondi, fino a un massimo di
  180 secondi. Per cambiare gli altri parametri apri poi il job nello Studio.

Le azioni compaiono come schede vive nella conversazione. Durante la preparazione
del modello LLM e poi durante la produzione, il riquadro mostra lo splash sfocato, la
fase corrente e la percentuale quando ComfyUI la rende disponibile. Al termine
lo stesso riquadro viene popolato con l'immagine o con il player video: non serve
aprire lo Studio per vedere il risultato.

Mentre una produzione è attiva, il compositore della Chat rimane bloccato per
evitare richieste sovrapposte. **Interrompi** cancella soltanto quel job; al
termine, in caso di errore o dopo l'annullamento il compositore torna disponibile.
Il pulsante **Apri nello Studio** resta disponibile per continuare il lavoro con
tutti i controlli avanzati. Se si ricarica la pagina, la Chat recupera lo stato
del job dal suo identificatore e riprende l'aggiornamento della scheda.

Quando il job è terminato, **Rigenera** apre un popup con il prompt usato già
compilato. È possibile correggerlo o riscriverlo prima della conferma; la nuova
generazione usa un seed casuale e non modifica il media originale. Lo stesso
popup è disponibile per candidati e batch negli Studio Video e Immagini.

I prompt di produzione sono generati in inglese, mentre la risposta
dell'assistente resta in italiano.

## Runtime e memoria

Ogni conversazione conserva cronologia e memoria proprie in SQLite, ma non viene
reinviata integralmente al modello. Quando la finestra recente supera 16
messaggi o il budget derivato da `n_ctx`, LLM consolida i messaggi meno recenti
in una memoria persistente della conversazione. La richiesta successiva contiene:

1. regole del router;
2. motore scelto nell'interfaccia;
3. memoria compatta della conversazione;
4. messaggi recenti entro il budget;
5. allegati Vision del messaggio corrente.

La memoria conserva decisioni, identità, asset, preferenze, impostazioni riuscite
e attività aperte; elimina saluti e ripetizioni. Il badge **Memoria · N** mostra
quanti messaggi sono già stati assimilati e, passando il mouse, permette di
leggere il riassunto. **Pulisci** elimina sia cronologia sia memoria.

La Chat ricorda inoltre l'ultimo media disponibile nella conversazione: prima
considera immagini e video prodotti dalle azioni della Chat e poi gli allegati
caricati dall'utente, rispettando l'ordine cronologico.
Non lo reinvia a ogni turno: lo recupera soltanto quando un messaggio senza nuovi
allegati contiene un riferimento esplicito, per esempio “modificala”, “animala”,
“questa immagine”, “quel video”, “usala” o “continualo”. Il messaggio registrato
mostra **Memoria** sulla miniatura recuperata, così è sempre evidente quale file
verrà usato. Per esempio, dopo aver creato un'immagine si può scrivere
“modificala rendendo il gatto blu” senza allegarla di nuovo: l'edit userà
automaticamente quell'output. Un nuovo allegato o un nuovo output diventa il
riferimento più recente.

Questo meccanismo non consuma continuamente il contesto Vision: al massimo
quattro immagini vengono inviate al modello e soltanto nel turno che le usa;
gli altri messaggi conservano esclusivamente nome e tipo del media nel testo
compatto della conversazione.

Il nodo incluso non avvia LM Studio. Usa soltanto un `llama-server` compatibile
con LLM Vision e MTMD:

1. prima cerca `H3_CHAT_LLAMA_SERVER`;
2. poi `runtime/llama-server(.exe)` nella cartella del nodo;
3. poi il `PATH`;
4. infine i backend locali di LM Studio, scegliendo il CUDA 12 più recente.

Il modello e il `mmproj` si scelgono nell'Admin e devono appartenere alla stessa
famiglia. Il server ascolta soltanto su `127.0.0.1` e su una porta casuale. Resta
in memoria fra messaggi consecutivi per rendere la conversazione veloce, quindi
viene terminato automaticamente prima di Video, Image, Face o Upscale.

## Diagnostica

In Admin, **LLM Vision Chat** mostra `PRONTO`, `CARICATO` oppure `SETUP`.
`SETUP` indica che manca il nodo, il runtime, il GGUF o il projector. Dopo aver
installato/aggiornato il nodo occorre riavviare ComfyUI; non serve avviare LM
Studio. Il test di contratto del repository è `npm run test:chat`.
