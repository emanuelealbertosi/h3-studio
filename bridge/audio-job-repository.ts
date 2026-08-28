import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { processingSeconds } from "./processing-time.js";

export type AudioJobKind = "tts" | "music";
export type AudioJobStatus =
  | "prepared"
  | "queued"
  | "loading"
  | "running"
  | "finalizing"
  | "ready"
  | "failed"
  | "cancelled";

export type AudioOutput = {
  filename: string;
  subfolder: string;
  type: "input" | "output" | "temp";
  format: string;
  file: string;
  mediaPath: string;
};

type AudioJobRow = {
  id: string;
  project_id: string;
  project_name: string | null;
  kind: AudioJobKind;
  status: AudioJobStatus;
  prompt: string;
  lyrics: string;
  voice: string;
  reference_file: string | null;
  reference_text: string;
  duration_seconds: number | null;
  seed: string;
  settings_json: string;
  prompt_id: string | null;
  queue_number: number | null;
  progress: number | null;
  phase_label: string;
  output_filename: string | null;
  output_subfolder: string | null;
  output_type: "input" | "output" | "temp" | null;
  output_format: string | null;
  external_media_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateAudioJob = {
  projectId: string;
  kind: AudioJobKind;
  prompt: string;
  lyrics?: string;
  voice?: string;
  referenceFile?: string | null;
  referenceText?: string;
  durationSeconds?: number | null;
  seed: number;
  settings: Record<string, unknown>;
};

function outputFromRow(row: AudioJobRow): AudioOutput | null {
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
    format: row.output_format ?? "audio/wav",
    file: `${subfolder ? `${subfolder}/` : ""}${row.output_filename} [${row.output_type}]`,
    mediaPath: `/api/media?${query.toString()}`,
  };
}

function fromRow(row: AudioJobRow) {
  const terminal = ["ready", "failed", "cancelled"].includes(row.status);
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    kind: row.kind,
    status: row.status,
    prompt: row.prompt,
    lyrics: row.lyrics,
    voice: row.voice,
    referenceFile: row.reference_file,
    referenceText: row.reference_text,
    durationSeconds: row.duration_seconds,
    seed: Number(row.seed),
    settings: JSON.parse(row.settings_json) as Record<string, unknown>,
    promptId: row.prompt_id,
    queueNumber: row.queue_number,
    progress: row.progress,
    phaseLabel: row.phase_label,
    output: outputFromRow(row),
    externalMediaId: row.external_media_id,
    error: row.error,
    processingSeconds: processingSeconds(row.created_at, row.updated_at, terminal),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AudioJobRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
  }

  create(value: CreateAudioJob) {
    const project = this.database.prepare("SELECT id FROM projects WHERE id = ?").get(value.projectId);
    if (!project) throw new Error("Progetto audio non trovato");
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO audio_jobs(
        id, project_id, kind, status, prompt, lyrics, voice, reference_file,
        reference_text, duration_seconds, seed, settings_json, phase_label,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, 'Preparazione audio', ?, ?)`,
    ).run(
      id,
      value.projectId,
      value.kind,
      value.prompt,
      value.lyrics ?? "",
      value.voice ?? "",
      value.referenceFile ?? null,
      value.referenceText ?? "",
      value.durationSeconds ?? null,
      String(value.seed),
      JSON.stringify(value.settings),
      now,
      now,
    );
    return this.get(id)!;
  }

  update(
    id: string,
    value: {
      status?: AudioJobStatus;
      phaseLabel?: string;
      progress?: number | null;
      promptId?: string | null;
      queueNumber?: number | null;
      output?: Omit<AudioOutput, "file" | "mediaPath"> | null;
      externalMediaId?: string | null;
      error?: string | null;
    },
  ) {
    const current = this.get(id);
    if (!current) throw new Error("Job audio non trovato");
    const output = value.output === undefined ? current.output : value.output;
    this.database.prepare(
      `UPDATE audio_jobs SET
        status = ?, phase_label = ?, progress = ?, prompt_id = ?, queue_number = ?,
        output_filename = ?, output_subfolder = ?, output_type = ?, output_format = ?,
        external_media_id = ?, error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      value.status ?? current.status,
      value.phaseLabel ?? current.phaseLabel,
      value.progress === undefined ? current.progress : value.progress,
      value.promptId === undefined ? current.promptId : value.promptId,
      value.queueNumber === undefined ? current.queueNumber : value.queueNumber,
      output?.filename ?? null,
      output?.subfolder ?? null,
      output?.type ?? null,
      output?.format ?? null,
      value.externalMediaId === undefined ? current.externalMediaId : value.externalMediaId,
      value.error === undefined ? current.error : value.error,
      new Date().toISOString(),
      id,
    );
    return this.get(id)!;
  }

  get(id: string) {
    const row = this.database.prepare(
      `SELECT audio_jobs.*, projects.name AS project_name
       FROM audio_jobs JOIN projects ON projects.id = audio_jobs.project_id
       WHERE audio_jobs.id = ?`,
    ).get(id) as AudioJobRow | undefined;
    return row ? fromRow(row) : null;
  }

  list(limit = 50, projectId?: string | null) {
    const bounded = Math.min(200, Math.max(1, Math.trunc(limit)));
    const rows = projectId
      ? this.database.prepare(
          `SELECT audio_jobs.*, projects.name AS project_name
           FROM audio_jobs JOIN projects ON projects.id = audio_jobs.project_id
           WHERE audio_jobs.project_id = ? ORDER BY audio_jobs.created_at DESC LIMIT ?`,
        ).all(projectId, bounded)
      : this.database.prepare(
          `SELECT audio_jobs.*, projects.name AS project_name
           FROM audio_jobs JOIN projects ON projects.id = audio_jobs.project_id
           ORDER BY audio_jobs.created_at DESC LIMIT ?`,
        ).all(bounded);
    return (rows as unknown as AudioJobRow[]).map(fromRow);
  }

  pending() {
    return this.list(200).filter((job) => !["ready", "failed", "cancelled"].includes(job.status));
  }

  markInterrupted() {
    const result = this.database.prepare(
      `UPDATE audio_jobs SET status = 'failed', phase_label = 'Bridge riavviato',
       progress = NULL, error = 'Il bridge è stato riavviato durante la generazione audio', updated_at = ?
       WHERE kind = 'tts' AND status NOT IN ('ready', 'failed', 'cancelled')`,
    ).run(new Date().toISOString());
    return Number(result.changes);
  }

  delete(id: string) {
    const job = this.get(id);
    if (!job) throw new Error("Job audio non trovato");
    if (!["ready", "failed", "cancelled"].includes(job.status)) {
      throw new Error("Interrompi il job audio prima di eliminarlo");
    }
    this.database.prepare("DELETE FROM audio_jobs WHERE id = ?").run(id);
    return job;
  }

  count() {
    return Number((this.database.prepare("SELECT COUNT(*) AS count FROM audio_jobs").get() as { count: number }).count);
  }

  close() {
    this.database.close();
  }
}
