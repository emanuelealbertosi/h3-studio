# Pubblicazione su GitHub

Il repository è progettato per contenere applicazione, workflow, nodo H3 Studio
e documentazione, ma non password, database, media generati o pesi dei modelli.

## Prima pubblicazione

1. Verificare che `LICENSE` contenga GNU AGPL-3.0-only. Il nodo derivato
   conserva separatamente la licenza MIT del progetto di origine.
2. Eseguire:

   ```powershell
   npm ci
   npm run sanitize:workflows
   npm run typecheck
   npm run test:setup
   npm run test:projects
   npm run build
   ```

3. Creare il repository GitHub e collegarlo:

   ```powershell
   git init -b main
   git add .
   git commit -m "Initial H3 Studio release"
   git remote add origin <URL-REPOSITORY>
   git push -u origin main
   ```

La CI inclusa ripete sanitizzazione, typecheck, test principali e build su
Windows con Node.js 22.16.0 o superiore.

## Cosa riceve chi clona

- wizard di primo avvio e password Admin locale;
- URL ComfyUI, output, FFmpeg e ruoli workflow configurabili;
- workflow API/UI già pronti e privi di prompt, media o LoRA personali;
- nodo H3 Studio completo in `comfyui_nodes/`;
- installer dei custom node esterni;
- checklist Admin interrogata contro la ComfyUI realmente collegata.

I pesi non vengono inclusi: sono troppo grandi e possono avere licenze diverse.
Il pannello Admin mostra per ciascuno nome e cartella `models/` attesi.

## Sicurezza

- `.env`, `data/`, SQLite, sessioni, log e output sono esclusi da Git.
- La password viene derivata con scrypt; il valore in chiaro non viene scritto.
- La prima configurazione va completata da localhost prima di abilitare
  Tailscale o qualunque reverse proxy.
- L'autenticazione attuale protegge l'Admin. Prima di esporre lo Studio a utenti
  non fidati vanno completati login utente, allowlist e quote/crediti server-side.
- ComfyUI non deve essere pubblicata direttamente su Internet.
