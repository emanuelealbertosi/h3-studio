# Modelli Engine nell’Admin

Le configurazioni degli engine sono indipendenti:

- **MiniMax H3 standard** usa soltanto `settings.h3`;
- **FAST Alibaba PDD-Acc** usa soltanto `settings.fast` e abbina automaticamente
  la patch PDD compatibile;
- **LTX 2.5** usa soltanto `settings.ltx25` (checkpoint, encoder, due VAE, CFG e sampler);
- **Krea 2** usa soltanto `settings.krea`;
- **Flux.2 Klein Edit** usa soltanto `settings.imageEdit`.

Cambiare modello, encoder o VAE di Flux non deve modificare né la selezione né il
valore persistito di H3 o Krea.

Il profilo LTX consigliato per una RTX 5070 Ti 16 GB usa RedGraft INT8,
l'encoder LTX 2.5 INT8 ConvRot, Video VAE Conv BF16, Audio VAE BF16, CFG 1 ed
Euler ancestral. I file possono risiedere in un model store esterno dichiarato
in `extra_model_paths.yaml`.

Le tendine partono dall’elenco reale restituito da ComfyUI e applicano un filtro
per famiglia. Il valore corrente viene sempre mantenuto visibile, anche quando il
file non è momentaneamente rilevato, così la select non ricade visivamente sulla
prima voce di un altro engine.

La configurazione standard H3 predefinita è:

`minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors`
