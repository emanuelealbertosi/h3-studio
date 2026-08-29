import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const WORKFLOW_CATALOG = [
  {
    id: "h3-aio-ultra",
    role: "video" as const,
    name: "MiniMax H3 AIO Autoprompter Ultra",
    description: "Workflow H3 principale per T2V, I2V, Reference, Keyframes, Continue ed Edit.",
    file: "studio-backend.ui.json",
  },
  {
    id: "h3-fast-alibaba-pdd",
    role: "fast" as const,
    name: "MiniMax H3 FAST Alibaba PDD-Acc",
    description: "Derivato API a 8 NFE con Euler, sigmas PDD e shift 12/3.",
    file: "studio-fast-pdd.api.json",
  },
  {
    id: "krea2-character-sheet",
    role: "image" as const,
    name: "Krea 2 Character/Object Sheet",
    description: "Grafo Krea 2 generato dal bridge per reference sheet coerenti.",
    file: "studio-krea2.api.json",
  },
  {
    id: "flux2-klein-edit-core",
    role: "image_edit" as const,
    name: "Flux.2 Klein 4B Distilled Image Edit",
    description: "Grafo core ufficiale per edit con una o più reference, espanso dal bridge fino a quattro input.",
    file: "studio-flux2-klein-edit.api.json",
  },
  {
    id: "anima-t2i-core",
    role: "image_anima" as const,
    name: "Anima Turbo Image Generation",
    description: "Workflow Anima core con modello, encoder, VAE e fino a tre LoRA configurabili.",
    file: "studio-anima.api.json",
  },
  {
    id: "minimax-h3-image-aio",
    role: "image_minimax" as const,
    name: "Image H3 AIO T2I / I2I / Reference",
    description: "Workflow H3 single-frame con T2I, I2I e reference edit fino a nove immagini.",
    file: "studio-minimax-h3-image.api.json",
  },
] as const;

export type InstallSettings = {
  comfyUrl: string;
  comfyOutputDir: string;
  videoWorkflowId: string;
  fastWorkflowId: string;
  imageWorkflowId: string;
  imageEditWorkflowId: string;
  imageAnimaWorkflowId: string;
  imageMinimaxWorkflowId: string;
  ffmpegPath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUrl(value: unknown) {
  const text = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  const parsed = new URL(text);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("L'URL ComfyUI deve usare http o https");
  }
  return parsed.toString().replace(/\/$/, "");
}

export class InstallSettingsStore {
  private readonly filePath: string;

  constructor(
    dataDir: string,
    private readonly defaults: InstallSettings,
  ) {
    this.filePath = path.join(dataDir, "install-settings.json");
  }

  async get() {
    try {
      return this.validate(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { ...this.defaults };
      }
      throw error;
    }
  }

  async update(value: unknown) {
    const settings = this.validate(value);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
    return settings;
  }

  private validate(value: unknown): InstallSettings {
    if (!isRecord(value)) throw new Error("Configurazione installazione mancante");
    const comfyOutputDir = typeof value.comfyOutputDir === "string"
      ? value.comfyOutputDir.trim()
      : "";
    if (!comfyOutputDir) throw new Error("Indica la cartella output della ComfyUI collegata");
    const ffmpegPath = typeof value.ffmpegPath === "string" && value.ffmpegPath.trim()
      ? value.ffmpegPath.trim()
      : "ffmpeg";
    const selected = {
      videoWorkflowId: String(value.videoWorkflowId ?? this.defaults.videoWorkflowId),
      fastWorkflowId: String(value.fastWorkflowId ?? this.defaults.fastWorkflowId),
      imageWorkflowId: String(value.imageWorkflowId ?? this.defaults.imageWorkflowId),
      imageEditWorkflowId: String(
        value.imageEditWorkflowId ?? this.defaults.imageEditWorkflowId,
      ),
      imageAnimaWorkflowId: String(
        value.imageAnimaWorkflowId ?? this.defaults.imageAnimaWorkflowId,
      ),
      imageMinimaxWorkflowId: String(
        value.imageMinimaxWorkflowId ?? this.defaults.imageMinimaxWorkflowId,
      ),
    };
    for (const [key, role] of [
      ["videoWorkflowId", "video"],
      ["fastWorkflowId", "fast"],
      ["imageWorkflowId", "image"],
      ["imageEditWorkflowId", "image_edit"],
      ["imageAnimaWorkflowId", "image_anima"],
      ["imageMinimaxWorkflowId", "image_minimax"],
    ] as const) {
      if (!WORKFLOW_CATALOG.some((item) => item.id === selected[key] && item.role === role)) {
        throw new Error(`Workflow ${role} non valido`);
      }
    }
    return {
      comfyUrl: normalizeUrl(value.comfyUrl),
      comfyOutputDir,
      ...selected,
      ffmpegPath,
    };
  }
}

export function workflowPath(workflowDir: string, id: string) {
  const item = WORKFLOW_CATALOG.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Workflow sconosciuto: ${id}`);
  return path.join(workflowDir, item.file);
}
