import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobRepository } from "../bridge/job-repository.js";
import {
  prepareBerniniStudioJob,
  publicDryRun,
} from "../bridge/studio-job.js";
import { resolveChatVideoEditEngine } from "../bridge/chat-service.js";

assert.equal(resolveChatVideoEditEngine("modifica questo video con Bernini", "VIDEO EDITING"), "bernini");
assert.equal(resolveChatVideoEditEngine("fai un edit fedele del colore", "VIDEO EDITING"), "bernini");
assert.equal(resolveChatVideoEditEngine("modifica il vestito nel video", "VIDEO EDITING"), "h3");
assert.equal(resolveChatVideoEditEngine("crea un video con Bernini", "T2V"), "h3");

const temporary = mkdtempSync(path.join(os.tmpdir(), "h3-bernini-test-"));

const prepared = prepareBerniniStudioJob({
  prompt: "Replace only the red shirt with a blue shirt.",
  candidateCount: 1,
  shotCount: 1,
  durationSeconds: 5,
  megapixels: 0.5,
  generationMode: "VIDEO EDITING",
  videoEditEngine: "bernini",
  aspectFormat: "keep source aspect",
  seedMode: "fixed",
  qualityMode: "med",
  turboEnabled: false,
  seed: 42,
  mediaState: JSON.stringify([
    {
      kind: "video",
      file: "tests/source.mp4 [input]",
      duration: 5,
      width: 1920,
      height: 1080,
    },
    { kind: "picture", file: "tests/shirt.png [input]" },
  ]),
  referenceRoles: "Picture 1 = replacement shirt",
  keyframePositions: "AUTO",
  sourceVideoAudio: "REUSE",
  projectId: null,
  sourceJobId: null,
  muteDiegetic: false,
  muteNonDiegetic: false,
});

assert.equal(prepared.request.videoEditEngine, "bernini");
assert.equal(prepared.engineSettings.model, "wan2.1_bernini_1.3B_fp16.safetensors");
assert.equal(prepared.engineSettings.steps, 20);
assert.equal(prepared.candidates[0].prompt["7"].class_type, "BerniniConditioning");
assert.deepEqual(prepared.candidates[0].prompt["7"].inputs.source_video, ["1", 0]);
assert.deepEqual(
  prepared.candidates[0].prompt["7"].inputs["reference_images.reference_image_0"],
  ["13", 0],
);
assert.deepEqual(prepared.candidates[0].prompt["12"].inputs.audio, ["1", 2]);
assert.equal(publicDryRun(prepared).continuationOnly, true);

const outputPrepared = prepareBerniniStudioJob({
  ...prepared.request,
  mediaState: JSON.stringify([
    {
      kind: "video",
      file: "video/H3_STUDIO/source.mp4 [output]",
      duration: 5,
      width: 832,
      height: 480,
    },
    { kind: "picture", file: "images/reference.png [output]" },
  ]),
}, undefined, undefined, path.join(temporary, "ComfyUI", "output"));
assert.equal(outputPrepared.candidates[0].prompt["1"].class_type, "VHS_LoadVideoPath");
assert.equal(outputPrepared.candidates[0].prompt["13"].class_type, "LoadImageOutput");

const longPrepared = prepareBerniniStudioJob({
  ...prepared.request,
  durationSeconds: 15,
  mediaState: JSON.stringify([{
    kind: "video",
    file: "tests/source-20s.mp4 [input]",
    duration: 19.9,
    width: 1920,
    height: 1080,
  }]),
});
assert.equal(longPrepared.candidates[0].prompt["7"].inputs.length, 477);
assert.throws(() => prepareBerniniStudioJob({
  ...prepared.request,
  durationSeconds: 15,
  mediaState: JSON.stringify([{
    kind: "video",
    file: "tests/source-too-long.mp4 [input]",
    duration: 20.6,
    width: 1920,
    height: 1080,
  }]),
}), /fino a 20 secondi/);

try {
  const repository = new JobRepository(temporary);
  try {
    repository.createPrepared(prepared, prepared.engineSettings);
    const saved = repository.get(prepared.jobId);
    assert.equal(saved?.request.videoEditEngine, "bernini");
    assert.equal(saved?.engine.model, "wan2.1_bernini_1.3B_fp16.safetensors");
  } finally {
    repository.close();
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log("Bernini Preview 1.3B engine: OK (no GPU queue)");
