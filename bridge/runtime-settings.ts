import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertPddModelCompatibility,
  FAST_PDD_PAIRS,
} from "./pdd-compatibility.js";

export type EngineLoraSettings = {
  name: string;
  strength: number;
};

export type H3EngineSettings = {
  model: string;
  loras: EngineLoraSettings[];
  steps: number;
};

export type FastEngineSettings = {
  model: string;
  pddFile: string;
  loras: EngineLoraSettings[];
  steps: 8;
};

export type Ltx25EngineSettings = {
  model: string;
  encoder: string;
  videoVae: string;
  audioVae: string;
  steps: 8;
  cfg: number;
  sampler: "euler_ancestral" | "euler";
};

export type KreaEngineSettings = {
  model: string;
  encoder: string;
  vae: string;
  loras: EngineLoraSettings[];
  steps: number;
};

export type ImageEditEngineSettings = {
  model: string;
  encoder: string;
  vae: string;
  steps: number;
  cfg: number;
  kvCacheEnabled: boolean;
  attentionBackend:
    | "auto"
    | "pytorch attention"
    | "comfy kitchen attention";
};

export type AnimaEngineSettings = {
  model: string;
  encoder: string;
  vae: string;
  loras: EngineLoraSettings[];
  steps: number;
  cfg: number;
};

export type ChatEngineSettings = {
  model: string;
  projector: string;
  nCtx: number;
  nGpuLayers: number;
  nThreads: number;
  maxNewTokens: number;
  temperature: number;
  topP: number;
};

export type TtsEngineSettings = {
  root: string;
  voice: string;
  temperature: number;
  topP: number;
  topK: number;
  speed: number;
  maxNewTokens: number;
};

export type MusicEngineSettings = {
  model: string;
  encoder: string;
  vae: string;
  steps: number;
  cfg: number;
  tiledDecode: boolean;
};

export type VoiceConversionEngineSettings = {
  root: string;
  separatorModel: string;
  seedVcModel: string;
  backend: "cuda" | "cpu";
  steps: number;
  f0Condition: boolean;
  autoF0Adjust: boolean;
};

export type RuntimeSettings = {
  h3: H3EngineSettings;
  fast: FastEngineSettings;
  ltx25: Ltx25EngineSettings;
  krea: KreaEngineSettings;
  imageEdit: ImageEditEngineSettings;
  anima: AnimaEngineSettings;
  chat: ChatEngineSettings;
  tts: TtsEngineSettings;
  music: MusicEngineSettings;
  voiceConversion: VoiceConversionEngineSettings;
};

export type ResolvedEngineSettings = H3EngineSettings & {
  family: "h3" | "ltx25";
  profile: "standard" | "fast";
  pddFile: string | null;
  /** Legacy summary fields kept for existing job records and clients. */
  lora: string;
  loraStrength: number;
};

export function isFlux2KleinModelFilename(value: string) {
  return /(?:flux.*2.*klein|klein.*flux|unstable.*f2k|snofs)/i.test(value);
}

export function isFlux2Klein9BModelFilename(value: string) {
  return /(?:9b|snofs)/i.test(value);
}

