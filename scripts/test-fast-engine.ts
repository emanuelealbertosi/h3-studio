import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ComfyApiPrompt } from "../bridge/comfy-client.js";
import {
  compatiblePddFilesForModel,
  FAST_PDD_PAIRS,
  preferredPddFileForModel,
} from "../bridge/pdd-compatibility.js";
import { DEFAULT_RUNTIME_SETTINGS } from "../bridge/runtime-settings.js";
import { prepareStudioJob, publicDryRun } from "../bridge/studio-job.js";

function uniqueNode(prompt: ComfyApiPrompt, classType: string) {
  const nodes = Object.values(prompt).filter((node) => node.class_type === classType);
  assert.equal(nodes.length, 1, `Atteso un solo nodo ${classType}`);
  return nodes[0];
}

const source = JSON.parse(
  await readFile(path.resolve("workflows", "studio-backend.api.json"), "utf8"),
) as ComfyApiPrompt;
const dependencyManifest = JSON.parse(
  await readFile(path.resolve("workflows", "dependencies.json"), "utf8"),
) as { items: Array<{ id: string; filenames?: string[] }> };
const ref2vaPair = FAST_PDD_PAIRS[0];
const fl2vaPair = FAST_PDD_PAIRS[1];

assert.equal(ref2vaPair.family, "ref2va");
assert.equal(fl2vaPair.family, "fl2va");
assert.equal(
  preferredPddFileForModel(ref2vaPair.model, [
    fl2vaPair.pddFile,
    ref2vaPair.pddFile,
  ]),
  ref2vaPair.pddFile,
);
assert.equal(
  preferredPddFileForModel(fl2vaPair.model, [
    ref2vaPair.pddFile,
    fl2vaPair.pddFile,
  ]),
  fl2vaPair.pddFile,
);
assert.deepEqual(
  compatiblePddFilesForModel(ref2vaPair.model, [
    fl2vaPair.pddFile,
    ref2vaPair.pddFile,
  ]),
  [ref2vaPair.pddFile],
);

const fastBaseModels = dependencyManifest.items.find(
  (item) => item.id === "h3-fast-base-model",
);
assert.ok(fastBaseModels, "Dipendenza modelli base FAST mancante");
assert.deepEqual(fastBaseModels.filenames, [
  "minimax_h3_ref2va_int8_convrot.safetensors",
  "minimax_h3_fl2va_int8_convrot.safetensors",
]);

const baseRequest = {
  prompt: "A sunlit cinematic tracking shot of an adult explorer walking through a palace courtyard.",
  candidateCount: 1,
  durationSeconds: 5,
  megapixels: 0.5,
  generationMode: "T2V",
  aspectFormat: "16:9 landscape",
  seedMode: "fixed",
  seed: 12345,
};

const originalRandom = Math.random;
try {
  const collisionSeed = Math.floor(0.5 * 9_007_199_254_740_000);
  const randomValues = [0.1, 0.5, 0.6];
  Math.random = () => randomValues.shift() ?? 0.7;
  const regenerated = prepareStudioJob(
    source,
    {
      ...baseRequest,
      seedMode: "random",
      seed: undefined,
      qualityMode: "min",
      turboEnabled: false,
    },
    structuredClone(DEFAULT_RUNTIME_SETTINGS),
    "00000000-0000-4000-8000-000000000099",
    new Set([collisionSeed]),
  );
  assert.notEqual(regenerated.candidates[0].seed, collisionSeed);
  assert.equal(
    regenerated.candidates[0].seed,
    Math.floor(0.6 * 9_007_199_254_740_000),
  );
} finally {
  Math.random = originalRandom;
}

const fast = prepareStudioJob(
  source,
  { ...baseRequest, qualityMode: "fast", turboEnabled: true },
  structuredClone(DEFAULT_RUNTIME_SETTINGS),
  "00000000-0000-4000-8000-000000000001",
);
const fastSampler = uniqueNode(fast.candidates[0].prompt, "H3ReferenceMemorySampler");
const fastShift = uniqueNode(fast.candidates[0].prompt, "MiniMaxH3SigmaShift");
assert.equal(fast.engineSettings.profile, "fast");
assert.equal(fast.engineSettings.steps, 8);
assert.equal(
  fast.engineSettings.model,
  "minimax_h3_ref2va_int8_convrot.safetensors",
);
assert.equal(fastSampler.inputs.steps, 8);
assert.equal(fastSampler.inputs.sampler_name, "euler");
assert.equal(fastSampler.inputs.scheduler, "simple");
assert.equal(
  fastSampler.inputs.pdd_acc_file,
  "MiniMax-H3-Ref2VA-Acc-8Step.safetensors",
);
assert.equal(fastShift.inputs.shift_video, 12);
assert.equal(fastShift.inputs.shift_audio, 3);
assert.equal(
  fastSampler.inputs.studio_context_prefix,
  "video/H3_STUDIO_CONTEXT/00000000-0000-4000-8000-000000000001/latent",
);
assert.equal(fastSampler.inputs.studio_context_clip_index, 1);
assert.equal(publicDryRun(fast).fastPdd, true);

