# Modelli Engine nell’Admin

Le configurazioni degli engine sono indipendenti:

- **MiniMax H3 standard** usa soltanto `settings.h3`;
- **LTX 2.5** usa soltanto `settings.ltx25` (checkpoint, encoder, due VAE,
  spatial latent upscaler, CFG e sampler);
- **Krea 2** usa soltanto `settings.krea`;
- **Flux.2 Klein Edit** usa soltanto `settings.imageEdit`.

Cambiare modello, encoder o VAE di Flux non deve modificare né la selezione né il
valore persistito di H3 o Krea.

Il profilo LTX consigliato per una RTX 5070 Ti 16 GB usa RedGraft INT8,
l'encoder LTX 2.5 INT8 ConvRot, Video VAE Conv BF16, Audio VAE BF16, spatial
upscaler LTX 2.3 x2, CFG 1 ed Euler. Fast usa 8 step; Quality usa 8 step base,
upscale latent 2× e refine a 3 step. I file possono risiedere in un model store esterno dichiarato
in `extra_model_paths.yaml`. Il checkpoint occupa quasi tutta la VRAM fisica di
una scheda da 16 GB: l'avvio di ComfyUI deve quindi conservare l'offload
aggressivo (`--disable-smart-memory` nel profilo Windows usato da H3 Studio).

Le tendine partono dall’elenco reale restituito da ComfyUI e applicano un filtro
per famiglia. Per LTX il filtro è rigoroso: se i cinque asset compatibili non sono
visibili, le select restano vuote e mostrano un avviso invece di proporre per errore
un modello H3, un encoder generico o la VAE con ruolo sbagliato.

La configurazione standard H3 predefinita è:

`minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors`
