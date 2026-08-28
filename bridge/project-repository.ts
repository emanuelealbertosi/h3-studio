import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { MediaOutput } from "./studio-job.js";
import { processingSeconds } from "./processing-time.js";

type ProjectRow = { id: string; name: string; created_at: string; updated_at: string; clip_count: number; timeline_count: number; job_count: number; image_count: number };
type TimelineRow = {
  id: string; project_id: string; project_name: string; name: string;
  external_audio_file: string | null; external_audio_name: string | null;
  original_audio_gain: number; external_audio_gain: number; external_audio_loop: number;
  created_at: string; updated_at: string; clip_count: number;
};
type ClipRow = {
  id: string; project_id: string; timeline_id: string; source_job_id: string;
  source_candidate_index: number; source_variant_id: string | null;
  variant_kind: "face" | "upscale" | "face_upscale" | null;
  variant_target_megapixels: 1 | 2 | null;
  position: number; label: string; created_at: string;
  seed: string; source_duration: number; trim_start: number; trim_end: number | null;
  volume: number; output_filename: string; output_subfolder: string | null;
  output_type: MediaOutput["type"]; output_format: string | null;
  candidate_status: string; candidate_created_at: string; candidate_updated_at: string;
  variant_status: string | null; variant_created_at: string | null;
  variant_updated_at: string | null;
};

