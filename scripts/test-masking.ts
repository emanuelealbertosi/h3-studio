import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ComfyApiNode, ComfyApiPrompt } from "../bridge/comfy-client.js";
import { DEFAULT_RUNTIME_SETTINGS } from "../bridge/runtime-settings.js";
import { prepareStudioJob } from "../bridge/studio-job.js";

const source = JSON.parse(
  readFileSync(path.resolve("workflows", "studio-backend.api.json"), "utf8"),
) as ComfyApiPrompt;
const mediaState = JSON.stringify([{
  kind: "video",
  file: "h3_studio/masking-source.mp4 [input]",
  width: 1280,
  height: 720,
  duration: 10,
  hasAudio: false,
}]);
const request = {
  videoEngine: "h3",
  prompt: "Change only the woman's dress to blue.",
  candidateCount: 1,
  shotCount: 1,
  durationSeconds: 10,
  megapixels: 0.5,
  generationMode: "VIDEO EDITING",
  aspectFormat: "keep source aspect",
  seedMode: "fixed",
  seed: 12345,
  qualityMode: "fast",
  turboEnabled: false,
  mediaState,
  referenceRoles: "AUTO",
  keyframePositions: "AUTO",
  sourceVideoAudio: "AUTO",
  projectId: null,
  sourceJobId: null,
  muteDiegetic: false,
  muteNonDiegetic: false,
  inpaintTarget: "vestito della donna",
  inpaintMaskGrow: 8,
  inpaintStartSeconds: 2,
  inpaintEndSeconds: 7,
};

function entry(prompt: ComfyApiPrompt, classType: string): [string, ComfyApiNode] {
  const match = Object.entries(prompt).find(([, node]) => node.class_type === classType);
  assert.ok(match, `${classType} missing`);
  return match;
}

const prepared = prepareStudioJob(
  source,
  request,
  DEFAULT_RUNTIME_SETTINGS,
  "masking-contract",
);
const prompt = prepared.candidates[0].prompt;
const [routerId] = entry(prompt, "H3AIOGenerationRouter");
const [loaderId] = entry(prompt, "LoadSAM3Model");
const [segmentId, segment] = entry(prompt, "SAM3VideoSegmentation");
const [propagateId, propagate] = entry(prompt, "SAM3Propagate");
const [outputId, output] = entry(prompt, "SAM3VideoOutput");
const [, sampler] = entry(prompt, "H3ReferenceMemorySampler");
const [, planner] = entry(prompt, "H3AIOAutopromptRequest");

assert.deepEqual(segment.inputs.video_frames, [routerId, 7]);
assert.equal(segment.inputs.text_prompt, "the dress worn by the woman");
assert.equal(segment.inputs.score_threshold, 0.2);
assert.deepEqual(propagate.inputs.sam3_model_config, [loaderId, 0]);
assert.deepEqual(propagate.inputs.video_state, [segmentId, 0]);
assert.deepEqual(output.inputs.masks, [propagateId, 0]);
assert.deepEqual(sampler.inputs.studio_inpaint_mask, [outputId, 0]);
assert.equal(sampler.inputs.studio_inpaint_grow, 8);
assert.equal(sampler.inputs.studio_inpaint_start_seconds, 2);
assert.equal(sampler.inputs.studio_inpaint_end_seconds, 7);
assert.equal(sampler.inputs.studio_inpaint_crop_mode, "tracked");
assert.equal(sampler.inputs.studio_inpaint_crop_scale, 1.5);
assert.equal(sampler.inputs.studio_inpaint_feather, 24);
assert.match(String(planner.inputs.natural_prompt), /modify only the tracked region/i);
assert.match(String(planner.inputs.natural_prompt), /outside that subject region/i);
assert.match(String(planner.inputs.natural_prompt), /complete and exclusive edit specification/i);
assert.equal(prepared.request.generationMode, "VIDEO EDITING");

assert.throws(
  () => prepareStudioJob(source, { ...request, generationMode: "R2V" }, DEFAULT_RUNTIME_SETTINGS),
  /masking è disponibile soltanto in Video editing H3/i,
);
assert.throws(
  () => prepareStudioJob(source, { ...request, inpaintEndSeconds: 1 }, DEFAULT_RUNTIME_SETTINGS),
  /fine dell'intervallo masking deve essere successiva/i,
);

console.log("Masking H3 workflow contract passed");