export function isAnimaModelFilename(value: string) {
  return /(?:anima|nova.*am)/i.test(value);
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = Object.freeze({
  h3: {
    model: "minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors",
    loras: [],
    steps: 8,
  },
  fast: {
    model: FAST_PDD_PAIRS[0].model,
    pddFile: FAST_PDD_PAIRS[0].pddFile,
    loras: [],
    steps: 8,
  },
  ltx25: {
    model: "redgraftLTX25Fast2K_ltx25RedgraftNSFW.safetensors",
    encoder: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
    videoVae: "ltx-2.5-video-vae-conv-bf16.safetensors",
    audioVae: "ltx-2.5-audio-vae-bf16.safetensors",
    steps: 8,
    cfg: 1,
    sampler: "euler_ancestral",
  },
  krea: {
    model: "krea2TurboFP8_krea2TURBO.safetensors",
    encoder: "qwen3vl_4b_fp8_scaled.safetensors",
    vae: "qwen_image_vae.safetensors",
    loras: [],
    steps: 8,
  },
  imageEdit: {
    model: "flux-2-klein-4b-fp8.safetensors",
    encoder: "qwen_3_4b.safetensors",
    vae: "flux2-vae.safetensors",
    steps: 4,
    cfg: 1,
    kvCacheEnabled: false,
    attentionBackend: "auto",
  },
  anima: {
    model: "anima_turboV10.safetensors",
    encoder: "anima_baseV10_txt.safetensors",
    vae: "qwen_image_vae.safetensors",
    loras: [],
    steps: 8,
    cfg: 1,
  },
  chat: {
    model: "huihui-ai\\Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-GGUF\\Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-Q4_K.gguf",
    projector: "huihui-ai\\Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-GGUF\\mmproj-model-bf16.gguf",
    nCtx: 16_384,
    nGpuLayers: -1,
    nThreads: 8,
    maxNewTokens: 1_536,
    temperature: 0.35,
    topP: 0.9,
  },
  tts: {
    root: "F:\\higgsaudio\\HiggsAudio-Studio",
    voice: "English_Female.wav",
    temperature: 1,
    topP: 0.95,
    topK: 50,
    speed: 1,
    maxNewTokens: 2_048,
  },
  music: {
    model: "minimax_music3_dit_fp16.safetensors",
    encoder: "minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
    vae: "minimax_music3_dav.safetensors",
    steps: 30,
    cfg: 1.7,
    tiledDecode: true,
  },
  voiceConversion: {
    root: path.join(process.cwd(), "data", "runtimes", "audio-cpp"),
    separatorModel: "models\\BS-RoFormer-ep368-GGUF\\bs-roformer-ep368-q8_0.gguf",
    seedVcModel: "models\\SeedVC-MLX-GGUF\\seed-vc-mlx-q8_0.gguf",
    backend: "cuda",
    steps: 30,
    f0Condition: true,
    autoF0Adjust: true,
  },
});

function cloneDefaults(): RuntimeSettings {
  return {
    h3: {
      ...DEFAULT_RUNTIME_SETTINGS.h3,
      loras: DEFAULT_RUNTIME_SETTINGS.h3.loras.map((slot) => ({ ...slot })),
    },
    fast: {
      ...DEFAULT_RUNTIME_SETTINGS.fast,
      loras: DEFAULT_RUNTIME_SETTINGS.fast.loras.map((slot) => ({ ...slot })),
    },
    ltx25: { ...DEFAULT_RUNTIME_SETTINGS.ltx25 },
    krea: {
      ...DEFAULT_RUNTIME_SETTINGS.krea,
      loras: DEFAULT_RUNTIME_SETTINGS.krea.loras.map((slot) => ({ ...slot })),
    },
    imageEdit: {
      ...DEFAULT_RUNTIME_SETTINGS.imageEdit,
    },
    anima: {
      ...DEFAULT_RUNTIME_SETTINGS.anima,
      loras: DEFAULT_RUNTIME_SETTINGS.anima.loras.map((slot) => ({ ...slot })),
    },
    chat: { ...DEFAULT_RUNTIME_SETTINGS.chat },
    tts: { ...DEFAULT_RUNTIME_SETTINGS.tts },
    music: { ...DEFAULT_RUNTIME_SETTINGS.music },
    voiceConversion: { ...DEFAULT_RUNTIME_SETTINGS.voiceConversion },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateLoras(value: unknown, label: string): EngineLoraSettings[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`I LoRA ${label} non sono validi`);
  if (value.length > 3) throw new Error(`Puoi configurare al massimo 3 LoRA ${label}`);
  const result: EngineLoraSettings[] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) throw new Error(`Slot LoRA ${label} non valido`);
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) continue;
    const strength = Number(item.strength);
    if (!Number.isFinite(strength) || strength < -2 || strength > 2) {
      throw new Error(`La strength dei LoRA ${label} deve essere compresa fra -2 e 2`);
    }
    if (names.has(name)) throw new Error(`Il LoRA ${name} è selezionato più di una volta`);
    names.add(name);
    result.push({ name, strength });
  }
  return result;
}

