import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  composeImagePrompt,
  type ImageCompositionPreset,
  isImageCompositionPreset,
} from "../lib/image-composition.js";
import type { ComfyApiPrompt } from "./comfy-client.js";

export type ImageJobMode = "generate" | "edit";
export type ImageSeedMode = "random" | "base" | "fixed";
export type ImageProjectTag = "untagged" | "character" | "object" | "background";
export type ImageReferenceRole =
  | "base"
  | "subject"
  | "style"
  | "pose"
  | "background"
  | "other";
export type ImageCandidateStatus =
  | "prepared"
  | "submitted"
  | "queued"
  | "running"
  | "ready"
  | "failed"
  | "cancelled";
export type ImageJobStatus =
  | "prepared"
  | "queued"
  | "running"
  | "ready"
  | "partial"
  | "failed"
  | "cancelled";

export type ImageEngineSnapshot = {
  kind: "krea" | "flux2-klein-edit" | "anima" | "minimax-h3-image";
  model: string;
  encoder: string;
  vae: string;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  kvCacheEnabled?: boolean;
  attentionBackend?:
    | "auto"
    | "pytorch attention"
    | "comfy kitchen attention";
  compositionPreset?: ImageCompositionPreset;
  effectivePrompt?: string;
  loras?: Array<{ name: string; strength: number }>;
  imageMode?: "t2i" | "i2i" | "reference";
  turboLora?: string;
  turboStrength?: number;
  detailLora?: string;
  detailStrength?: number;
  preserveStrength?: number;
};

export type ImageJobReferenceInput = {
  file: string;
  name: string;
  role: ImageReferenceRole;
  width: number | null;
  height: number | null;
};

export type PreparedImageJob = {
  id: string;
  originProjectId: string;
  mode: ImageJobMode;
  prompt: string;
  effectivePrompt: string;
  compositionPreset: ImageCompositionPreset;
  candidateCount: 1 | 2 | 3 | 4;
  aspectFormat: string;
  width: number;
  height: number;
  seedMode: ImageSeedMode;
  requestedSeed: number | null;
  tag: ImageProjectTag;
  engine: ImageEngineSnapshot;
  references: ImageJobReferenceInput[];
  candidates: Array<{
    index: number;
    seed: number;
    filenamePrefix: string;
    apiPrompt: ComfyApiPrompt;
  }>;
};

type ImageJobRow = {
  id: string;
  origin_project_id: string | null;
  origin_project_name: string | null;
  mode: ImageJobMode;
  prompt: string;
  candidate_count: number;
  aspect_format: string;
  width: number;
  height: number;
  seed_mode: ImageSeedMode;
  requested_seed: string | null;
  selected_candidate_index: number | null;
  status: ImageJobStatus;
  engine_snapshot_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type ImageCandidateRow = {
  job_id: string;
  candidate_index: number;
  seed: string;
  display_name: string | null;
  filename_prefix: string;
  prompt_id: string | null;
  queue_number: number | null;
  status: ImageCandidateStatus;
  api_prompt_json: string;
  output_filename: string | null;
  output_subfolder: string | null;
  output_type: "input" | "output" | "temp" | null;
  output_format: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type ImageReferenceRow = {
  id: string;
  job_id: string;
  position: number;
  role: ImageReferenceRole;
  file: string;
  name: string;
  width: number | null;
  height: number | null;
  created_at: string;
};

type ImageProjectLinkRow = {
  project_id: string;
  project_name: string;
  image_job_id: string;
  image_candidate_index: number;
  tag: ImageProjectTag;
  created_at: string;
  updated_at: string;
};

function displayName(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 120) {
    throw new Error("Il nome dell'immagine deve contenere da 1 a 120 caratteri");
  }
  return normalized;
}
function outputFromRow(row: ImageCandidateRow) {
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
    format: row.output_format ?? "image/png",
    file: `${subfolder ? `${subfolder}/` : ""}${row.output_filename} [${row.output_type}]`,
    mediaPath: `/api/media?${query.toString()}`,
  };
}

