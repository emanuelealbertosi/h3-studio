import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobRepository } from "../bridge/job-repository.js";
import { DEFAULT_RUNTIME_SETTINGS, RuntimeSettingsStore } from "../bridge/runtime-settings.js";
import { prepareStudioJob } from "../bridge/studio-job.js";

const request = {
  videoEngine: "ltx25",
  prompt: "A bright cinematic runner crosses a sunlit plaza.",
  candidateCount: 1,
  shotCount: 1,
  durationSeconds: 10,
  megapixels: 0.5,
  generationMode: "T2V",
  aspectFormat: "16:9 landscape",
  seedMode: "fixed",
  seed: 12345,
  qualityMode: "fast",
  turboEnabled: false,
  mediaState: "[]",
  referenceRoles: "AUTO",
  keyframePositions: "AUTO",
  sourceVideoAudio: "AUTO",
  projectId: null,
  sourceJobId: null,
  muteDiegetic: false,
  muteNonDiegetic: false,
  inpaintTarget: "",
  inpaintMaskGrow: 8,
  inpaintStartSeconds: 0,
  inpaintEndSeconds: 0,
};

const temp = mkdtempSync(path.join(os.tmpdir(), "h3-ltx25-test-"));
try {
  const prepared = prepareStudioJob({}, request, DEFAULT_RUNTIME_SETTINGS, "ltx25-test");
  assert.equal(prepared.request.videoEngine, "ltx25");
  assert.equal(prepared.engineSettings.family, "ltx25");
  assert.equal(prepared.engineSettings.model, DEFAULT_RUNTIME_SETTINGS.ltx25.model);
  assert.equal(prepared.candidates[0].seed, 12345);
  const prompt = prepared.candidates[0].prompt;
  assert.equal(prompt["1"].class_type, "UNETLoader");
  assert.equal(prompt["2"].inputs.type, "ltxv");
  assert.equal(prompt["8"].inputs.length, 241);
  assert.equal(prompt["16"].inputs.sampler_name, "euler_ancestral");
  assert.equal(prompt["23"].class_type, "SaveVideo");
  assert.ok(!Object.values(prompt).some((node) => node.class_type.startsWith("H3")));

  const i2v = prepareStudioJob({}, {
    ...request,
    generationMode: "I2V",
    aspectFormat: "keep source aspect",
    mediaState: JSON.stringify([{
      kind: "picture",
      file: "h3_studio/reference.png [input]",
      width: 900,
      height: 1600,
    }]),
  }, DEFAULT_RUNTIME_SETTINGS, "ltx25-i2v");
  assert.equal(i2v.candidates[0].prompt["11"].class_type, "LoadImage");
  assert.deepEqual(i2v.candidates[0].prompt["18"].inputs.latent_image, ["13", 0]);
  assert.ok(Number(i2v.candidates[0].prompt["8"].inputs.height) > Number(i2v.candidates[0].prompt["8"].inputs.width));
  assert.throws(
    () => prepareStudioJob({}, {
      ...request,
      generationMode: "R2V",
      mediaState: JSON.stringify([{ kind: "picture", file: "h3_studio/reference.png [input]" }]),
    }, DEFAULT_RUNTIME_SETTINGS, "bad"),
    /supporta per ora Text to video e Image to video/,
  );

  const store = new RuntimeSettingsStore(temp);
  const updated = await store.update({
    ...DEFAULT_RUNTIME_SETTINGS,
    ltx25: { ...DEFAULT_RUNTIME_SETTINGS.ltx25, cfg: 1.2, sampler: "euler" },
  });
  assert.equal(updated.ltx25.cfg, 1.2);
  assert.equal((await store.get()).ltx25.sampler, "euler");

  const jobs = new JobRepository(temp);
  jobs.createPrepared(prepared, prepared.engineSettings);
  const persisted = jobs.get("ltx25-test");
  assert.equal(persisted?.request.videoEngine, "ltx25");
  assert.equal(persisted?.engine.family, "ltx25");
  jobs.close();
  console.log("LTX 2.5 workflow tests passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