function validateStepCount(value: unknown, label: string) {
  const steps = Number(value);
  if (!Number.isInteger(steps) || steps < 4 || steps > 40) {
    throw new Error(`Gli step ${label} devono essere un intero fra 4 e 40`);
  }
  return steps;
}

function migrateLegacySettings(value: Record<string, unknown>): RuntimeSettings | null {
  if (isRecord(value.h3) || isRecord(value.krea)) return null;
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!model) return null;
  const lora = typeof value.lora === "string" ? value.lora.trim() : "";
  const loraStrength = Number(value.loraStrength);
  const defaults = cloneDefaults();
  return {
    h3: {
      model,
      loras: lora
        ? [{ name: lora, strength: Number.isFinite(loraStrength) ? loraStrength : 1 }]
        : [],
      steps: validateStepCount(value.steps ?? defaults.h3.steps, "H3"),
    },
    fast: defaults.fast,
    ltx25: defaults.ltx25,
    krea: defaults.krea,
    imageEdit: defaults.imageEdit,
    anima: defaults.anima,
    chat: defaults.chat,
    tts: defaults.tts,
    music: defaults.music,
    voiceConversion: defaults.voiceConversion,
  };
}

function validateSettings(value: unknown): RuntimeSettings {
  if (!isRecord(value)) throw new Error("Impostazioni Engine mancanti");
  const migrated = migrateLegacySettings(value);
  if (migrated) return migrated;
  if (!isRecord(value.h3) || !isRecord(value.krea)) {
    throw new Error("Configurazione H3 o Krea mancante");
  }

  const defaults = cloneDefaults();
  const fast = isRecord(value.fast) ? value.fast : defaults.fast;
  const ltx25 = isRecord(value.ltx25) ? value.ltx25 : defaults.ltx25;
  const imageEdit = isRecord(value.imageEdit) ? value.imageEdit : defaults.imageEdit;
  const anima = isRecord(value.anima) ? value.anima : defaults.anima;
  const chat = isRecord(value.chat) ? value.chat : defaults.chat;
  const tts = isRecord(value.tts) ? value.tts : defaults.tts;
  const music = isRecord(value.music) ? value.music : defaults.music;
  const voiceConversion = isRecord(value.voiceConversion)
    ? value.voiceConversion
    : defaults.voiceConversion;

  const h3Model = typeof value.h3.model === "string" ? value.h3.model.trim() : "";
  const fastModel = typeof fast.model === "string" ? fast.model.trim() : "";
  const pddFile = typeof fast.pddFile === "string" ? fast.pddFile.trim() : "";
  const ltx25Model = typeof ltx25.model === "string" ? ltx25.model.trim() : "";
  const ltx25Encoder = typeof ltx25.encoder === "string" ? ltx25.encoder.trim() : "";
  const ltx25VideoVae = typeof ltx25.videoVae === "string" ? ltx25.videoVae.trim() : "";
  const ltx25AudioVae = typeof ltx25.audioVae === "string" ? ltx25.audioVae.trim() : "";
  const ltx25Cfg = Number(ltx25.cfg);
  const kreaModel = typeof value.krea.model === "string" ? value.krea.model.trim() : "";
  const encoder = typeof value.krea.encoder === "string" ? value.krea.encoder.trim() : "";
  const vae = typeof value.krea.vae === "string" ? value.krea.vae.trim() : "";
  const imageEditModel =
    typeof imageEdit.model === "string" ? imageEdit.model.trim() : "";
  const imageEditEncoder =
    typeof imageEdit.encoder === "string" ? imageEdit.encoder.trim() : "";
  const imageEditVae =
    typeof imageEdit.vae === "string" ? imageEdit.vae.trim() : "";
  const imageEditCfg = Number(imageEdit.cfg);
  const animaModel = typeof anima.model === "string" ? anima.model.trim() : "";
  const animaEncoder = typeof anima.encoder === "string" ? anima.encoder.trim() : "";
  const animaVae = typeof anima.vae === "string" ? anima.vae.trim() : "";
  const animaCfg = Number(anima.cfg);
  const chatModel = typeof chat.model === "string" ? chat.model.trim() : "";
  const chatProjector = typeof chat.projector === "string" ? chat.projector.trim() : "";
  const chatNCtx = Number(chat.nCtx);
  const chatNGpuLayers = Number(chat.nGpuLayers);
  const chatNThreads = Number(chat.nThreads);
  const chatMaxNewTokens = Number(chat.maxNewTokens);
  const chatTemperature = Number(chat.temperature);
  const chatTopP = Number(chat.topP);
  const ttsRoot = typeof tts.root === "string" ? tts.root.trim() : "";
  const ttsVoice = typeof tts.voice === "string" ? tts.voice.trim() : "";
  const ttsTemperature = Number(tts.temperature);
  const ttsTopP = Number(tts.topP);
  const ttsTopK = Number(tts.topK);
  const ttsSpeed = Number(tts.speed);
  const ttsMaxNewTokens = Number(tts.maxNewTokens);
  const musicModel = typeof music.model === "string" ? music.model.trim() : "";
  const musicEncoder = typeof music.encoder === "string" ? music.encoder.trim() : "";
  const musicVae = typeof music.vae === "string" ? music.vae.trim() : "";
  const musicCfg = Number(music.cfg);
  const voiceConversionRoot = typeof voiceConversion.root === "string"
    ? voiceConversion.root.trim()
    : "";
  const separatorModel = typeof voiceConversion.separatorModel === "string"
    ? voiceConversion.separatorModel.trim()
    : "";
  const seedVcModel = typeof voiceConversion.seedVcModel === "string"
    ? voiceConversion.seedVcModel.trim()
    : "";
  const voiceConversionSteps = Number(voiceConversion.steps);
  const imageEditKvCache =
    imageEdit.kvCacheEnabled === undefined
      ? defaults.imageEdit.kvCacheEnabled
      : imageEdit.kvCacheEnabled === true;
  const imageEditAttention =
    imageEdit.attentionBackend === "pytorch attention" ||
    imageEdit.attentionBackend === "comfy kitchen attention"
      ? imageEdit.attentionBackend
      : "auto";
  if (!h3Model) throw new Error("Seleziona un modello H3");
  if (!fastModel) throw new Error("Seleziona un modello FAST H3");
  if (!pddFile) throw new Error("Seleziona l'acceleratore PDD Alibaba per FAST");
  if (!ltx25Model) throw new Error("Seleziona un modello LTX 2.5");
  if (!ltx25Encoder) throw new Error("Seleziona il text encoder LTX 2.5");
  if (!ltx25VideoVae || !ltx25AudioVae) {
    throw new Error("Seleziona entrambe le VAE LTX 2.5");
  }
  if (!Number.isFinite(ltx25Cfg) || ltx25Cfg < 0.5 || ltx25Cfg > 3) {
    throw new Error("Il CFG LTX 2.5 deve essere compreso fra 0,5 e 3");
  }
  if (!kreaModel) throw new Error("Seleziona un modello Krea");
  if (!encoder) throw new Error("Seleziona il text encoder Krea");
  if (!vae) throw new Error("Seleziona la VAE Krea");
  if (!imageEditModel) throw new Error("Seleziona un modello Flux.2 Klein Edit");
  if (!isFlux2KleinModelFilename(imageEditModel)) {
    throw new Error(
      `Il modello ${imageEditModel} non è compatibile con Flux.2 Klein Edit`,
    );
  }
  if (!imageEditEncoder) throw new Error("Seleziona il text encoder Flux.2 Klein Edit");
  const expectedEncoderSize = isFlux2Klein9BModelFilename(imageEditModel)
    ? "8B"
    : "4B";
  const encoderPattern = expectedEncoderSize === "8B"
    ? /qwen.*3.*8b/i
    : /qwen.*3.*4b/i;
  if (!encoderPattern.test(imageEditEncoder)) {
    throw new Error(
      `Il modello ${imageEditModel} richiede un text encoder Qwen 3 ${expectedEncoderSize}`,
    );
  }
  if (!imageEditVae) throw new Error("Seleziona la VAE Flux.2 Klein Edit");
  if (!Number.isFinite(imageEditCfg) || imageEditCfg < 0 || imageEditCfg > 20) {
    throw new Error("Il CFG Flux.2 Klein Edit deve essere compreso fra 0 e 20");
  }
  if (!animaModel) throw new Error("Seleziona un modello Anima");
  if (!isAnimaModelFilename(animaModel)) {
    throw new Error(`Il modello ${animaModel} non sembra compatibile con Anima`);
  }
  if (!animaEncoder) throw new Error("Seleziona il text encoder Anima");
  if (!animaVae) throw new Error("Seleziona la VAE Anima");
  if (!Number.isFinite(animaCfg) || animaCfg < 0 || animaCfg > 20) {
    throw new Error("Il CFG Anima deve essere compreso fra 0 e 20");
  }
  if (!chatModel || !/\.gguf$/i.test(chatModel) || /mmproj/i.test(chatModel)) {
    throw new Error("Seleziona un modello LLM GGUF valido per la Chat");
  }
  if (!chatProjector || !/mmproj.*\.gguf$/i.test(chatProjector)) {
    throw new Error("Seleziona il projector mmproj GGUF per la Chat vision");
  }
  if (!Number.isInteger(chatNCtx) || chatNCtx < 2_048 || chatNCtx > 262_144) {
    throw new Error("Il contesto Chat deve essere compreso fra 2.048 e 262.144 token");
  }
  if (!Number.isInteger(chatNGpuLayers) || chatNGpuLayers < -1 || chatNGpuLayers > 200) {
    throw new Error("I layer GPU Chat devono essere compresi fra -1 e 200");
  }
  if (!Number.isInteger(chatNThreads) || chatNThreads < 1 || chatNThreads > 128) {
    throw new Error("I thread Chat devono essere compresi fra 1 e 128");
  }
  if (!Number.isInteger(chatMaxNewTokens) || chatMaxNewTokens < 128 || chatMaxNewTokens > 8_192) {
    throw new Error("I token di risposta Chat devono essere compresi fra 128 e 8.192");
  }
  if (!Number.isFinite(chatTemperature) || chatTemperature < 0 || chatTemperature > 2) {
    throw new Error("La temperature Chat deve essere compresa fra 0 e 2");
  }
  if (!Number.isFinite(chatTopP) || chatTopP <= 0 || chatTopP > 1) {
    throw new Error("Top P Chat deve essere maggiore di 0 e non superiore a 1");
  }
  if (!ttsRoot) throw new Error("Indica la cartella di Higgs Audio Studio");
  if (!ttsVoice) throw new Error("Seleziona una voce Higgs predefinita");
  if (!Number.isFinite(ttsTemperature) || ttsTemperature < 0.05 || ttsTemperature > 2) {
    throw new Error("La temperature TTS deve essere compresa fra 0,05 e 2");
  }
  if (!Number.isFinite(ttsTopP) || ttsTopP <= 0 || ttsTopP > 1) {
    throw new Error("Top P TTS deve essere maggiore di 0 e non superiore a 1");
  }
  if (!Number.isInteger(ttsTopK) || ttsTopK < 1 || ttsTopK > 500) {
    throw new Error("Top K TTS deve essere compreso fra 1 e 500");
  }
  if (!Number.isFinite(ttsSpeed) || ttsSpeed < 0.5 || ttsSpeed > 2) {
    throw new Error("La velocità TTS deve essere compresa fra 0,5 e 2");
  }
  if (!Number.isInteger(ttsMaxNewTokens) || ttsMaxNewTokens < 256 || ttsMaxNewTokens > 8_192) {
    throw new Error("I token TTS devono essere compresi fra 256 e 8.192");
  }
  if (!musicModel || !musicEncoder || !musicVae) {
    throw new Error("Configura modello, text encoder e VAE MiniMax Music");
  }
  if (!Number.isFinite(musicCfg) || musicCfg < 0.1 || musicCfg > 10) {
    throw new Error("Il CFG MiniMax Music deve essere compreso fra 0,1 e 10");
  }
  if (!voiceConversionRoot) throw new Error("Indica la cartella runtime audio.cpp");
  if (!separatorModel) throw new Error("Indica il modello di separazione vocale");
  if (!seedVcModel) throw new Error("Indica il modello Seed-VC");
  if (voiceConversion.backend !== "cuda" && voiceConversion.backend !== "cpu") {
    throw new Error("Il backend Voice Conversion deve essere CUDA oppure CPU");
  }
  if (!Number.isInteger(voiceConversionSteps) || voiceConversionSteps < 10 || voiceConversionSteps > 100) {
    throw new Error("Gli step Seed-VC devono essere un intero fra 10 e 100");
  }
  assertPddModelCompatibility(fastModel, pddFile);

  return {
    h3: {
      model: h3Model,
      loras: validateLoras(value.h3.loras, "H3"),
      steps: validateStepCount(value.h3.steps, "H3"),
    },
    fast: {
      model: fastModel,
      pddFile,
      loras: validateLoras(fast.loras, "FAST"),
      steps: 8,
    },
    ltx25: {
      model: ltx25Model,
      encoder: ltx25Encoder,
      videoVae: ltx25VideoVae,
      audioVae: ltx25AudioVae,
      steps: 8,
      cfg: ltx25Cfg,
      sampler: ltx25.sampler === "euler" ? "euler" : "euler_ancestral",
    },
    krea: {
      model: kreaModel,
      encoder,
      vae,
      loras: validateLoras(value.krea.loras, "Krea"),
      steps: validateStepCount(value.krea.steps, "Krea"),
    },
    imageEdit: {
      model: imageEditModel,
      encoder: imageEditEncoder,
      vae: imageEditVae,
      steps: validateStepCount(imageEdit.steps, "Flux.2 Klein Edit"),
      cfg: imageEditCfg,
      kvCacheEnabled: imageEditKvCache,
      attentionBackend: imageEditAttention,
    },
    anima: {
      model: animaModel,
      encoder: animaEncoder,
      vae: animaVae,
      loras: validateLoras(anima.loras, "Anima"),
      steps: validateStepCount(anima.steps, "Anima"),
      cfg: animaCfg,
    },
    chat: {
      model: chatModel,
      projector: chatProjector,
      nCtx: chatNCtx,
      nGpuLayers: chatNGpuLayers,
      nThreads: chatNThreads,
      maxNewTokens: chatMaxNewTokens,
      temperature: chatTemperature,
      topP: chatTopP,
    },
    tts: {
      root: ttsRoot,
      voice: ttsVoice,
      temperature: ttsTemperature,
      topP: ttsTopP,
      topK: ttsTopK,
      speed: ttsSpeed,
      maxNewTokens: ttsMaxNewTokens,
    },
    music: {
      model: musicModel,
      encoder: musicEncoder,
      vae: musicVae,
      steps: validateStepCount(music.steps, "MiniMax Music"),
      cfg: musicCfg,
      tiledDecode: music.tiledDecode !== false,
    },
    voiceConversion: {
      root: voiceConversionRoot,
      separatorModel,
      seedVcModel,
      backend: voiceConversion.backend,
      steps: voiceConversionSteps,
      f0Condition: voiceConversion.f0Condition !== false,
      autoF0Adjust: voiceConversion.autoF0Adjust !== false,
    },
  };
}

export class RuntimeSettingsStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "runtime-settings.json");
  }

  async get(): Promise<RuntimeSettings> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return validateSettings(parsed);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return cloneDefaults();
      }
      if (error instanceof SyntaxError) {
        throw new Error("Il file runtime-settings.json non contiene JSON valido");
      }
      throw error;
    }
  }

  async update(value: unknown) {
    const current = await this.get();
    const settings = isRecord(value)
      ? validateSettings({
          ...value,
          imageEdit: isRecord(value.imageEdit) ? value.imageEdit : current.imageEdit,
          ltx25: isRecord(value.ltx25) ? value.ltx25 : current.ltx25,
          anima: isRecord(value.anima) ? value.anima : current.anima,
          chat: isRecord(value.chat) ? value.chat : current.chat,
          tts: isRecord(value.tts) ? value.tts : current.tts,
          music: isRecord(value.music) ? value.music : current.music,
          voiceConversion: isRecord(value.voiceConversion)
            ? value.voiceConversion
            : current.voiceConversion,
        })
      : validateSettings(value);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
    return settings;
  }
}
