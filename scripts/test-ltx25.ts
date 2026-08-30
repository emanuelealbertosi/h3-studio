import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ComfyApiPrompt } from "../bridge/comfy-client.js";
import { assertLtx25AssetCompatibility } from "../bridge/ltx25-compatibility.js";
import { JobRepository } from "../bridge/job-repository.js";
import { DEFAULT_RUNTIME_SETTINGS, RuntimeSettingsStore } from "../bridge/runtime-settings.js";
import { prepareStudioJob, StudioJobService } from "../bridge/studio-job.js";
import { JOB_DATABASE_MIGRATIONS } from "../db/schema.js";
import { compatibleEngineOptions } from "../app/engine-options.js";

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
  assert.equal(prompt["16"].inputs.sampler_name, "euler");
  assert.equal(prompt["20"].inputs.temporal_size, 128);
  assert.equal(prompt["20"].inputs.temporal_overlap, 32);
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
  assert.deepEqual(i2v.candidates[0].prompt["13"].inputs.latent, ["8", 0]);
  assert.deepEqual(i2v.candidates[0].prompt["10"].inputs.video_latent, ["13", 0]);
  assert.deepEqual(i2v.candidates[0].prompt["18"].inputs.latent_image, ["10", 0]);
  assert.ok(Number(i2v.candidates[0].prompt["8"].inputs.height) > Number(i2v.candidates[0].prompt["8"].inputs.width));
  assert.throws(
    () => prepareStudioJob({}, {
      ...request,
      generationMode: "I2V",
      aspectFormat: "keep source aspect",
      mediaState: JSON.stringify([{
        kind: "picture",
        file: "h3_studio/extreme.png [input]",
        width: 10_000,
        height: 100,
      }]),
    }, DEFAULT_RUNTIME_SETTINGS, "ltx25-extreme-aspect"),
    /non supporta il rapporto estremo/,
  );
  const fifteenSeconds = prepareStudioJob({}, {
    ...request,
    durationSeconds: 15,
    megapixels: 0.7,
  }, DEFAULT_RUNTIME_SETTINGS, "ltx25-15s");
  assert.equal(fifteenSeconds.candidates[0].prompt["8"].inputs.length, 361);
  assert.throws(
    () => prepareStudioJob({}, {
      ...request,
      durationSeconds: 15,
      megapixels: 0.98,
    }, DEFAULT_RUNTIME_SETTINGS, "ltx25-15s-too-large"),
    /risoluzione massima supportata/,
  );

  const dependencyManifest = JSON.parse(
    readFileSync(path.resolve("workflows", "dependencies.json"), "utf8"),
  ) as { items: Array<{ id: string; requiredClasses?: string[] }> };
  const ltxDependency = dependencyManifest.items.find((item) => item.id === "ltx-video-nodes");
  assert.ok(ltxDependency, "Manifest dependency ltx-video-nodes missing");
  const declaredClasses = new Set(ltxDependency.requiredClasses ?? []);
  const workflowClasses = new Set([
    ...Object.values(prompt),
    ...Object.values(i2v.candidates[0].prompt),
  ].map((node) => node.class_type));
  assert.deepEqual(
    [...workflowClasses].filter((classType) => !declaredClasses.has(classType)),
    [],
    "The LTX readiness manifest must cover every T2V/I2V workflow class",
  );

  assert.deepEqual(
    compatibleEngineOptions(
      ["minimax_h3.safetensors"],
      DEFAULT_RUNTIME_SETTINGS.ltx25.model,
      /ltx.*2[._-]?5|redgraft/i,
      "strict",
    ),
    [],
    "Strict LTX options must not fall back to incompatible files or stale current values",
  );
  assert.deepEqual(
    compatibleEngineOptions(
      ["minimax_h3.safetensors", DEFAULT_RUNTIME_SETTINGS.ltx25.model],
      DEFAULT_RUNTIME_SETTINGS.ltx25.model,
      /ltx.*2[._-]?5|redgraft/i,
      "strict",
    ),
    [DEFAULT_RUNTIME_SETTINGS.ltx25.model],
  );
  assert.doesNotThrow(() =>
    assertLtx25AssetCompatibility(DEFAULT_RUNTIME_SETTINGS.ltx25)
  );
  for (const invalid of [
    {
      field: "model",
      value: "minimax_h3_ref2va.safetensors",
      expected: /Modello LTX 2\.5 incompatibile/,
    },
    {
      field: "encoder",
      value: "clip_l.safetensors",
      expected: /Text encoder LTX 2\.5 incompatibile/,
    },
    {
      field: "videoVae",
      value: DEFAULT_RUNTIME_SETTINGS.ltx25.audioVae,
      expected: /Video VAE LTX 2\.5 incompatibile/,
    },
    {
      field: "audioVae",
      value: DEFAULT_RUNTIME_SETTINGS.ltx25.videoVae,
      expected: /Audio VAE LTX 2\.5 incompatibile/,
    },
  ] as const) {
    assert.throws(
      () => assertLtx25AssetCompatibility({
        ...DEFAULT_RUNTIME_SETTINGS.ltx25,
        [invalid.field]: invalid.value,
      }),
      invalid.expected,
    );
  }
  const serverSource = readFileSync(path.resolve("bridge", "server.ts"), "utf8");
  assert.match(serverSource, /assertLtx25AssetCompatibility\(ltx25\)/);

  assert.throws(
    () => prepareStudioJob({}, {
      ...request,
      generationMode: "R2V",
      mediaState: JSON.stringify([{ kind: "picture", file: "h3_studio/reference.png [input]" }]),
    }, DEFAULT_RUNTIME_SETTINGS, "bad"),
    /supporta per ora Text to video e Image to video/,
  );
  assert.throws(
    () => prepareStudioJob(
      {},
      { ...request, videoEngine: "ltx-typo" },
      DEFAULT_RUNTIME_SETTINGS,
    ),
    /videoEngine deve essere h3 oppure ltx25/,
  );
  const h3Source = JSON.parse(
    readFileSync(path.resolve("workflows", "studio-backend.api.json"), "utf8"),
  ) as ComfyApiPrompt;
  const legacyH3 = prepareStudioJob(
    h3Source,
    { ...request, videoEngine: undefined, durationSeconds: 5 },
    DEFAULT_RUNTIME_SETTINGS,
    "legacy-no-video-engine",
  );
  assert.equal(legacyH3.request.videoEngine, "h3");

  const store = new RuntimeSettingsStore(temp);
  const changedLtx = {
    ...DEFAULT_RUNTIME_SETTINGS.ltx25,
    model: "changed-ltx-model.safetensors",
    encoder: "changed-ltx-encoder.safetensors",
    videoVae: "changed-ltx-video-vae.safetensors",
    audioVae: "changed-ltx-audio-vae.safetensors",
    cfg: 1.2,
    sampler: "euler_ancestral" as const,
  };
  const updated = await store.update({
    ...DEFAULT_RUNTIME_SETTINGS,
    ltx25: changedLtx,
  });
  assert.equal(updated.ltx25.cfg, 1.2);
  assert.equal((await store.get()).ltx25.sampler, "euler_ancestral");
  await assert.rejects(
    () => store.update({
      ...DEFAULT_RUNTIME_SETTINGS,
      ltx25: { ...DEFAULT_RUNTIME_SETTINGS.ltx25, sampler: "typo" as never },
    }),
    /sampler LTX 2\.5 deve essere euler oppure euler_ancestral/,
  );

  const jobs = new JobRepository(temp);
  jobs.createPrepared(prepared, prepared.engineSettings);
  const persisted = jobs.get("ltx25-test");
  assert.equal(persisted?.request.videoEngine, "ltx25");
  assert.equal(persisted?.engine.family, "ltx25");
  assert.ok(persisted && persisted.engine.family === "ltx25");
  const originalProfile = {
    model: DEFAULT_RUNTIME_SETTINGS.ltx25.model,
    encoder: DEFAULT_RUNTIME_SETTINGS.ltx25.encoder,
    videoVae: DEFAULT_RUNTIME_SETTINGS.ltx25.videoVae,
    audioVae: DEFAULT_RUNTIME_SETTINGS.ltx25.audioVae,
    cfg: DEFAULT_RUNTIME_SETTINGS.ltx25.cfg,
    sampler: DEFAULT_RUNTIME_SETTINGS.ltx25.sampler,
  };
  assert.deepEqual({
    model: persisted.engine.model,
    encoder: persisted.engine.encoder,
    videoVae: persisted.engine.videoVae,
    audioVae: persisted.engine.audioVae,
    cfg: persisted.engine.cfg,
    sampler: persisted.engine.sampler,
  }, originalProfile);

  const schema = new DatabaseSync(jobs.databasePath);
  try {
    const migration = schema
      .prepare("SELECT version FROM schema_migrations WHERE version = 27")
      .get() as { version: number } | undefined;
    assert.equal(migration?.version, 27);
    const columns = new Set(
      (schema.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    assert.ok(columns.has("ltx_profile_json"));
    const row = schema
      .prepare("SELECT ltx_profile_json FROM jobs WHERE id = ?")
      .get("ltx25-test") as { ltx_profile_json: string | null };
    assert.deepEqual(JSON.parse(row.ltx_profile_json ?? "null"), originalProfile);
  } finally {
    schema.close();
  }

  const queuedPrompts: ComfyApiPrompt[] = [];
  let promptSequence = 0;
  const installedModels = {
    diffusion_models: [originalProfile.model, changedLtx.model],
    text_encoders: [originalProfile.encoder, changedLtx.encoder],
    vae: [
      originalProfile.videoVae,
      originalProfile.audioVae,
      changedLtx.videoVae,
      changedLtx.audioVae,
    ],
  };
  const comfy = {
    async models(folder: keyof typeof installedModels) {
      return installedModels[folder] ?? [];
    },
    async queuePrompt(candidatePrompt: ComfyApiPrompt) {
      queuedPrompts.push(candidatePrompt);
      promptSequence += 1;
      return { promptId: `ltx-regenerated-${promptSequence}`, queueNumber: promptSequence };
    },
  };
  const service = new StudioJobService(
    comfy as never,
    null as never,
    null as never,
    store,
    { register() {} } as never,
    jobs,
  );
  const regenerated = await service.regenerate("ltx25-test", 1);
  assert.ok(regenerated && regenerated.engine.family === "ltx25");
  assert.deepEqual({
    model: regenerated.engine.model,
    encoder: regenerated.engine.encoder,
    videoVae: regenerated.engine.videoVae,
    audioVae: regenerated.engine.audioVae,
    cfg: regenerated.engine.cfg,
    sampler: regenerated.engine.sampler,
  }, originalProfile, "regeneration must preserve the complete original LTX profile");
  const regeneratedPrompt = jobs.candidateSnapshot(regenerated.id, 1)?.candidate.apiPrompt;
  assert.ok(regeneratedPrompt);
  assert.equal(regeneratedPrompt["1"].inputs.unet_name, originalProfile.model);
  assert.equal(regeneratedPrompt["2"].inputs.clip_name, originalProfile.encoder);
  assert.equal(regeneratedPrompt["3"].inputs.vae_name, originalProfile.videoVae);
  assert.equal(regeneratedPrompt["4"].inputs.vae_name, originalProfile.audioVae);
  assert.equal(regeneratedPrompt["15"].inputs.cfg, originalProfile.cfg);
  assert.equal(regeneratedPrompt["16"].inputs.sampler_name, originalProfile.sampler);
  assert.deepEqual(queuedPrompts[0], regeneratedPrompt);

  const legacyDir = path.join(temp, "legacy-v26");
  mkdirSync(legacyDir, { recursive: true });
  const legacyDatabasePath = path.join(legacyDir, "h3-studio.sqlite");
  const legacyDatabase = new DatabaseSync(legacyDatabasePath);
  try {
    legacyDatabase.exec("PRAGMA foreign_keys = ON");
    legacyDatabase.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT`);
    for (const migration of JOB_DATABASE_MIGRATIONS) {
      if (migration.version >= 27) break;
      legacyDatabase.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of migration.statements) {
          legacyDatabase.prepare(statement).run();
        }
        legacyDatabase
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
        legacyDatabase.exec("COMMIT");
      } catch (error) {
        legacyDatabase.exec("ROLLBACK");
        throw error;
      }
    }
    const now = new Date().toISOString();
    legacyDatabase.prepare(`INSERT INTO jobs(
      id, status, created_at, updated_at, prompt, candidate_count,
      duration_seconds, megapixels, generation_mode, aspect_format,
      requested_seed, model, lora, lora_strength, steps, video_engine
    ) VALUES (?, 'prepared', ?, ?, ?, 1, 10, 0.5, 'T2V', '16:9 landscape',
      ?, ?, '[]', 0, 8, 'ltx25')`).run(
      "legacy-ltx-v26",
      now,
      now,
      request.prompt,
      String(request.seed),
      originalProfile.model,
    );
    legacyDatabase.prepare(`INSERT INTO candidates(
      job_id, candidate_index, seed, filename_prefix, status,
      api_prompt_json, created_at, updated_at
    ) VALUES (?, 1, ?, ?, 'prepared', ?, ?, ?)`).run(
      "legacy-ltx-v26",
      String(request.seed),
      "video/H3_STUDIO_LTX25/legacy-ltx-v26/candidate_1",
      JSON.stringify(prompt),
      now,
      now,
    );
  } finally {
    legacyDatabase.close();
  }

  const legacyJobs = new JobRepository(legacyDir);
  const legacyPersisted = legacyJobs.get("legacy-ltx-v26");
  assert.ok(legacyPersisted && legacyPersisted.engine.family === "ltx25");
  assert.deepEqual({
    model: legacyPersisted.engine.model,
    encoder: legacyPersisted.engine.encoder,
    videoVae: legacyPersisted.engine.videoVae,
    audioVae: legacyPersisted.engine.audioVae,
    cfg: legacyPersisted.engine.cfg,
    sampler: legacyPersisted.engine.sampler,
  }, originalProfile, "v26 jobs must recover their LTX profile from the stored API prompt");
  const upgradedDatabase = new DatabaseSync(legacyJobs.databasePath, { readOnly: true });
  try {
    const upgraded = upgradedDatabase
      .prepare("SELECT version FROM schema_migrations WHERE version = 27")
      .get() as { version: number } | undefined;
    assert.equal(upgraded?.version, 27);
  } finally {
    upgradedDatabase.close();
  }
  const legacyService = new StudioJobService(
    comfy as never,
    null as never,
    null as never,
    store,
    { register() {} } as never,
    legacyJobs,
  );
  const regeneratedLegacy = await legacyService.regenerate("legacy-ltx-v26", 1);
  assert.ok(regeneratedLegacy && regeneratedLegacy.engine.family === "ltx25");
  assert.deepEqual({
    model: regeneratedLegacy.engine.model,
    encoder: regeneratedLegacy.engine.encoder,
    videoVae: regeneratedLegacy.engine.videoVae,
    audioVae: regeneratedLegacy.engine.audioVae,
    cfg: regeneratedLegacy.engine.cfg,
    sampler: regeneratedLegacy.engine.sampler,
  }, originalProfile);
  legacyJobs.close();
  jobs.close();
  console.log("LTX 2.5 workflow tests passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
