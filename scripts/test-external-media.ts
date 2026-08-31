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
      candidate_index INTEGER NOT NULL
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
