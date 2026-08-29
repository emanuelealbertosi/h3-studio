import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JOB_DATABASE_MIGRATIONS } from "../db/schema.js";
import type { ComfyApiPrompt } from "./comfy-client.js";
import type {
  EngineLoraSettings,
  ResolvedEngineSettings,
} from "./runtime-settings.js";
import type {
  GenerationMode,
  MediaOutput,
  QualityMode,
  SeedMode,
  StudioJob,
  StudioJobRequest,
} from "./studio-job.js";
import { processingSeconds } from "./processing-time.js";

type PreparedJob = {
  jobId: string;
  request: StudioJobRequest;
  candidates: Array<{
    index: number;
    seed: number;
    filenamePrefix: string;
    prompt: ComfyApiPrompt;
  }>;
};

type JobRow = {
  id: string;
  status: StudioJob["status"];
  created_at: string;
  prompt: string;
  candidate_count: number;
  shot_count: number;
  duration_seconds: number;
  megapixels: number;
  generation_mode: GenerationMode;
  aspect_format: StudioJobRequest["aspectFormat"];
  requested_seed: string | null;
  model: string;
  lora: string;
  lora_strength: number;
  steps: number;
  selected_candidate_index: number | null;
  seed_mode: SeedMode;
  quality_mode: QualityMode;
  turbo_enabled: number;
  engine_profile: "standard" | "fast";
  pdd_file: string | null;
  media_state: string;
  reference_roles: string;
  keyframe_positions: string;
  source_video_audio: StudioJobRequest["sourceVideoAudio"];
  project_id: string | null;
  project_name: string | null;
  source_job_id: string | null;
  mute_diegetic: number;
  mute_non_diegetic: number;
  inpaint_target: string;
  inpaint_mask_grow: number;
  inpaint_start_seconds: number;
  inpaint_end_seconds: number;
};

type CandidateRow = {
  job_id: string;
  candidate_index: number;
  seed: string;
  display_name: string | null;
  filename_prefix: string;
  prompt_id: string | null;
  queue_number: number | null;
  status: StudioJob["candidates"][number]["status"];
  api_prompt_json: string;
  output_filename: string | null;
  output_subfolder: string | null;
  output_type: MediaOutput["type"] | null;
  output_format: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function displayName(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 120) {
    throw new Error("Il nome del media deve contenere da 1 a 120 caratteri");
  }
  return normalized;
}

function mediaFromRow(row: CandidateRow): MediaOutput | null {
  if (!row.output_filename || !row.output_type) return null;
  const subfolder = row.output_subfolder ?? "";
  const query = new URLSearchParams({
    filename: row.output_filename,
    subfolder,
    type: row.output_type,
  });
  return {
    filename: row.output_filename,
    subfolder,
    type: row.output_type,
    format: row.output_format ?? "video/mp4",
    mediaPath: `/api/media?${query.toString()}`,
  };
}

function engineLorasFromRow(value: string, legacyStrength: number): EngineLoraSettings[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("legacy");
    return parsed.flatMap((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as { name?: unknown }).name !== "string" ||
        !Number.isFinite(Number((item as { strength?: unknown }).strength))
      ) {
        return [];
      }
      return [{
        name: (item as { name: string }).name,
        strength: Number((item as { strength: unknown }).strength),
      }];
    }).slice(0, 3);
  } catch {
    return value ? [{ name: value, strength: legacyStrength }] : [];
  }
}