function normalizeName(value: unknown, label = "progetto") {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > 80) throw new Error(`Il nome del ${label} deve contenere da 1 a 80 caratteri`);
  return name;
}
function normalizeLabel(value: unknown, fallback: string) {
  if (value === undefined || value === null || value === "") return fallback;
  const label = typeof value === "string" ? value.trim() : "";
  if (label.length < 1 || label.length > 80) throw new Error("L'etichetta della clip deve contenere da 1 a 80 caratteri");
  return label;
}
function numberBetween(value: unknown, min: number, max: number, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label} deve essere compreso tra ${min} e ${max}`);
  return number;
}
function mediaFromClip(row: ClipRow): MediaOutput {
  const subfolder = row.output_subfolder ?? "";
  const query = new URLSearchParams({ filename: row.output_filename, subfolder, type: row.output_type });
  return { filename: row.output_filename, subfolder, type: row.output_type, format: row.output_format ?? "video/mp4", mediaPath: `/api/media?${query.toString()}` };
}
function mapClip(row: ClipRow) {
  return {
    id: row.id, projectId: row.project_id, timelineId: row.timeline_id,
    sourceJobId: row.source_job_id, sourceCandidateIndex: row.source_candidate_index,
    sourceVariantId: row.source_variant_id, variantKind: row.variant_kind ?? "original",
    targetMegapixels: row.variant_target_megapixels
      ?? (row.variant_kind === "upscale" || row.variant_kind === "face_upscale" ? 1 : null),
    position: row.position, label: row.label, createdAt: row.created_at,
    seed: Number(row.seed), sourceDuration: row.source_duration,
    trimStart: row.trim_start, trimEnd: row.trim_end ?? row.source_duration,
    volume: row.volume,
    processingSeconds: row.source_variant_id
      ? processingSeconds(
          row.variant_created_at ?? "",
          row.variant_updated_at ?? "",
          row.variant_status === "ready" || row.variant_status === "failed",
        )
      : processingSeconds(
          row.candidate_created_at,
          row.candidate_updated_at,
          row.candidate_status === "ready" || row.candidate_status === "failed",
        ),
    output: mediaFromClip(row),
  };
}
function mapTimeline(row: TimelineRow) {
  return {
    id: row.id, projectId: row.project_id, projectName: row.project_name, name: row.name,
    externalAudioFile: row.external_audio_file, externalAudioName: row.external_audio_name,
    originalAudioGain: row.original_audio_gain, externalAudioGain: row.external_audio_gain,
    externalAudioLoop: Boolean(row.external_audio_loop), createdAt: row.created_at,
    updatedAt: row.updated_at, clipCount: row.clip_count,
  };
}

export class ProjectRepository {
  private readonly database: DatabaseSync;
  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
  }
  create(nameValue: unknown) {
    const id = randomUUID(), timelineId = randomUUID(), name = normalizeName(nameValue), now = new Date().toISOString();
    const wasEmpty = !this.database.prepare("SELECT 1 FROM projects LIMIT 1").get();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT INTO projects(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, now, now);
      this.database.prepare("INSERT INTO project_timelines(id, project_id, name, created_at, updated_at) VALUES (?, ?, 'Montaggio principale', ?, ?)").run(timelineId, id, now, now);
      if (wasEmpty) {
        this.database.prepare("UPDATE jobs SET project_id = ?, updated_at = ? WHERE project_id IS NULL").run(id, now);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.get(id);
  }
  list() {
    const rows = this.database.prepare(
      `SELECT projects.id, projects.name, projects.created_at, projects.updated_at,
       (SELECT COUNT(*) FROM project_clips WHERE project_clips.project_id = projects.id) AS clip_count,
       (SELECT COUNT(*) FROM project_timelines WHERE project_timelines.project_id = projects.id) AS timeline_count,
       (SELECT COUNT(*) FROM jobs WHERE jobs.project_id = projects.id) AS job_count,
       (SELECT COUNT(*) FROM project_image_links WHERE project_image_links.project_id = projects.id) AS image_count
       FROM projects ORDER BY projects.updated_at DESC`
    ).all() as unknown as ProjectRow[];
    return rows.map(row => ({ id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at, clipCount: row.clip_count, timelineCount: row.timeline_count, jobCount: row.job_count, imageCount: row.image_count }));
  }
  get(projectId: string) {
    const row = this.database.prepare(
      `SELECT projects.id, projects.name, projects.created_at, projects.updated_at,
       (SELECT COUNT(*) FROM project_clips WHERE project_clips.project_id = projects.id) AS clip_count,
       (SELECT COUNT(*) FROM project_timelines WHERE project_timelines.project_id = projects.id) AS timeline_count,
       (SELECT COUNT(*) FROM jobs WHERE jobs.project_id = projects.id) AS job_count,
       (SELECT COUNT(*) FROM project_image_links WHERE project_image_links.project_id = projects.id) AS image_count
       FROM projects WHERE projects.id = ?`
    ).get(projectId) as ProjectRow | undefined;
    if (!row) return null;
    const timelines = this.listTimelines(projectId);
    return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at, clipCount: row.clip_count, timelineCount: row.timeline_count, jobCount: row.job_count, imageCount: row.image_count, timelines, clips: timelines[0] ? this.getTimeline(timelines[0].id)?.clips ?? [] : [] };
  }
  listTimelines(projectId: string) {
    const rows = this.database.prepare(
      `SELECT project_timelines.*, projects.name AS project_name,
       (SELECT COUNT(*) FROM project_clips WHERE project_clips.timeline_id = project_timelines.id) AS clip_count
       FROM project_timelines JOIN projects ON projects.id = project_timelines.project_id
       WHERE project_timelines.project_id = ? ORDER BY project_timelines.created_at`
    ).all(projectId) as unknown as TimelineRow[];
    return rows.map(mapTimeline);
  }
  createTimeline(projectId: string, nameValue: unknown) {
    if (!this.projectExists(projectId)) throw new Error("Progetto non trovato");
    const id = randomUUID(), name = normalizeName(nameValue, "montaggio"), now = new Date().toISOString();
    this.database.prepare("INSERT INTO project_timelines(id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, projectId, name, now, now);
    this.touchProject(projectId, now);
    return this.getTimeline(id);
  }
  getTimeline(timelineId: string) {
    const timeline = this.timelineRow(timelineId);
    if (!timeline) return null;
    const rows = this.database.prepare(
      `SELECT project_clips.id, project_clips.project_id, project_clips.timeline_id,
       project_clips.source_job_id, project_clips.source_candidate_index, project_clips.position,
       project_clips.source_variant_id, candidate_variants.kind AS variant_kind,
       candidate_variants.target_megapixels AS variant_target_megapixels,
       project_clips.label, project_clips.created_at, project_clips.trim_start,
       project_clips.trim_end, project_clips.volume, candidates.seed,
       candidates.status AS candidate_status,
       candidates.created_at AS candidate_created_at,
       candidates.updated_at AS candidate_updated_at,
       candidate_variants.status AS variant_status,
       candidate_variants.created_at AS variant_created_at,
       candidate_variants.updated_at AS variant_updated_at,
       COALESCE(candidate_variants.output_filename, candidates.output_filename) AS output_filename,
       COALESCE(candidate_variants.output_subfolder, candidates.output_subfolder) AS output_subfolder,
       COALESCE(candidate_variants.output_type, candidates.output_type) AS output_type,
       COALESCE(candidate_variants.output_format, candidates.output_format) AS output_format,
       jobs.duration_seconds AS source_duration
       FROM project_clips JOIN candidates ON candidates.job_id = project_clips.source_job_id
       AND candidates.candidate_index = project_clips.source_candidate_index
       LEFT JOIN candidate_variants ON candidate_variants.id = project_clips.source_variant_id
       JOIN jobs ON jobs.id = project_clips.source_job_id
       WHERE project_clips.timeline_id = ? ORDER BY project_clips.position, project_clips.created_at`
    ).all(timelineId) as unknown as ClipRow[];
    return {
      ...mapTimeline(timeline),
      clips: rows.map((row) => ({
        ...mapClip(row),
        variants: this.clipVariants(row.source_job_id, row.source_candidate_index),
      })),
    };
  }
  updateTimeline(timelineId: string, value: {
    name?: unknown; externalAudioFile?: unknown; externalAudioName?: unknown;
    originalAudioGain?: unknown; externalAudioGain?: unknown; externalAudioLoop?: unknown;
  }) {
    const timeline = this.timelineRow(timelineId);
    if (!timeline) throw new Error("Montaggio non trovato");
    const name = value.name === undefined ? timeline.name : normalizeName(value.name, "montaggio");
    const audioFile = value.externalAudioFile === undefined ? timeline.external_audio_file : typeof value.externalAudioFile === "string" && value.externalAudioFile.trim() ? value.externalAudioFile.trim() : null;
    const audioName = value.externalAudioName === undefined ? timeline.external_audio_name : typeof value.externalAudioName === "string" && value.externalAudioName.trim() ? value.externalAudioName.trim().slice(0, 160) : null;
    const originalGain = value.originalAudioGain === undefined ? timeline.original_audio_gain : numberBetween(value.originalAudioGain, 0, 2, "Volume audio originale");
    const externalGain = value.externalAudioGain === undefined ? timeline.external_audio_gain : numberBetween(value.externalAudioGain, 0, 2, "Volume audio esterno");
    const loop = value.externalAudioLoop === undefined ? timeline.external_audio_loop : value.externalAudioLoop ? 1 : 0;
    const now = new Date().toISOString();
    this.database.prepare(
      `UPDATE project_timelines SET name = ?, external_audio_file = ?, external_audio_name = ?,
       original_audio_gain = ?, external_audio_gain = ?, external_audio_loop = ?, updated_at = ? WHERE id = ?`
    ).run(name, audioFile, audioName, originalGain, externalGain, loop, now, timelineId);
    this.touchProject(timeline.project_id, now);
    return this.getTimeline(timelineId);
  }
  deleteTimeline(timelineId: string) {
    const timeline = this.timelineRow(timelineId);
    if (!timeline) throw new Error("Montaggio non trovato");
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM project_timelines WHERE id = ?").run(timelineId);
      this.touchProject(timeline.project_id, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      id: timeline.id,
      projectId: timeline.project_id,
      name: timeline.name,
      removedClips: timeline.clip_count,
    };
  }
  addClip(projectId: string, jobId: string, candidateIndex: number, labelValue?: unknown, variantValue?: unknown) {
    const timeline = this.listTimelines(projectId)[0];
    if (!timeline) throw new Error("Progetto o montaggio principale non trovato");
    return this.addClipToTimeline(timeline.id, jobId, candidateIndex, labelValue, variantValue);
  }
  addClipToTimeline(timelineId: string, jobId: string, candidateIndex: number, labelValue?: unknown, variantValue?: unknown) {
    const timeline = this.getTimeline(timelineId);
    if (!timeline) throw new Error("Montaggio non trovato");
    const candidate = this.database.prepare("SELECT status, output_filename FROM candidates WHERE job_id = ? AND candidate_index = ?").get(jobId, candidateIndex) as { status: string; output_filename: string | null } | undefined;
    if (!candidate || candidate.status !== "ready" || !candidate.output_filename) throw new Error("Il candidato deve essere completato e avere un video");
    const variantId = this.resolveVariant(jobId, candidateIndex, variantValue);
    const position = timeline.clips.length, id = randomUUID(), now = new Date().toISOString();
    const label = normalizeLabel(labelValue, `Clip ${position + 1}`);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT INTO project_clips(id, project_id, timeline_id, source_job_id,
         source_candidate_index, source_variant_id, position, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, timeline.projectId, timelineId, jobId, candidateIndex, variantId, position, label, now, now);
      this.database.prepare("UPDATE jobs SET project_id = ?, updated_at = ? WHERE id = ?").run(timeline.projectId, now, jobId);
      this.touchTimeline(timelineId, now); this.touchProject(timeline.projectId, now);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.getTimeline(timelineId);
  }
  updateClip(clipId: string, value: { trimStart?: unknown; trimEnd?: unknown; volume?: unknown; variantId?: unknown }) {
    const clip = this.clip(clipId);
    if (!clip) throw new Error("Clip non trovata");
    const durationRow = this.database.prepare("SELECT duration_seconds FROM jobs WHERE id = ?").get(clip.source_job_id) as { duration_seconds: number } | undefined;
    if (!durationRow) throw new Error("Sorgente della clip non trovata");
    const sourceDuration = durationRow.duration_seconds;
    const trimStart = value.trimStart === undefined ? clip.trim_start : numberBetween(value.trimStart, 0, sourceDuration - 0.05, "Inizio trim");
    const trimEnd = value.trimEnd === undefined || value.trimEnd === null || value.trimEnd === "" ? clip.trim_end ?? sourceDuration : numberBetween(value.trimEnd, 0.05, sourceDuration, "Fine trim");
    if (trimEnd - trimStart < 0.05) throw new Error("La clip deve durare almeno 0,05 secondi");
    const volume = value.volume === undefined ? clip.volume : numberBetween(value.volume, 0, 2, "Volume clip");
    const variantId = value.variantId === undefined
      ? clip.source_variant_id
      : this.resolveVariant(clip.source_job_id, clip.source_candidate_index, value.variantId);
    const now = new Date().toISOString();
    this.database.prepare("UPDATE project_clips SET trim_start = ?, trim_end = ?, volume = ?, source_variant_id = ?, updated_at = ? WHERE id = ?").run(trimStart, trimEnd, volume, variantId, now, clipId);
    this.touchTimeline(clip.timeline_id, now); this.touchProject(clip.project_id, now);
    return this.getTimeline(clip.timeline_id);
  }
  copyClip(clipId: string, targetId: string) {
    const clip = this.clip(clipId);
    if (!clip) throw new Error("Clip non trovata");
    const timeline = this.resolveTimeline(targetId);
    if (!timeline) throw new Error("Montaggio di destinazione non trovato");
    const result = this.addClipToTimeline(timeline.id, clip.source_job_id, clip.source_candidate_index, clip.label, clip.source_variant_id);
    const copied = result?.clips.at(-1);
    if (copied) this.updateClip(copied.id, { trimStart: clip.trim_start, trimEnd: clip.trim_end, volume: clip.volume });
    return this.getTimeline(timeline.id);
  }
  moveClip(clipId: string, targetId: string) {
    const clip = this.clip(clipId), target = this.resolveTimeline(targetId);
    if (!clip || !target) throw new Error("Clip o montaggio di destinazione non trovato");
    if (clip.timeline_id === target.id) return this.getTimeline(target.id);
    const targetDetail = this.getTimeline(target.id), now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE project_clips SET position = position - 1, updated_at = ? WHERE timeline_id = ? AND position > ?").run(now, clip.timeline_id, clip.position);
      this.database.prepare("UPDATE project_clips SET project_id = ?, timeline_id = ?, position = ?, updated_at = ? WHERE id = ?").run(target.project_id, target.id, targetDetail?.clips.length ?? 0, now, clipId);
      this.touchTimeline(clip.timeline_id, now); this.touchTimeline(target.id, now);
      this.touchProject(clip.project_id, now); this.touchProject(target.project_id, now);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.getTimeline(target.id);
  }
  reorderClip(clipId: string, positionValue: unknown) {
    const clip = this.clip(clipId);
    if (!clip) throw new Error("Clip non trovata");
    const timeline = this.getTimeline(clip.timeline_id);
    if (!timeline) throw new Error("Montaggio non trovato");
    const requested = Number(positionValue);
    if (!Number.isInteger(requested)) throw new Error("Posizione non valida");
    const position = Math.min(timeline.clips.length - 1, Math.max(0, requested));
    if (position === clip.position) return timeline;
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (position < clip.position) this.database.prepare("UPDATE project_clips SET position = position + 1, updated_at = ? WHERE timeline_id = ? AND position >= ? AND position < ?").run(now, clip.timeline_id, position, clip.position);
      else this.database.prepare("UPDATE project_clips SET position = position - 1, updated_at = ? WHERE timeline_id = ? AND position > ? AND position <= ?").run(now, clip.timeline_id, clip.position, position);
      this.database.prepare("UPDATE project_clips SET position = ?, updated_at = ? WHERE id = ?").run(position, now, clipId);
      this.touchTimeline(clip.timeline_id, now); this.touchProject(clip.project_id, now);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.getTimeline(clip.timeline_id);
  }
  removeClip(clipId: string) {
    const clip = this.clip(clipId);
    if (!clip) throw new Error("Clip non trovata");
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM project_clips WHERE id = ?").run(clipId);
      this.database.prepare(
        "UPDATE project_clips SET position = position - 1, updated_at = ? WHERE timeline_id = ? AND position > ?",
      ).run(now, clip.timeline_id, clip.position);
      this.touchTimeline(clip.timeline_id, now);
      this.touchProject(clip.project_id, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTimeline(clip.timeline_id);
  }
  private resolveTimeline(timelineOrProjectId: string) {
    return this.timelineRow(timelineOrProjectId) ?? this.timelineRow(this.listTimelines(timelineOrProjectId)[0]?.id ?? "");
  }
  private timelineRow(timelineId: string) {
    return this.database.prepare(
      `SELECT project_timelines.*, projects.name AS project_name,
       (SELECT COUNT(*) FROM project_clips WHERE project_clips.timeline_id = project_timelines.id) AS clip_count
       FROM project_timelines JOIN projects ON projects.id = project_timelines.project_id
       WHERE project_timelines.id = ?`
    ).get(timelineId) as TimelineRow | undefined;
  }
  private clip(clipId: string) {
    return this.database.prepare("SELECT * FROM project_clips WHERE id = ?").get(clipId) as {
      id: string; project_id: string; timeline_id: string; source_job_id: string;
      source_candidate_index: number; position: number; label: string;
      source_variant_id: string | null;
      trim_start: number; trim_end: number | null; volume: number;
    } | undefined;
  }
  private resolveVariant(jobId: string, candidateIndex: number, value: unknown) {
    if (value === undefined || value === null || value === "" || value === "original") return null;
    if (typeof value !== "string" || value.length > 80) throw new Error("Variante non valida");
    const variant = this.database.prepare(
      `SELECT id FROM candidate_variants
       WHERE id = ? AND source_job_id = ? AND source_candidate_index = ?
         AND status = 'ready' AND output_filename IS NOT NULL`,
    ).get(value, jobId, candidateIndex) as { id: string } | undefined;
    if (!variant) throw new Error("La variante scelta non è pronta o non appartiene alla clip");
    return variant.id;
  }
  private clipVariants(jobId: string, candidateIndex: number) {
    const rows = this.database.prepare(
      `SELECT id, kind, source_variant_id, target_megapixels,
              status, output_filename, output_subfolder, output_type, output_format,
              created_at, updated_at
       FROM candidate_variants
       WHERE source_job_id = ? AND source_candidate_index = ?
         AND status = 'ready' AND output_filename IS NOT NULL
       ORDER BY created_at DESC`,
    ).all(jobId, candidateIndex) as unknown as Array<{
      id: string; kind: "face" | "upscale" | "face_upscale";
      source_variant_id: string | null; target_megapixels: 1 | 2 | null;
      status: string; created_at: string; updated_at: string;
      output_filename: string; output_subfolder: string | null;
      output_type: MediaOutput["type"]; output_format: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      sourceVariantId: row.source_variant_id,
      targetMegapixels: row.target_megapixels
        ?? (row.kind === "upscale" || row.kind === "face_upscale" ? 1 : null),
      processingSeconds: processingSeconds(
        row.created_at,
        row.updated_at,
        row.status === "ready" || row.status === "failed",
      ),
      output: mediaFromClip({
        output_filename: row.output_filename,
        output_subfolder: row.output_subfolder,
        output_type: row.output_type,
        output_format: row.output_format,
      } as ClipRow),
    }));
  }
  private projectExists(projectId: string) { return Boolean(this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)); }
  private touchProject(projectId: string, now = new Date().toISOString()) { this.database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId); }
  private touchTimeline(timelineId: string, now = new Date().toISOString()) { this.database.prepare("UPDATE project_timelines SET updated_at = ? WHERE id = ?").run(now, timelineId); }
  close() { this.database.close(); }
}
