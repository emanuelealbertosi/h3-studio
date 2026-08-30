export type Ltx25AssetRole = "model" | "encoder" | "videoVae" | "audioVae";

export type Ltx25AssetSelection = Record<Ltx25AssetRole, string>;

const ROLE_LABELS: Record<Ltx25AssetRole, string> = {
  model: "Modello LTX 2.5",
  encoder: "Text encoder LTX 2.5",
  videoVae: "Video VAE LTX 2.5",
  audioVae: "Audio VAE LTX 2.5",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function baseName(name: string) {
  const normalized = name.trim().replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function isLtx25Name(filename: string) {
  return /ltx.*2[._-]?5|redgraft/i.test(filename);
}

export function ltx25AssetCompatibility(role: Ltx25AssetRole, name: string) {
  const filename = baseName(name);
  const safetensors = filename.endsWith(".safetensors");
  const ltx25 = isLtx25Name(filename);
  const isVae = /vae/i.test(filename);
  const isAudio = /audio/i.test(filename);
  const isVideo = /video/i.test(filename);
  const isEncoder = /gemma|encoder|text|proj/i.test(filename);

  const compatible = role === "model"
    ? safetensors && ltx25 && !isVae && !isEncoder
    : role === "encoder"
      ? safetensors && ltx25 && isEncoder && !isVae
      : role === "videoVae"
        ? safetensors && ltx25 && isVae && isVideo && !isAudio
        : safetensors && ltx25 && isVae && isAudio && !isVideo;

  if (compatible) return { compatible: true } as const;
  return {
    compatible: false,
    reason: `${ROLE_LABELS[role]} incompatibile: seleziona il file LTX 2.5 ${
      role === "model"
        ? "checkpoint/RedGraft"
        : role === "encoder"
          ? "Gemma con proiezione LTX"
          : role === "videoVae"
            ? "Video VAE"
            : "Audio VAE"
    } in formato safetensors.`,
  } as const;
}

export function parseLtx25AssetSelection(value: unknown): Ltx25AssetSelection {
  if (!isRecord(value)) throw new Error("Configurazione LTX 2.5 mancante");
  const selection = {
    model: typeof value.model === "string" ? value.model.trim() : "",
    encoder: typeof value.encoder === "string" ? value.encoder.trim() : "",
    videoVae: typeof value.videoVae === "string" ? value.videoVae.trim() : "",
    audioVae: typeof value.audioVae === "string" ? value.audioVae.trim() : "",
  };
  const missing = (Object.keys(selection) as Ltx25AssetRole[])
    .find((role) => !selection[role]);
  if (missing) throw new Error(`${ROLE_LABELS[missing]} mancante`);
  return selection;
}

export function assertLtx25AssetCompatibility(value: unknown) {
  const selection = parseLtx25AssetSelection(value);
  for (const role of Object.keys(selection) as Ltx25AssetRole[]) {
    const result = ltx25AssetCompatibility(role, selection[role]);
    if (!result.compatible) throw new Error(result.reason);
  }
  return selection;
}
