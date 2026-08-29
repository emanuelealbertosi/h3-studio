import type { ComfyApiPrompt, ComfyHistoryEntry } from "../bridge/comfy-client.js";
import { JobRepository } from "../bridge/job-repository.js";
import type { MediaOutput, StudioJobRequest } from "../bridge/studio-job.js";

const comfyUrl = (process.env.H3_COMFY_URL ?? "http://127.0.0.1:9000").replace(
  /\/+$/,
  "",
);
const dataDir = process.env.H3_DATA_DIR ?? "F:\\H3-Studio\\data";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiPrompt(entry: ComfyHistoryEntry): ComfyApiPrompt | null {
  const value = Array.isArray(entry.prompt) ? entry.prompt[2] : null;
  return isRecord(value) ? (value as ComfyApiPrompt) : null;
}

function node(prompt: ComfyApiPrompt, classType: string) {
  return Object.values(prompt).find((candidate) => candidate.class_type === classType);
}

function outputFrom(entry: ComfyHistoryEntry): MediaOutput | null {
  if (!isRecord(entry.outputs)) return null;
  for (const nodeOutput of Object.values(entry.outputs)) {
    if (!isRecord(nodeOutput)) continue;
    for (const items of Object.values(nodeOutput)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!isRecord(item) || typeof item.filename !== "string") continue;
        const format = typeof item.format === "string" ? item.format : "";
        if (!format.startsWith("video/") && !/\.(mp4|webm|mov)$/i.test(item.filename)) {
          continue;
        }
        const type =
          item.type === "input" || item.type === "temp" ? item.type : "output";
        const subfolder = typeof item.subfolder === "string" ? item.subfolder : "";
        const query = new URLSearchParams({ filename: item.filename, subfolder, type });
        return {
          filename: item.filename,
          subfolder,
          type,
          format: format || "video/mp4",
          mediaPath: `/api/media?${query.toString()}`,
        };
      }
    }
  }
  return null;
}

const response = await fetch(`${comfyUrl}/history?max_items=200`);
if (!response.ok) throw new Error(`ComfyUI history HTTP ${response.status}`);
const history = (await response.json()) as Record<string, ComfyHistoryEntry>;
const groups = new Map<
  string,
  Array<{
    promptId: string;
    queueNumber: number | null;
    index: number;
    entry: ComfyHistoryEntry;
    prompt: ComfyApiPrompt;
    prefix: string;
  }>
>();

for (const [promptId, entry] of Object.entries(history)) {
  const prompt = apiPrompt(entry);
  if (!prompt) continue;
  const saver = node(prompt, "H3SaveContinuation");
  const prefix = typeof saver?.inputs.filename_prefix === "string"
    ? saver.inputs.filename_prefix
    : "";
  const match = /^video\/H3_STUDIO\/([^/]+)\/candidate_(\d+)$/.exec(prefix);
  if (!match) continue;
  const jobId = match[1];
  const group = groups.get(jobId) ?? [];
  group.push({
    promptId,
    queueNumber:
      Array.isArray(entry.prompt) && typeof entry.prompt[0] === "number"
        ? entry.prompt[0]
        : null,
    index: Number(match[2]),
    entry,
    prompt,
    prefix,
  });
  groups.set(jobId, group);
}

const repository = new JobRepository(dataDir);
let imported = 0;
let skipped = 0;
try {
  for (const [jobId, candidates] of groups) {
    if (repository.get(jobId)) {
      skipped += 1;
      continue;
    }
    candidates.sort((left, right) => left.index - right.index);
    const first = candidates[0];
    const requestNode = node(first.prompt, "H3AIOAutopromptRequest");
    const sampler = node(first.prompt, "H3ReferenceMemorySampler");
    const size = node(first.prompt, "H3AspectMegapixelSize");
    const model = node(first.prompt, "H3ModelLoaderAny");
    const loras = node(first.prompt, "Power Lora Loader (rgthree)");
    const lora1 = isRecord(loras?.inputs.lora_1) ? loras.inputs.lora_1 : {};
    if (!requestNode || !sampler || !size || !model) continue;

    const request: StudioJobRequest = {
      prompt: String(requestNode.inputs.natural_prompt ?? "Imported Studio job"),
      candidateCount: Math.min(4, Math.max(1, candidates.length)) as 1 | 2 | 3 | 4,
      shotCount: Math.min(12, Math.max(1, Number(requestNode.inputs.shot_count) || 1)),
      durationSeconds:
        Number(requestNode.inputs.shot_seconds) === 15
          ? 15
          : Number(requestNode.inputs.shot_seconds) === 10
            ? 10
            : 5,
      megapixels:
        Number(size.inputs.megapixels) === 1
          ? 0.98
          : [0.5, 0.7, 0.98].includes(Number(size.inputs.megapixels))
            ? (Number(size.inputs.megapixels) as 0.5 | 0.7 | 0.98)
            : 0.5,
      generationMode: "T2V",
      videoEditEngine: "h3",
      aspectFormat: String(size.inputs.aspect_format ?? "16:9 landscape") as StudioJobRequest["aspectFormat"],
      seedMode: "base",
      qualityMode: "fast",
      turboEnabled: Boolean(lora1.on),
      seed: Number(sampler.inputs.seed),
      mediaState: "[]",
      referenceRoles: "AUTO",
      keyframePositions: "AUTO",
      sourceVideoAudio: "AUTO",
      projectId: null,
      sourceJobId: null,
      muteDiegetic: false,
      muteNonDiegetic: false,
    };
    const settings = {
      profile: "standard" as const,
      pddFile: null,
      model: String(model.inputs.model_name),
      lora: String(lora1.lora ?? ""),
      loraStrength: Number(lora1.strength ?? 1),
      loras: String(lora1.lora ?? "")
        ? [{
            name: String(lora1.lora),
            strength: Number(lora1.strength ?? 1),
          }]
        : [],
      steps: Number(sampler.inputs.steps),
    };
    repository.createPrepared(
      {
        jobId,
        request,
        candidates: candidates.map((candidate) => ({
          index: candidate.index,
          seed: Number(node(candidate.prompt, "H3ReferenceMemorySampler")?.inputs.seed),
          filenamePrefix: candidate.prefix,
          prompt: candidate.prompt,
        })),
      },
      settings,
    );

    let failed = false;
    for (const candidate of candidates) {
      repository.markQueued(jobId, candidate.index, candidate.promptId, candidate.queueNumber);
      const statusString = isRecord(candidate.entry.status)
        ? candidate.entry.status.status_str
        : null;
      const output = outputFrom(candidate.entry);
      const status = statusString === "success" && output
        ? "ready"
        : statusString === "error"
          ? "failed"
          : "submitted";
      if (status === "failed") failed = true;
      repository.updateCandidate(jobId, candidate.index, status, output);
    }
    repository.updateJobStatus(jobId, failed ? "partial" : "completed");
    imported += 1;
  }
} finally {
  repository.close();
}

console.log(JSON.stringify({ imported, skipped, discovered: groups.size }));