const fl2vaSettings = structuredClone(DEFAULT_RUNTIME_SETTINGS);
fl2vaSettings.fast.model = fl2vaPair.model;
fl2vaSettings.fast.pddFile = fl2vaPair.pddFile;
const fl2vaFast = prepareStudioJob(
  source,
  { ...baseRequest, qualityMode: "fast", turboEnabled: true },
  fl2vaSettings,
  "00000000-0000-4000-8000-000000000005",
);
const fl2vaSampler = uniqueNode(
  fl2vaFast.candidates[0].prompt,
  "H3ReferenceMemorySampler",
);
assert.equal(fl2vaFast.engineSettings.profile, "fast");
assert.equal(fl2vaFast.engineSettings.model, fl2vaPair.model);
assert.equal(fl2vaFast.engineSettings.pddFile, fl2vaPair.pddFile);
assert.equal(fl2vaSampler.inputs.pdd_acc_file, fl2vaPair.pddFile);

const standard8 = prepareStudioJob(
  source,
  { ...baseRequest, qualityMode: "fast", turboEnabled: false },
  structuredClone(DEFAULT_RUNTIME_SETTINGS),
  "00000000-0000-4000-8000-000000000002",
);
const standardSampler = uniqueNode(
  standard8.candidates[0].prompt,
  "H3ReferenceMemorySampler",
);
assert.equal(standard8.engineSettings.profile, "standard");
assert.equal(standard8.engineSettings.steps, 8);
assert.equal(standard8.engineSettings.pddFile, null);
assert.equal(standardSampler.inputs.steps, 8);
assert.notEqual(standardSampler.inputs.pdd_acc_file, fast.engineSettings.pddFile);

const keepAspectI2v = prepareStudioJob(
  source,
  {
    ...baseRequest,
    generationMode: "I2V",
    aspectFormat: "keep source aspect",
    mediaState: JSON.stringify([{ kind: "picture", file: "source.png [input]" }]),
    qualityMode: "fast",
    turboEnabled: false,
  },
  structuredClone(DEFAULT_RUNTIME_SETTINGS),
  "00000000-0000-4000-8000-000000000007",
);
const keepAspectSize = uniqueNode(
  keepAspectI2v.candidates[0].prompt,
  "H3AspectMegapixelSize",
);
assert.equal(keepAspectSize.inputs.size_mode, "source aspect + megapixels");
assert.equal(keepAspectSize.inputs.aspect_format, "16:9 landscape");
const keepAspectKeyframes = prepareStudioJob(
  source,
  {
    ...baseRequest,
    generationMode: "KEYFRAMES",
    aspectFormat: "keep source aspect",
    mediaState: JSON.stringify([{ kind: "picture", file: "keyframe.png [input]" }]),
    qualityMode: "fast",
    turboEnabled: false,
  },
  structuredClone(DEFAULT_RUNTIME_SETTINGS),
  "00000000-0000-4000-8000-000000000017",
);
const keepAspectKeyframeSize = uniqueNode(
  keepAspectKeyframes.candidates[0].prompt,
  "H3AspectMegapixelSize",
);
assert.equal(keepAspectKeyframeSize.inputs.size_mode, "source aspect + megapixels");
assert.deepEqual(keepAspectKeyframeSize.inputs.picture_1, ["61", 0]);

for (const [generationMode, jobId] of [
  ["VIDEO EXTENSION", "00000000-0000-4000-8000-000000000018"],
  ["VIDEO EDITING", "00000000-0000-4000-8000-000000000019"],
] as const) {
  const keepAspectVideo = prepareStudioJob(
    source,
    {
      ...baseRequest,
      generationMode,
      aspectFormat: "keep source aspect",
      mediaState: JSON.stringify([{ kind: "video", file: "source.mp4 [input]" }]),
      qualityMode: "fast",
      turboEnabled: false,
    },
    structuredClone(DEFAULT_RUNTIME_SETTINGS),
    jobId,
  );
  const keepAspectVideoSize = uniqueNode(
    keepAspectVideo.candidates[0].prompt,
    "H3AspectMegapixelSize",
  );
  assert.equal(keepAspectVideoSize.inputs.size_mode, "source aspect + megapixels");
  assert.equal(keepAspectVideoSize.inputs.picture_1, undefined);
  assert.deepEqual(keepAspectVideoSize.inputs.fallback_image, ["66", 7]);
}

