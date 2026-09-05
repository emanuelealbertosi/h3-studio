import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ExternalMediaRepository } from "../bridge/external-media-repository.js";
import { JobRepository } from "../bridge/job-repository.js";
import { ProjectRepository } from "../bridge/project-repository.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "h3-studio-external-"));
const jobs = new JobRepository(dataDir);
const projects = new ProjectRepository(jobs.databasePath);
const external = new ExternalMediaRepository(jobs.databasePath);

try {
  const project = projects.create("Media esterni");
  assert.ok(project);
  const first = external.upsert({
    kind: "picture",
    file: "minimax_h3/external_portrait.png [input]",
    name: "external_portrait.png",
    original: "Portrait.png",
    size: 123_456,
    width: 1024,
    height: 1536,
    has_audio: false,
  }, project.id);
  assert.equal(first.origin, "external");
  assert.equal(first.originProjectName, "Media esterni");
  assert.match(first.mediaPath, /type=input/);

  const duplicate = external.upsert({
    kind: "picture",
    file: "minimax_h3/external_portrait_2.png [input]",
    name: "external_portrait_2.png",
    original: "Portrait.png",
    size: 123_456,
    width: 1024,
    height: 1536,
  }, project.id);
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.file, first.file);
  assert.equal(external.count(), 1);
  assert.equal(external.list()[0].originalName, "Portrait.png");
  const renamed = external.rename(first.id, "Ritratto principale");
  assert.equal(renamed.originalName, "Ritratto principale");
  assert.equal(renamed.file, first.file);

  const database = new DatabaseSync(jobs.databasePath);
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO jobs(
      id, status, created_at, updated_at, prompt, candidate_count,
      duration_seconds, megapixels, generation_mode, aspect_format,
      model, lora, lora_strength, steps
    ) VALUES ('job-15s', 'failed', ?, ?, '15 second test', 1,
      15, 0.7, 'T2V', '16:9 landscape', 'model', '', 0, 8)`,
  ).run(now, now);
  assert.equal(
    (database.prepare("SELECT duration_seconds FROM jobs WHERE id = 'job-15s'").get() as { duration_seconds: number }).duration_seconds,
    15,
  );
  database.close();

  external.delete(first.id);
  assert.equal(external.count(), 0);

  const video = external.upsert({
    kind: "video",
    file: "minimax_h3/external_scene.mp4 [input]",
    name: "external_scene.mp4",
    original: "Scena esterna.mp4",
    size: 987_654,
    duration: 8.5,
    width: 1920,
    height: 1080,
    has_audio: true,
  }, project.id);
  const mainTimeline = projects.get(project.id)?.timelines[0];
  assert.ok(mainTimeline);
  const withExternalVideo = projects.addExternalClipToTimeline(mainTimeline.id, video.id);
  assert.equal(withExternalVideo?.clips.length, 1);
  assert.equal(withExternalVideo?.clips[0].sourceKind, "external");
  assert.equal(withExternalVideo?.clips[0].externalMediaId, video.id);
  assert.equal(withExternalVideo?.clips[0].sourceJobId, null);
  assert.equal(withExternalVideo?.clips[0].sourceCandidateIndex, null);
  assert.equal(withExternalVideo?.clips[0].seed, null);
  assert.equal(withExternalVideo?.clips[0].hasAudio, true);
  assert.equal(withExternalVideo?.clips[0].sourceDuration, 8.5);
  assert.equal(withExternalVideo?.clips[0].trimEnd, 8.5);
  assert.equal(withExternalVideo?.clips[0].variants.length, 0);
  assert.match(withExternalVideo?.clips[0].output.mediaPath ?? "", /type=input/);
  const trimmedVideo = projects.updateClip(withExternalVideo!.clips[0].id, {
    trimStart: 1,
    trimEnd: 6,
    volume: 0.7,
    cropWidth: 0.8,
    cropHeight: 0.8,
    cropX: 0.1,
    cropY: 0.1,
  });
  assert.equal(trimmedVideo?.clips[0].trimStart, 1);
  assert.equal(trimmedVideo?.clips[0].trimEnd, 6);
  assert.equal(trimmedVideo?.clips[0].volume, 0.7);
  const secondProject = projects.create("Destinazione video esterno");
  if (!secondProject) throw new Error("Progetto di destinazione non creato");
  const copiedVideo = projects.copyClip(withExternalVideo!.clips[0].id, secondProject.id);
  const externalCopy = copiedVideo?.clips.find((clip) => clip.externalMediaId === video.id);
  assert.ok(externalCopy);
  assert.equal(externalCopy.trimStart, 1);
  assert.equal(externalCopy.trimEnd, 6);
  assert.equal(projects.deletionPlan(project.id).preserved.externalMedia, 1);
  assert.throws(() => external.delete(video.id), /usato in un montaggio/);
  projects.removeClip(externalCopy.id);
  projects.removeClip(withExternalVideo!.clips[0].id);
  external.delete(video.id);
  assert.equal(external.count(), 0);
  projects.delete(secondProject.id);

  const slide = external.upsert({
    kind: "picture",
    file: "minimax_h3/documentary_slide.png [input]",
    name: "documentary_slide.png",
    original: "Slide capitolo.png",
    size: 456_789,
    width: 1600,
    height: 900,
    has_audio: false,
  }, project.id);
  const withSlide = projects.addExternalClipToTimeline(mainTimeline.id, slide.id, undefined, 4.5);
  const slideClip = withSlide?.clips.find((clip) => clip.externalMediaId === slide.id);
  assert.ok(slideClip);
  assert.equal(slideClip.sourceKind, "external");
  assert.equal(slideClip.mediaKind, "image");
  assert.equal(slideClip.isStillImage, true);
  assert.equal(slideClip.hasAudio, false);
  assert.equal(slideClip.sourceDuration, 4.5);
  assert.equal(slideClip.trimStart, 0);
  assert.equal(slideClip.trimEnd, 4.5);
  const longerSlide = projects.updateClip(slideClip.id, { durationSeconds: 7.5 });
  assert.equal(longerSlide?.clips[0].sourceDuration, 7.5);
  assert.equal(longerSlide?.clips[0].trimEnd, 7.5);
  assert.throws(() => external.delete(slide.id), /usato in un montaggio/);
  projects.removeClip(slideClip.id);
  external.delete(slide.id);
  assert.equal(external.count(), 0);
  console.log("External media persistence + extended SQLite constraints: OK");
} finally {
  external.close();
  projects.close();
  jobs.close();
  rmSync(dataDir, { recursive: true, force: true });
}

const legacyDir = mkdtempSync(path.join(tmpdir(), "h3-studio-legacy-15s-"));
let legacyFailure: unknown = null;
try {
  const legacyPath = path.join(legacyDir, "h3-studio.sqlite");
  const legacyDatabase = new DatabaseSync(legacyPath);
  legacyDatabase.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      prompt TEXT NOT NULL,
      candidate_count INTEGER NOT NULL CHECK (candidate_count BETWEEN 1 AND 4),
      duration_seconds INTEGER NOT NULL CHECK (duration_seconds IN (5, 10)),
      megapixels REAL NOT NULL CHECK (megapixels IN (0.5, 0.7, 1.0)),
      generation_mode TEXT NOT NULL,
      aspect_format TEXT NOT NULL,
      requested_seed TEXT,
      model TEXT NOT NULL,
      lora TEXT NOT NULL,
      lora_strength REAL NOT NULL,
      steps INTEGER NOT NULL CHECK (steps BETWEEN 4 AND 30),
      selected_candidate_index INTEGER CHECK (selected_candidate_index BETWEEN 1 AND 4),
      seed_mode TEXT NOT NULL DEFAULT 'random' CHECK (seed_mode IN ('random', 'base', 'fixed')),
      media_state TEXT NOT NULL DEFAULT '[]',
      reference_roles TEXT NOT NULL DEFAULT 'AUTO',
      keyframe_positions TEXT NOT NULL DEFAULT 'AUTO',
      source_video_audio TEXT NOT NULL DEFAULT 'AUTO'
        CHECK (source_video_audio IN ('AUTO', 'IGNORE', 'REFERENCE', 'REUSE')),
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      source_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      mute_diegetic INTEGER NOT NULL DEFAULT 0 CHECK (mute_diegetic IN (0, 1)),
      mute_non_diegetic INTEGER NOT NULL DEFAULT 0 CHECK (mute_non_diegetic IN (0, 1)),
      quality_mode TEXT NOT NULL DEFAULT 'fast'
        CHECK (quality_mode IN ('fast', 'min', 'med', 'max')),
      turbo_enabled INTEGER NOT NULL DEFAULT 1 CHECK (turbo_enabled IN (0, 1)),
      engine_profile TEXT NOT NULL DEFAULT 'standard'
        CHECK (engine_profile IN ('standard', 'fast')),
      pdd_file TEXT
    ) STRICT;
    CREATE TABLE candidates (
      job_id TEXT NOT NULL,
      candidate_index INTEGER NOT NULL,
      PRIMARY KEY (job_id, candidate_index)
    ) STRICT;
    CREATE TABLE candidate_variants (
      id TEXT PRIMARY KEY
    ) STRICT;
    CREATE TABLE project_timelines (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      external_audio_file TEXT,
      external_audio_name TEXT,
      original_audio_gain REAL NOT NULL DEFAULT 1,
      external_audio_gain REAL NOT NULL DEFAULT 1,
      external_audio_loop INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE project_clips (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_job_id TEXT NOT NULL,
      source_candidate_index INTEGER NOT NULL,
      position INTEGER NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      timeline_id TEXT,
      trim_start REAL NOT NULL DEFAULT 0,
      trim_end REAL,
      volume REAL NOT NULL DEFAULT 1,
      source_variant_id TEXT
    ) STRICT;
    CREATE TABLE image_candidates (
      job_id TEXT NOT NULL,
      candidate_index INTEGER NOT NULL
    ) STRICT;
  `);
  const migrationStamp = new Date().toISOString();
  for (let version = 1; version <= 16; version += 1) {
    legacyDatabase
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(version, migrationStamp);
  }
  legacyDatabase.close();

  const upgraded = new JobRepository(legacyDir);
  upgraded.close();
  const verified = new DatabaseSync(legacyPath);
  try {
    const upgradedSchema = (
      verified.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get() as { sql: string }
    ).sql;
    assert.match(upgradedSchema, /duration_seconds IN \(5, 10, 15, 20\)/);
    assert.match(upgradedSchema, /megapixels IN \(0\.5, 0\.7, 1\.0, 1\.5, 2\.0\)/);
    assert.equal(verified.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    verified.close();
  }
  assert.equal(
    readdirSync(path.join(legacyDir, "backups")).filter((name) => name.endsWith(".sqlite")).length,
    1,
  );
  console.log("Legacy database migration to LTX 20s/2MP + backup: OK");
} catch (error) {
  legacyFailure = error;
} finally {
  try {
    rmSync(legacyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (cleanupError) {
    if (!legacyFailure) legacyFailure = cleanupError;
  }
}
if (legacyFailure) throw legacyFailure;