function referenceFromRow(row: ImageReferenceRow) {
  return {
    id: row.id,
    position: row.position,
    role: row.role,
    file: row.file,
    name: row.name,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

function linkFromRow(row: ImageProjectLinkRow) {
  return {
    projectId: row.project_id,
    projectName: row.project_name,
    jobId: row.image_job_id,
    candidateIndex: row.image_candidate_index,
    tag: row.tag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ImageJobRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
  }

  createPrepared(prepared: PreparedImageJob) {
    const project = this.database
      .prepare("SELECT id FROM projects WHERE id = ?")
      .get(prepared.originProjectId);
    if (!project) throw new Error("Progetto immagini non trovato");
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO image_jobs(
            id, origin_project_id, mode, prompt, candidate_count, aspect_format,
            width, height, seed_mode, requested_seed, status,
            engine_snapshot_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)`,
        )
        .run(
          prepared.id,
          prepared.originProjectId,
          prepared.mode,
          prepared.prompt,
          prepared.candidateCount,
          prepared.aspectFormat,
          prepared.width,
          prepared.height,
          prepared.seedMode,
          prepared.requestedSeed === null ? null : String(prepared.requestedSeed),
          JSON.stringify(prepared.engine),
          now,
          now,
        );
      const insertReference = this.database.prepare(
        `INSERT INTO image_job_references(
          id, job_id, position, role, file, name, width, height, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      prepared.references.forEach((reference, position) => {
        insertReference.run(
          randomUUID(),
          prepared.id,
          position,
          reference.role,
          reference.file,
          reference.name,
          reference.width,
          reference.height,
          now,
        );
      });
      const insertCandidate = this.database.prepare(
        `INSERT INTO image_candidates(
          job_id, candidate_index, seed, filename_prefix, status,
          api_prompt_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?)`,
      );
      const insertProjectLink = this.database.prepare(
        `INSERT INTO project_image_links(
          project_id, image_job_id, image_candidate_index, tag, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const candidate of prepared.candidates) {
        insertCandidate.run(
          prepared.id,
          candidate.index,
          String(candidate.seed),
          candidate.filenamePrefix,
          JSON.stringify(candidate.apiPrompt),
          now,
          now,
        );
        insertProjectLink.run(
          prepared.originProjectId,
          prepared.id,
          candidate.index,
          prepared.tag,
          now,
          now,
        );
      }
      this.database
        .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(now, prepared.originProjectId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.get(prepared.id)!;
  }

  markQueued(jobId: string, candidateIndex: number, promptId: string, queueNumber: number | null) {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE image_candidates
         SET prompt_id = ?, queue_number = ?, status = 'submitted', error = NULL, updated_at = ?
         WHERE job_id = ? AND candidate_index = ?`,
      )
      .run(promptId, queueNumber, now, jobId, candidateIndex);
    this.refreshJobStatus(jobId);
  }

  markCandidateStatus(
    jobId: string,
    candidateIndex: number,
    status: ImageCandidateStatus,
    output?: {
      filename: string;
      subfolder: string;
      type: "input" | "output" | "temp";
      format: string;
    } | null,
    error?: string | null,
  ) {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE image_candidates SET status = ?,
           output_filename = COALESCE(?, output_filename),
           output_subfolder = COALESCE(?, output_subfolder),
           output_type = COALESCE(?, output_type),
           output_format = COALESCE(?, output_format),
           error = ?, updated_at = ?
         WHERE job_id = ? AND candidate_index = ?`,
      )
      .run(
        status,
        output?.filename ?? null,
        output?.subfolder ?? null,
        output?.type ?? null,
        output?.format ?? null,
        error ? error.slice(0, 1_000) : null,
        now,
        jobId,
        candidateIndex,
      );
    this.refreshJobStatus(jobId);
  }

  markCancelled(jobId: string) {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE image_candidates SET status = 'cancelled', updated_at = ?
         WHERE job_id = ? AND status NOT IN ('ready', 'failed', 'cancelled')`,
      )
      .run(now, jobId);
    this.refreshJobStatus(jobId);
  }

  select(jobId: string, candidateIndex: number) {
    const result = this.database
      .prepare(
        `UPDATE image_jobs SET selected_candidate_index = ?, updated_at = ?
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM image_candidates
           WHERE image_candidates.job_id = image_jobs.id
             AND image_candidates.candidate_index = ?
             AND image_candidates.status = 'ready'
         )`,
      )
      .run(candidateIndex, new Date().toISOString(), jobId, candidateIndex);
    if (result.changes !== 1) throw new Error("Candidato immagine non selezionabile");
    return this.get(jobId)!;
  }

  get(jobId: string) {
    const row = this.database
      .prepare(
        `SELECT image_jobs.*, projects.name AS origin_project_name
         FROM image_jobs
         LEFT JOIN projects ON projects.id = image_jobs.origin_project_id
         WHERE image_jobs.id = ?`,
      )
      .get(jobId) as ImageJobRow | undefined;
    if (!row) return null;
    const candidates = this.database
      .prepare("SELECT * FROM image_candidates WHERE job_id = ? ORDER BY candidate_index")
      .all(jobId) as unknown as ImageCandidateRow[];
    const references = this.database
      .prepare("SELECT * FROM image_job_references WHERE job_id = ? ORDER BY position")
      .all(jobId) as unknown as ImageReferenceRow[];
    const links = this.database
      .prepare(
        `SELECT project_image_links.*, projects.name AS project_name
         FROM project_image_links
         JOIN projects ON projects.id = project_image_links.project_id
         WHERE project_image_links.image_job_id = ?
         ORDER BY project_image_links.created_at, project_image_links.project_id`,
      )
      .all(jobId) as unknown as ImageProjectLinkRow[];
    let engine: ImageEngineSnapshot;
    try {
      engine = JSON.parse(row.engine_snapshot_json) as ImageEngineSnapshot;
    } catch {
      engine = {
        kind: row.mode === "edit" ? "flux2-klein-edit" : "krea",
        model: "",
        encoder: "",
        vae: "",
        steps: row.mode === "edit" ? 4 : 8,
        cfg: 1,
        sampler: row.mode === "edit" ? "euler" : "er_sde",
        scheduler: row.mode === "edit" ? "flux2" : "simple",
      };
    }
    const compositionPreset = isImageCompositionPreset(engine.compositionPreset)
      ? engine.compositionPreset
      : "free";
    const effectivePrompt = typeof engine.effectivePrompt === "string" &&
      engine.effectivePrompt.trim()
      ? engine.effectivePrompt
      : composeImagePrompt(row.prompt, compositionPreset);
    return {
      id: row.id,
      originProjectId: row.origin_project_id,
      originProjectName: row.origin_project_name,
      mode: row.mode,
      prompt: row.prompt,
      effectivePrompt,
      compositionPreset,
      candidateCount: row.candidate_count as 1 | 2 | 3 | 4,
      aspectFormat: row.aspect_format,
      width: row.width,
      height: row.height,
      seedMode: row.seed_mode,
      requestedSeed: row.requested_seed === null ? null : Number(row.requested_seed),
      selectedCandidateIndex: row.selected_candidate_index,
      status: row.status,
      engine,
      error: row.error,
      references: references.map(referenceFromRow),
      candidates: candidates.map((candidate) => ({
        index: candidate.candidate_index,
        seed: Number(candidate.seed),
        displayName: candidate.display_name,
        filenamePrefix: candidate.filename_prefix,
        promptId: candidate.prompt_id,
        queueNumber: candidate.queue_number,
        status: candidate.status,
        output: outputFromRow(candidate),
        error: candidate.error,
        createdAt: candidate.created_at,
        updatedAt: candidate.updated_at,
        projectLinks: links
          .filter((link) => link.image_candidate_index === candidate.candidate_index)
          .map(linkFromRow),
      })),
      projectLinks: links.map(linkFromRow),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listIds(limit = 20, projectId?: string | null) {
    const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
    if (!projectId) {
      return (
        this.database
          .prepare("SELECT id FROM image_jobs ORDER BY created_at DESC LIMIT ?")
          .all(bounded) as unknown as Array<{ id: string }>
      ).map((row) => row.id);
    }
    return (
      this.database
        .prepare(
          `SELECT DISTINCT image_jobs.id, image_jobs.created_at
           FROM image_jobs
           JOIN project_image_links
             ON project_image_links.image_job_id = image_jobs.id
           WHERE project_image_links.project_id = ?
           ORDER BY image_jobs.created_at DESC
           LIMIT ?`,
        )
        .all(projectId, bounded) as unknown as Array<{ id: string }>
    ).map((row) => row.id);
  }

  list(limit = 20, projectId?: string | null) {
    return this.listIds(limit, projectId)
      .map((id) => projectId ? this.getForProject(id, projectId) : this.get(id))
      .filter((job): job is NonNullable<ReturnType<ImageJobRepository["get"]>> => job !== null);
  }

  linkProject(
    jobId: string,
    candidateIndex: number,
    projectId: string,
    tag: ImageProjectTag,
  ) {
    const project = this.database.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Progetto di destinazione non trovato");
    const candidate = this.database
      .prepare("SELECT status FROM image_candidates WHERE job_id = ? AND candidate_index = ?")
      .get(jobId, candidateIndex) as { status: ImageCandidateStatus } | undefined;
    if (!candidate) throw new Error("Candidato immagine non trovato");
    if (candidate.status !== "ready") throw new Error("Puoi condividere soltanto immagini completate");
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO project_image_links(
           project_id, image_job_id, image_candidate_index, tag, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, image_job_id, image_candidate_index)
         DO UPDATE SET tag = excluded.tag, updated_at = excluded.updated_at`,
      )
      .run(projectId, jobId, candidateIndex, tag, now, now);
    this.database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
    return this.get(jobId)!;
  }

  unlinkProject(jobId: string, candidateIndex: number, projectId: string) {
    const result = this.database
      .prepare(
        `DELETE FROM project_image_links
         WHERE project_id = ? AND image_job_id = ? AND image_candidate_index = ?`,
      )
      .run(projectId, jobId, candidateIndex);
    if (result.changes !== 1) throw new Error("Associazione immagine-progetto non trovata");
    return this.get(jobId)!;
  }

  renameCandidate(jobId: string, candidateIndex: number, value: unknown) {
    const result = this.database
      .prepare(`UPDATE image_candidates SET display_name = ?
                WHERE job_id = ? AND candidate_index = ?`)
      .run(displayName(value), jobId, candidateIndex);
    if (result.changes !== 1) throw new Error("Candidato immagine non trovato");
    return this.get(jobId);
  }

  deleteCandidate(jobId: string, candidateIndex: number) {
    const candidate = this.database
      .prepare("SELECT * FROM image_candidates WHERE job_id = ? AND candidate_index = ?")
      .get(jobId, candidateIndex) as ImageCandidateRow | undefined;
    if (!candidate) throw new Error("Candidato immagine non trovato");
    if (!["ready", "failed", "cancelled"].includes(candidate.status)) {
      throw new Error("Non puoi eliminare un'immagine ancora in esecuzione");
    }
    const files = candidate.output_filename
      ? [{
          filename: candidate.output_filename,
          subfolder: candidate.output_subfolder ?? "",
          type: candidate.output_type ?? "output",
        }]
      : [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("DELETE FROM image_candidates WHERE job_id = ? AND candidate_index = ?")
        .run(jobId, candidateIndex);
      const remaining = this.database
        .prepare("SELECT COUNT(*) AS count FROM image_candidates WHERE job_id = ?")
        .get(jobId) as { count: number };
      if (remaining.count === 0) {
        this.database.prepare("DELETE FROM image_jobs WHERE id = ?").run(jobId);
      } else {
        this.database
          .prepare(
            `UPDATE image_jobs SET candidate_count = ?,
               selected_candidate_index = CASE
                 WHEN selected_candidate_index = ? THEN NULL ELSE selected_candidate_index
               END,
               updated_at = ?
             WHERE id = ?`,
          )
          .run(remaining.count, candidateIndex, new Date().toISOString(), jobId);
        this.refreshJobStatus(jobId);
      }
      this.database.exec("COMMIT");
      return { jobDeleted: remaining.count === 0, files };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  pendingCandidates() {
    return this.database
      .prepare(
        `SELECT * FROM image_candidates
         WHERE prompt_id IS NOT NULL
           AND status NOT IN ('ready', 'failed', 'cancelled')`,
      )
      .all() as unknown as ImageCandidateRow[];
  }

  promptIds(jobId: string) {
    return (
      this.database
        .prepare(
          `SELECT prompt_id FROM image_candidates
           WHERE job_id = ? AND prompt_id IS NOT NULL
             AND status NOT IN ('ready', 'failed', 'cancelled')`,
        )
        .all(jobId) as unknown as Array<{ prompt_id: string }>
    ).map((row) => row.prompt_id);
  }

  stats() {
    const jobs = this.database.prepare("SELECT COUNT(*) AS count FROM image_jobs").get() as {
      count: number;
    };
    const candidates = this.database
      .prepare("SELECT COUNT(*) AS count FROM image_candidates")
      .get() as { count: number };
    const links = this.database
      .prepare("SELECT COUNT(*) AS count FROM project_image_links")
      .get() as { count: number };
    return { jobs: jobs.count, candidates: candidates.count, projectLinks: links.count };
  }

  close() {
    this.database.close();
  }

  private getForProject(jobId: string, projectId: string) {
    const job = this.get(jobId);
    if (!job) return null;
    const candidates = job.candidates.filter((candidate) =>
      candidate.projectLinks.some((link) => link.projectId === projectId)
    );
    if (candidates.length === 0) return null;
    const candidateIndexes = new Set(candidates.map((candidate) => candidate.index));
    return {
      ...job,
      candidateCount: candidates.length as 1 | 2 | 3 | 4,
      selectedCandidateIndex:
        job.selectedCandidateIndex !== null && candidateIndexes.has(job.selectedCandidateIndex)
          ? job.selectedCandidateIndex
          : null,
      candidates,
      projectLinks: job.projectLinks.filter((link) =>
        candidateIndexes.has(link.candidateIndex)
      ),
    };
  }

  private refreshJobStatus(jobId: string) {
    const rows = this.database
      .prepare("SELECT status FROM image_candidates WHERE job_id = ?")
      .all(jobId) as unknown as Array<{ status: ImageCandidateStatus }>;
    if (rows.length === 0) return;
    const statuses = rows.map((row) => row.status);
    let status: ImageJobStatus;
    if (statuses.every((value) => value === "ready")) status = "ready";
    else if (statuses.some((value) => value === "running")) status = "running";
    else if (statuses.some((value) => ["prepared", "submitted", "queued"].includes(value))) {
      status = "queued";
    } else if (statuses.every((value) => value === "cancelled")) status = "cancelled";
    else if (statuses.some((value) => value === "ready")) status = "partial";
    else status = "failed";
    this.database
      .prepare("UPDATE image_jobs SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), jobId);
  }
}