export class JobRepository {
  private readonly database: DatabaseSync;
  readonly databasePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.databasePath = path.join(dataDir, "h3-studio.sqlite");
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  private migrate() {
    this.database
      .prepare(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        ) STRICT`,
      )
      .run();
    const applied = new Set(
      (
        this.database
          .prepare("SELECT version FROM schema_migrations")
          .all() as Array<{ version: number }>
      ).map((row) => row.version),
    );

    for (const migration of JOB_DATABASE_MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of migration.statements) {
          this.database.prepare(statement).run();
        }
        this.database
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
          )
          .run(migration.version, new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.ensureFifteenSecondJobs();
    this.database.exec("PRAGMA optimize");
  }

  private ensureFifteenSecondJobs() {
    const schema = this.database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
      .get() as { sql?: string } | undefined;
    if (
      !schema?.sql ||
      !/duration_seconds[\s\S]{0,120}duration_seconds\s+IN\s*\(5,\s*10\)/i.test(schema.sql)
    ) {
      return;
    }

    const indexStatements = (
      this.database
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL`,
        )
        .all() as Array<{ sql: string }>
    ).map((row) => row.sql);

    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const backupDirectory = path.join(path.dirname(this.databasePath), "backups");
    mkdirSync(backupDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(
      this.databasePath,
      path.join(backupDirectory, `h3-studio-before-15s-${timestamp}.sqlite`),
    );

    this.database.exec("PRAGMA foreign_keys = OFF");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`CREATE TABLE jobs_duration_upgrade (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        prompt TEXT NOT NULL,
        candidate_count INTEGER NOT NULL CHECK (candidate_count BETWEEN 1 AND 4),
        shot_count INTEGER NOT NULL DEFAULT 1 CHECK (shot_count BETWEEN 1 AND 12),
        duration_seconds INTEGER NOT NULL CHECK (duration_seconds IN (5, 10, 15)),
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
        ,inpaint_target TEXT NOT NULL DEFAULT ''
        ,inpaint_mask_grow INTEGER NOT NULL DEFAULT 8
          CHECK (inpaint_mask_grow BETWEEN 0 AND 96)
        ,inpaint_start_seconds REAL NOT NULL DEFAULT 0
          CHECK (inpaint_start_seconds BETWEEN 0 AND 180)
        ,inpaint_end_seconds REAL NOT NULL DEFAULT 0
          CHECK (inpaint_end_seconds BETWEEN 0 AND 180)
      ) STRICT`);
      this.database.exec(`INSERT INTO jobs_duration_upgrade(
        id, status, created_at, updated_at, prompt, candidate_count,
        shot_count, duration_seconds, megapixels, generation_mode, aspect_format,
        requested_seed, model, lora, lora_strength, steps,
        selected_candidate_index, seed_mode, media_state, reference_roles,
        keyframe_positions, source_video_audio, project_id, source_job_id,
        mute_diegetic, mute_non_diegetic, quality_mode, turbo_enabled,
        engine_profile, pdd_file, inpaint_target, inpaint_mask_grow,
        inpaint_start_seconds, inpaint_end_seconds
      ) SELECT
        id, status, created_at, updated_at, prompt, candidate_count,
        shot_count, duration_seconds, megapixels, generation_mode, aspect_format,
        requested_seed, model, lora, lora_strength, steps,
        selected_candidate_index, seed_mode, media_state, reference_roles,
        keyframe_positions, source_video_audio, project_id, source_job_id,
        mute_diegetic, mute_non_diegetic, quality_mode, turbo_enabled,
        engine_profile, pdd_file, inpaint_target, inpaint_mask_grow,
        inpaint_start_seconds, inpaint_end_seconds
      FROM jobs`);
      this.database.exec("DROP TABLE jobs");
      this.database.exec("ALTER TABLE jobs_duration_upgrade RENAME TO jobs");
      for (const statement of indexStatements) this.database.exec(statement);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }
    const violations = this.database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) {
      throw new Error("Migrazione durata 15s completata con riferimenti SQLite non validi");
    }
  }

  createPrepared(prepared: PreparedJob, settings: ResolvedEngineSettings) {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO jobs(
            id, status, created_at, updated_at, prompt, candidate_count,
            shot_count, duration_seconds, megapixels, generation_mode, aspect_format,
            requested_seed, seed_mode, media_state, reference_roles,
            keyframe_positions, source_video_audio,
            project_id, source_job_id, mute_diegetic, mute_non_diegetic,
            inpaint_target, inpaint_mask_grow,
            inpaint_start_seconds, inpaint_end_seconds,
            quality_mode, turbo_enabled, engine_profile, pdd_file,
            model, lora, lora_strength, steps
          ) VALUES (?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          prepared.jobId,
          now,
          now,
          prepared.request.prompt,
          prepared.request.candidateCount,
          prepared.request.shotCount,
          prepared.request.durationSeconds,
          prepared.request.megapixels === 0.98 ? 1 : prepared.request.megapixels,
          prepared.request.generationMode,
          prepared.request.aspectFormat,
          prepared.request.seed === undefined ? null : String(prepared.request.seed),
          prepared.request.seedMode,
          prepared.request.mediaState,
          prepared.request.referenceRoles,
          prepared.request.keyframePositions,
          prepared.request.sourceVideoAudio,
          prepared.request.projectId,
          prepared.request.sourceJobId,
          prepared.request.muteDiegetic ? 1 : 0,
          prepared.request.muteNonDiegetic ? 1 : 0,
          prepared.request.inpaintTarget,
          prepared.request.inpaintMaskGrow,
          prepared.request.inpaintStartSeconds,
          prepared.request.inpaintEndSeconds,
          prepared.request.qualityMode,
          prepared.request.turboEnabled ? 1 : 0,
          settings.profile,
          settings.pddFile,
          settings.model,
          JSON.stringify(settings.loras),
          settings.loraStrength,
          settings.steps,
        );

      const insertCandidate = this.database.prepare(
        `INSERT INTO candidates(
          job_id, candidate_index, seed, filename_prefix, prompt_id,
          queue_number, status, api_prompt_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, 'prepared', ?, ?, ?)`,
      );
      for (const candidate of prepared.candidates) {
        insertCandidate.run(
          prepared.jobId,
          candidate.index,
          String(candidate.seed),
          candidate.filenamePrefix,
          JSON.stringify(candidate.prompt),
          now,
          now,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markQueued(
    jobId: string,
    candidateIndex: number,
    promptId: string,
    queueNumber: number | null,
  ) {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE candidates
         SET prompt_id = ?, queue_number = ?, status = 'submitted', error = NULL, updated_at = ?
         WHERE job_id = ? AND candidate_index = ?
           AND status NOT IN ('ready', 'failed')`,
      )
      .run(promptId, queueNumber, now, jobId, candidateIndex);
  }

  failCandidate(jobId: string, candidateIndex: number, error: string) {
    this.database.prepare(
      `UPDATE candidates SET status = 'failed', error = ?, updated_at = ?
       WHERE job_id = ? AND candidate_index = ?
         AND status NOT IN ('ready', 'failed')`,
    ).run(error, new Date().toISOString(), jobId, candidateIndex);
  }

  updateJobStatus(jobId: string, status: StudioJob["status"]) {
    this.database
      .prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), jobId);
  }

  updateCandidate(
    jobId: string,
    candidateIndex: number,
    status: StudioJob["candidates"][number]["status"],
    output: MediaOutput | null,
  ) {
    this.database
      .prepare(
        `UPDATE candidates SET
          status = ?, output_filename = ?, output_subfolder = ?,
          output_type = ?, output_format = ?, updated_at = ?
         WHERE job_id = ? AND candidate_index = ?
           AND status NOT IN ('ready', 'failed')`,
      )
      .run(
        status,
        output?.filename ?? null,
        output?.subfolder ?? null,
        output?.type ?? null,
        output?.format ?? null,
        new Date().toISOString(),
        jobId,
        candidateIndex,
      );
  }

  renameCandidate(jobId: string, candidateIndex: number, value: unknown) {
    const result = this.database
      .prepare(`UPDATE candidates SET display_name = ?
                WHERE job_id = ? AND candidate_index = ?`)
      .run(displayName(value), jobId, candidateIndex);
    if (result.changes !== 1) throw new Error("Candidato video non trovato");
    return this.get(jobId);
  }

  candidateSnapshot(jobId: string, candidateIndex: number) {
    const row = this.database
      .prepare(
        `SELECT * FROM candidates
         WHERE job_id = ? AND candidate_index = ?`,
      )
      .get(jobId, candidateIndex) as CandidateRow | undefined;
    if (!row) return null;
    return {
      job: this.get(jobId),
      candidate: {
        index: row.candidate_index,
        seed: Number(row.seed),
        displayName: row.display_name,
        status: row.status,
        apiPrompt: JSON.parse(row.api_prompt_json) as ComfyApiPrompt,
        output: mediaFromRow(row),
      },
    };
  }

  get(jobId: string): StudioJob | null {
    const job = this.database
      .prepare(
        `SELECT jobs.*, projects.name AS project_name
         FROM jobs
         LEFT JOIN projects ON projects.id = jobs.project_id
         WHERE jobs.id = ?`,
      )
      .get(jobId) as JobRow | undefined;
    if (!job) return null;
    const candidates = this.database
      .prepare(
        `SELECT * FROM candidates
         WHERE job_id = ? ORDER BY candidate_index`,
      )
      .all(jobId) as unknown as CandidateRow[];
    const engineLoras = engineLorasFromRow(job.lora, job.lora_strength);
    return {
      id: job.id,
      projectId: job.project_id,
      projectName: job.project_name,
      sourceJobId: job.source_job_id,
      status: job.status,
      createdAt: job.created_at,
      selectedCandidateIndex: job.selected_candidate_index,
      engine: {
        profile: job.engine_profile,
        pddFile: job.pdd_file,
        model: job.model,
        loras: engineLoras,
        lora: engineLoras[0]?.name ?? "",
        loraStrength: engineLoras[0]?.strength ?? 0,
        steps: job.steps,
      },
      request: {
        prompt: job.prompt,
        promptLength: job.prompt.length,
        candidateCount: job.candidate_count as 1 | 2 | 3 | 4,
        shotCount: job.shot_count,
        durationSeconds: job.duration_seconds as 5 | 10 | 15,
        megapixels: (job.megapixels === 1 ? 0.98 : job.megapixels) as
          | 0.5
          | 0.7
          | 0.98,
        generationMode: job.generation_mode,
        aspectFormat: job.aspect_format,
        seedMode: job.seed_mode,
        qualityMode: job.quality_mode,
        turboEnabled: job.turbo_enabled === 1,
        seed: job.requested_seed === null ? undefined : Number(job.requested_seed),
        mediaState: job.media_state,
        referenceRoles: job.reference_roles,
        keyframePositions: job.keyframe_positions,
        sourceVideoAudio: job.source_video_audio,
        projectId: job.project_id,
        sourceJobId: job.source_job_id,
        muteDiegetic: job.mute_diegetic === 1,
        muteNonDiegetic: job.mute_non_diegetic === 1,
        inpaintTarget: job.inpaint_target,
        inpaintMaskGrow: job.inpaint_mask_grow,
        inpaintStartSeconds: job.inpaint_start_seconds,
        inpaintEndSeconds: job.inpaint_end_seconds,
      },
      candidates: candidates.map((candidate) => ({
        index: candidate.candidate_index,
        seed: Number(candidate.seed),
        displayName: candidate.display_name,
        filenamePrefix: candidate.filename_prefix,
        promptId: candidate.prompt_id,
        queueNumber: candidate.queue_number,
        status: candidate.status,
        processingSeconds: processingSeconds(
          candidate.created_at,
          candidate.updated_at,
          candidate.status === "ready" || candidate.status === "failed",
        ),
        output: mediaFromRow(candidate),
        error: candidate.error,
      })),
    };
  }

  listIds(limit = 20, projectId?: string | null) {
    const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
    if (projectId) {
      return (
        this.database
          .prepare(
            "SELECT id FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(projectId, bounded) as Array<{ id: string }>
      ).map((row) => row.id);
    }
    return (
      this.database
        .prepare("SELECT id FROM jobs ORDER BY created_at DESC LIMIT ?")
        .all(bounded) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  assignProject(jobId: string, projectId: string | null) {
    const result = this.database
      .prepare("UPDATE jobs SET project_id = ?, updated_at = ? WHERE id = ?")
      .run(projectId, new Date().toISOString(), jobId);
    if (result.changes !== 1) throw new Error("Job non trovato");
    return this.get(jobId);
  }

  selectCandidate(jobId: string, candidateIndex: number) {
    const result = this.database
      .prepare(
        `UPDATE jobs
         SET selected_candidate_index = ?, updated_at = ?
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM candidates
             WHERE candidates.job_id = jobs.id
               AND candidates.candidate_index = ?
               AND candidates.status = 'ready'
           )`,
      )
      .run(candidateIndex, new Date().toISOString(), jobId, candidateIndex);
    if (result.changes !== 1) {
      throw new Error("Candidato non selezionabile");
    }
  }

  deleteCandidate(jobId: string, candidateIndex: number) {
    const candidate = this.database
      .prepare(
        `SELECT status, output_filename, output_subfolder, output_type
         FROM candidates WHERE job_id = ? AND candidate_index = ?`,
      )
      .get(jobId, candidateIndex) as {
        status: string;
        output_filename: string | null;
        output_subfolder: string | null;
        output_type: string | null;
      } | undefined;
    if (!candidate) {
      throw new Error("Candidato non trovato");
    }
    if (!['ready', 'failed'].includes(candidate.status)) {
      throw new Error("Non puoi eliminare un candidato ancora in esecuzione");
    }
    if (candidate.status === 'ready' && !candidate.output_filename) {
      throw new Error("Video candidato non trovato");
    }
    const busyVariant = this.database
      .prepare(
        `SELECT 1 FROM candidate_variants
         WHERE source_job_id = ? AND source_candidate_index = ?
           AND status NOT IN ('ready', 'failed') LIMIT 1`,
      )
      .get(jobId, candidateIndex);
    if (busyVariant) {
      throw new Error("Attendi la fine del Face Refiner/Upscale prima di eliminare il video");
    }

    const variantFiles = this.database
      .prepare(
        `SELECT output_filename, output_subfolder, output_type,
                intermediate_filename, intermediate_subfolder, intermediate_type
         FROM candidate_variants
         WHERE source_job_id = ? AND source_candidate_index = ?`,
      )
      .all(jobId, candidateIndex) as unknown as Array<{
        output_filename: string | null;
        output_subfolder: string | null;
        output_type: string | null;
        intermediate_filename: string | null;
        intermediate_subfolder: string | null;
        intermediate_type: string | null;
      }>;
    const clips = this.database
      .prepare(
        `SELECT timeline_id, project_id FROM project_clips
         WHERE source_job_id = ? AND source_candidate_index = ?`,
      )
      .all(jobId, candidateIndex) as unknown as Array<{
        timeline_id: string;
        project_id: string;
      }>;
    const files = [
      {
        filename: `latent_${String(candidateIndex).padStart(5, "0")}.safetensors`,
        subfolder: `video/H3_STUDIO_CONTEXT/${jobId}`,
        type: "output",
      },
      candidate.output_filename
        ? {
            filename: candidate.output_filename,
            subfolder: candidate.output_subfolder ?? "",
            type: candidate.output_type ?? "output",
          }
        : null,
      ...variantFiles.flatMap((variant) => [
        variant.output_filename
          ? {
              filename: variant.output_filename,
              subfolder: variant.output_subfolder ?? "",
              type: variant.output_type ?? "output",
            }
          : null,
        variant.intermediate_filename
          ? {
              filename: variant.intermediate_filename,
              subfolder: variant.intermediate_subfolder ?? "",
              type: variant.intermediate_type ?? "output",
            }
          : null,
      ]),
    ].filter((file): file is { filename: string; subfolder: string; type: string } =>
      file !== null,
    );
    const timelineIds = [...new Set(clips.map((clip) => clip.timeline_id))];
    const projectIds = [...new Set(clips.map((clip) => clip.project_id))];
    const now = new Date().toISOString();

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `DELETE FROM project_clips
           WHERE source_job_id = ? AND source_candidate_index = ?`,
        )
        .run(jobId, candidateIndex);
      this.database
        .prepare(
          `DELETE FROM candidate_variants
           WHERE source_job_id = ? AND source_candidate_index = ?`,
        )
        .run(jobId, candidateIndex);
      this.database
        .prepare("DELETE FROM candidates WHERE job_id = ? AND candidate_index = ?")
        .run(jobId, candidateIndex);

      for (const timelineId of timelineIds) {
        const remaining = this.database
          .prepare(
            `SELECT id FROM project_clips
             WHERE timeline_id = ? ORDER BY position, created_at`,
          )
          .all(timelineId) as unknown as Array<{ id: string }>;
        const updatePosition = this.database.prepare(
          "UPDATE project_clips SET position = ?, updated_at = ? WHERE id = ?",
        );
        remaining.forEach((clip, position) => updatePosition.run(position, now, clip.id));
        this.database
          .prepare("UPDATE project_timelines SET updated_at = ? WHERE id = ?")
          .run(now, timelineId);
      }
      for (const projectId of projectIds) {
        this.database
          .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
          .run(now, projectId);
      }

      const remaining = this.database
        .prepare("SELECT COUNT(*) AS count FROM candidates WHERE job_id = ?")
        .get(jobId) as { count: number };
      if (remaining.count === 0) {
        this.database.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
      } else {
        this.database
          .prepare(
            `UPDATE jobs
             SET selected_candidate_index = CASE
                   WHEN selected_candidate_index = ? THEN NULL
                   ELSE selected_candidate_index
                 END,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(candidateIndex, now, jobId);
      }
      this.database.exec("COMMIT");
      return {
        jobDeleted: remaining.count === 0,
        removedClips: clips.length,
        files,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recoverableCandidates() {
    return this.database
      .prepare(
        `SELECT prompt_id, api_prompt_json
         FROM candidates
         WHERE prompt_id IS NOT NULL AND status NOT IN ('ready', 'failed')`,
      )
      .all() as unknown as Array<{
      prompt_id: string;
      api_prompt_json: string;
    }>;
  }

  stats() {
    const jobs = this.database
      .prepare("SELECT COUNT(*) AS count FROM jobs")
      .get() as { count: number };
    const candidates = this.database
      .prepare("SELECT COUNT(*) AS count FROM candidates")
      .get() as { count: number };
    return {
      databasePath: this.databasePath,
      jobs: jobs.count,
      candidates: candidates.count,
    };
  }

  close() {
    this.database.close();
  }
}