assert.throws(
  () => prepareStudioJob(
    source,
    {
      ...baseRequest,
      aspectFormat: "keep source aspect",
      qualityMode: "fast",
      turboEnabled: false,
    },
    structuredClone(DEFAULT_RUNTIME_SETTINGS),
  ),
  /richiede una modalità con Picture o Video/i,
);
assert.throws(
  () => prepareStudioJob(
    source,
    {
      ...baseRequest,
      generationMode: "R2V",
      aspectFormat: "keep source aspect",
      mediaState: JSON.stringify([{ kind: "audio", file: "voice.wav [input]" }]),
      qualityMode: "fast",
      turboEnabled: false,
    },
    structuredClone(DEFAULT_RUNTIME_SETTINGS),
  ),
  /richiede almeno una Picture o un Video/i,
);

const fifteenSeconds = prepareStudioJob(
  source,
  {
    ...baseRequest,
    durationSeconds: 15,
    megapixels: 0.7,
    qualityMode: "fast",
    turboEnabled: false,
  },
  structuredClone(DEFAULT_RUNTIME_SETTINGS),
  "00000000-0000-4000-8000-000000000008",
);
const fifteenRequest = uniqueNode(
  fifteenSeconds.candidates[0].prompt,
  "H3AIOAutopromptRequest",
);
assert.equal(fifteenRequest.inputs.shot_seconds, 15);
assert.throws(
  () => prepareStudioJob(
    source,
    {
      ...baseRequest,
      durationSeconds: 15,
      megapixels: 0.98,
      qualityMode: "fast",
      turboEnabled: false,
    },
    structuredClone(DEFAULT_RUNTIME_SETTINGS),
  ),
  /massima supportata è 0\.7 MP/i,
);

const continuation = prepareStudioJob(
  source,
  {
    ...baseRequest,
    durationSeconds: 15,
    megapixels: 0.7,
    generationMode: "VIDEO EXTENSION",
    mediaState: JSON.stringify([
      {
        kind: "video",
        file: "video/H3_STUDIO/11111111-1111-4111-8111-111111111111/candidate_2_00001_.mp4 [output]",
        duration: 15.1,
      },
      { kind: "picture", file: "reference.png [input]" },
    ]),
    sourceJobId: "11111111-1111-4111-8111-111111111111",
    qualityMode: "fast",
    turboEnabled: false,
  },
  structuredClone(DEFAULT_RUNTIME_SETTINGS),
  "00000000-0000-4000-8000-000000000009",
);
const continuationSampler = uniqueNode(
  continuation.candidates[0].prompt,
  "H3ReferenceMemorySampler",
);
const continuationRequest = uniqueNode(
  continuation.candidates[0].prompt,
  "H3AIOAutopromptRequest",
);
assert.equal(continuationSampler.inputs.memory_frames, 1);
assert.equal(continuationSampler.inputs.anchor_frames, 0);
assert.equal(
  continuationSampler.inputs.studio_source_context_prefix,
  "video/H3_STUDIO_CONTEXT/11111111-1111-4111-8111-111111111111/latent",
);
assert.equal(continuationSampler.inputs.studio_source_context_clip_index, 2);
assert.match(String(continuationRequest.inputs.natural_prompt), /SEAMLESS START/);
assert.match(String(continuationRequest.inputs.natural_prompt), /no cut/i);

const mismatch = structuredClone(DEFAULT_RUNTIME_SETTINGS);
mismatch.fast.pddFile = fl2vaPair.pddFile;
assert.throws(
  () => prepareStudioJob(
    source,
    { ...baseRequest, qualityMode: "fast", turboEnabled: true },
    mismatch,
    "00000000-0000-4000-8000-000000000003",
  ),
  /coppia FAST non valida/i,
);

const pruned = structuredClone(DEFAULT_RUNTIME_SETTINGS);
pruned.fast.model = "minimaxH3INT8INT4_ref2vaINT8Pruned.safetensors";
assert.throws(
  () => prepareStudioJob(
    source,
    { ...baseRequest, qualityMode: "fast", turboEnabled: true },
    pruned,
    "00000000-0000-4000-8000-000000000004",
  ),
  /AdaLN pruned\/8-wide/i,
);

const unofficial = structuredClone(DEFAULT_RUNTIME_SETTINGS);
unofficial.fast.model = "custom_minimax_h3_ref2va_int8_convrot.safetensors";
assert.throws(
  () => prepareStudioJob(
    source,
    { ...baseRequest, qualityMode: "fast", turboEnabled: true },
    unofficial,
    "00000000-0000-4000-8000-000000000006",
  ),
  /modello FAST non supportato/i,
);

console.log("FAST Ref2VA/FL2VA PDD + standard 8 presets: OK (no GPU queue)");
