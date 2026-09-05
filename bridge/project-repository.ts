import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { MediaOutput } from "./studio-job.js";
import { processingSeconds } from "./processing-time.js";

type ProjectRow = {
  id: string; name: string; created_at: string; updated_at: string;
  clip_count: number; timeline_count: number; job_count: number; image_count: number;
  audio_count: number; external_media_count: number;
};

type ProjectDeletionCandidate = { job_id: string; candidate_index: number };
type ProjectDeletionExternalMedia = { id: string; file: string };
type TimelineRow = {
  id: string; project_id: string; project_name: string; name: string;
  external_audio_file: string | null; external_audio_name: string | null;
  original_audio_gain: number; external_audio_gain: number; external_audio_loop: number;
  created_at: string; updated_at: string; clip_count: number;
};
type ClipRow = {
  id: string; project_id: string; timeline_id: string; source_job_id: string | null;
  source_candidate_index: number | null; source_variant_id: string | null;
  external_media_id: string | null; external_file: string | null;
  external_name: string | null; external_original_name: string | null;
  external_kind: "picture" | "video" | "audio" | null; external_has_audio: number | null;
  variant_kind: "face" | "upscale" | "face_upscale" | null;
  variant_target_megapixels: 1 | 2 | null;
  position: number; label: string; created_at: string;
  seed: string | null; source_duration: number; trim_start: number; trim_end: number | null;
  volume: number; crop_x: number; crop_y: number; crop_zoom: number;
  crop_width: number; crop_height: number; crop_aspect: string; source_aspect_format: string;
  output_filename: string | null; output_subfolder: string | null;
  output_type: MediaOutput["type"] | null; output_format: string | null;
  candidate_status: string | null; candidate_created_at: string | null; candidate_updated_at: string | null;
  variant_status: string | null; variant_created_at: string | null;
  variant_updated_at: string | null;
};
type AudioTrackRow = {
  id: string; timeline_id: string; position: number; file: string; name: string;
  source_duration: number | null; start_time: number; trim_start: number;
  trim_end: number | null; gain: number; muted: number; solo: number; loop: number;
  fade_in: number; fade_out: number; created_at: string; updated_at: string;
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
const CROP_ASPECTS = new Set(["original", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"]);
function ratioFromFormat(value: string, fallback = 16 / 9) {
  const match = /(^|\D)(\d+):(\d+)(\D|$)/.exec(value);
  if (!match) return fallback;
  const width = Number(match[2]), height = Number(match[3]);
  return width > 0 && height > 0 ? width / height : fallback;
}
function centeredCrop(sourceFormat: string, aspect: string) {
  if (aspect === "original") return { width: 1, height: 1, x: 0, y: 0 };
  const sourceRatio = ratioFromFormat(sourceFormat);
  const targetRatio = ratioFromFormat(aspect, sourceRatio);
  const width = targetRatio >= sourceRatio ? 1 : targetRatio / sourceRatio;
  const height = targetRatio >= sourceRatio ? sourceRatio / targetRatio : 1;
  return { width, height, x: (1 - width) / 2, y: (1 - height) / 2 };
}
function canonicalAspect(sourceFormat: string) {
  const sourceRatio = ratioFromFormat(sourceFormat);
  return ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"]
    .find((aspect) => Math.abs(ratioFromFormat(aspect) - sourceRatio) < 0.015) ?? "original";
}
function inferredMediaFormat(filename: string) {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webm") return "video/webm";
  if (extension === "mov") return "video/quicktime";
  if (extension === "mkv") return "video/x-matroska";
  return "video/mp4";
}
function annotatedMedia(file: string): MediaOutput {
  const match = /^(.*?)(?: \[(input|output|temp)\])?$/.exec(file.trim());
  const annotatedPath = (match?.[1] ?? file).replace(/\\/g, "/");
  const type = (match?.[2] ?? "input") as MediaOutput["type"];
  const slash = annotatedPath.lastIndexOf("/");
  const filename = slash >= 0 ? annotatedPath.slice(slash + 1) : annotatedPath;
  const subfolder = slash >= 0 ? annotatedPath.slice(0, slash) : "";
  const query = new URLSearchParams({ filename, subfolder, type });
  return { filename, subfolder, type, format: inferredMediaFormat(filename), mediaPath: `/api/media?${query.toString()}` };
}
function mediaFromClip(row: ClipRow): MediaOutput {
  if (row.external_media_id && row.external_file) return annotatedMedia(row.external_file);
  if (!row.output_filename || !row.output_type) throw new Error("File sorgente della clip non disponibile");
  const subfolder = row.output_subfolder ?? "";
  const query = new URLSearchParams({ filename: row.output_filename, subfolder, type: row.output_type });
  return { filename: row.output_filename, subfolder, type: row.output_type, format: row.output_format ?? "video/mp4", mediaPath: `/api/media?${query.toString()}` };
}
function mapClip(row: ClipRow) {
  return {
    id: row.id, projectId: row.project_id, timelineId: row.timeline_id,
    sourceKind: row.external_media_id ? "external" as const : "generated" as const,
    sourceJobId: row.source_job_id, sourceCandidateIndex: row.source_candidate_index,
    externalMediaId: row.external_media_id,
    mediaKind: row.external_kind === "picture" ? "image" as const : "video" as const,
    isStillImage: row.external_kind === "picture",
    sourceVariantId: row.source_variant_id, variantKind: row.variant_kind ?? "original",
    targetMegapixels: row.variant_target_megapixels
      ?? (row.variant_kind === "upscale" || row.variant_kind === "face_upscale" ? 1 : null),
    position: row.position, label: row.label, createdAt: row.created_at,
    seed: row.seed === null ? null : Number(row.seed), sourceDuration: row.source_duration,
    hasAudio: row.external_media_id ? row.external_has_audio === 1 : true,
    trimStart: row.trim_start, trimEnd: row.trim_end ?? row.source_duration,
    volume: row.volume, cropX: row.crop_x, cropY: row.crop_y, cropZoom: row.crop_zoom,
    cropWidth: row.crop_width, cropHeight: row.crop_height, cropAspect: row.crop_aspect,
    sourceAspectFormat: row.source_aspect_format,
    processingSeconds: row.external_media_id ? null : row.source_variant_id
      ? processingSeconds(
          row.variant_created_at ?? "",
          row.variant_updated_at ?? "",
          row.variant_status === "ready" || row.variant_status === "failed",
        )
      : processingSeconds(
          row.candidate_created_at ?? "",
          row.candidate_updated_at ?? "",
          row.candidate_status === "ready" || row.candidate_status === "failed",
        ),
    output: mediaFromClip(row),
  };
}
function mapAudioTrack(row: AudioTrackRow) {
  return {
    id: row.id, timelineId: row.timeline_id, position: row.position,
    file: row.file, name: row.name, sourceDuration: row.source_duration,
    startTime: row.start_time, trimStart: row.trim_start,
    trimEnd: row.trim_end ?? row.source_duration, gain: row.gain,
    muted: Boolean(row.muted), solo: Boolean(row.solo), loop: Boolean(row.loop),
    fadeIn: row.fade_in, fadeOut: row.fade_out,
    createdAt: row.created_at, updatedAt: row.updated_at,
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
       (SELECT COUNT(*) FROM project_image_links WHERE project_image_links.project_id = projects.id) AS image_count,
       (SELECT COUNT(*) FROM audio_jobs WHERE audio_jobs.project_id = projects.id) AS audio_count,
       (SELECT COUNT(*) FROM external_media WHERE external_media.origin_project_id = projects.id) AS external_media_count
       FROM projects ORDER BY projects.updated_at DESC`
    ).all() as unknown as ProjectRow[];
    return rows.map(row => ({ id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at, clipCount: row.clip_count, timelineCount: row.timeline_count, jobCount: row.job_count, imageCount: row.image_count, audioCount: row.audio_count, externalMediaCount: row.external_media_count }));
  }
  get(projectId: string) {
    const row = this.database.prepare(
      `SELECT projects.id, projects.name, projects.created_at, projects.updated_at,
       (SELECT COUNT(*) FROM project_clips WHERE project_clips.project_id = projects.id) AS clip_count,
       (SELECT COUNT(*) FROM project_timelines WHERE project_timelines.project_id = projects.id) AS timeline_count,
       (SELECT COUNT(*) FROM jobs WHERE jobs.project_id = projects.id) AS job_count,
       (SELECT COUNT(*) FROM project_image_links WHERE project_image_links.project_id = projects.id) AS image_count,
       (SELECT COUNT(*) FROM audio_jobs WHERE audio_jobs.project_id = projects.id) AS audio_count,
       (SELECT COUNT(*) FROM external_media WHERE external_media.origin_project_id = projects.id) AS external_media_count
       FROM projects WHERE projects.id = ?`
    ).get(projectId) as ProjectRow | undefined;
    if (!row) return null;
    const timelines = this.listTimelines(projectId);
    return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at, clipCount: row.clip_count, timelineCount: row.timeline_count, jobCount: row.job_count, imageCount: row.image_count, audioCount: row.audio_count, externalMediaCount: row.external_media_count, timelines, clips: timelines[0] ? this.getTimeline(timelines[0].id)?.clips ?? [] : [] };
  }

  deletionPlan(projectId: string) {
    const project = this.get(projectId);
    if (!project) throw new Error("Progetto non trovato");

    const videoCandidates = this.database.prepare(
      `SELECT candidates.job_id, candidates.candidate_index
       FROM candidates
       JOIN jobs ON jobs.id = candidates.job_id
       WHERE jobs.project_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM project_clips
           WHERE project_clips.source_job_id = jobs.id
             AND project_clips.project_id <> ?
         )
       ORDER BY candidates.job_id, candidates.candidate_index DESC`,
    ).all(projectId, projectId) as unknown as ProjectDeletionCandidate[];
    const imageCandidates = this.database.prepare(
      `SELECT image_candidates.job_id, image_candidates.candidate_index
       FROM image_candidates
       JOIN image_jobs ON image_jobs.id = image_candidates.job_id
       WHERE image_jobs.origin_project_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM project_image_links
           WHERE project_image_links.image_job_id = image_candidates.job_id
             AND project_image_links.image_candidate_index = image_candidates.candidate_index
             AND project_image_links.project_id <> ?
         )
       ORDER BY image_candidates.job_id, image_candidates.candidate_index DESC`,
    ).all(projectId, projectId) as unknown as ProjectDeletionCandidate[];
    const audioJobs = (
      this.database.prepare("SELECT id FROM audio_jobs WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as unknown as Array<{ id: string }>
    ).map((row) => row.id);

    const busyVideo = this.database.prepare(
      `SELECT COUNT(*) AS count
       FROM candidates
       JOIN jobs ON jobs.id = candidates.job_id
       WHERE jobs.project_id = ?
         AND candidates.status NOT IN ('ready', 'failed')
         AND NOT EXISTS (
           SELECT 1 FROM project_clips
           WHERE project_clips.source_job_id = jobs.id
             AND project_clips.project_id <> ?
         )`,
    ).get(projectId, projectId) as { count: number };
    const busyVariants = this.database.prepare(
      `SELECT COUNT(*) AS count
       FROM candidate_variants
       JOIN jobs ON jobs.id = candidate_variants.source_job_id
       WHERE jobs.project_id = ?
         AND candidate_variants.status NOT IN ('ready', 'failed')
         AND NOT EXISTS (
           SELECT 1 FROM project_clips
           WHERE project_clips.source_job_id = jobs.id
             AND project_clips.project_id <> ?
         )`,
    ).get(projectId, projectId) as { count: number };
    const busyImages = this.database.prepare(
      `SELECT COUNT(*) AS count
       FROM image_candidates
       JOIN image_jobs ON image_jobs.id = image_candidates.job_id
       WHERE image_jobs.origin_project_id = ?
         AND image_candidates.status NOT IN ('ready', 'failed', 'cancelled')
         AND NOT EXISTS (
           SELECT 1 FROM project_image_links
           WHERE project_image_links.image_job_id = image_candidates.job_id
             AND project_image_links.image_candidate_index = image_candidates.candidate_index
             AND project_image_links.project_id <> ?
         )`,
    ).get(projectId, projectId) as { count: number };
    const busyAudio = this.database.prepare(
      `SELECT COUNT(*) AS count FROM audio_jobs
       WHERE project_id = ? AND status NOT IN ('ready', 'failed', 'cancelled')`,
    ).get(projectId) as { count: number };

    const externalRows = this.database.prepare(
      "SELECT id, file FROM external_media WHERE origin_project_id = ? ORDER BY created_at",
    ).all(projectId) as unknown as ProjectDeletionExternalMedia[];
    const externalMedia = externalRows.filter((media) => !this.externalMediaUsedOutsideProject(media, projectId));
    const preservedExternalMedia = externalRows.length - externalMedia.length;
    const preservedVideoJobs = Number((this.database.prepare(
      `SELECT COUNT(*) AS count FROM jobs
       WHERE project_id = ? AND EXISTS (
         SELECT 1 FROM project_clips
         WHERE project_clips.source_job_id = jobs.id
           AND project_clips.project_id <> ?
       )`,
    ).get(projectId, projectId) as { count: number }).count);
    const preservedImageCandidates = Number((this.database.prepare(
      `SELECT COUNT(*) AS count
       FROM image_candidates
       JOIN image_jobs ON image_jobs.id = image_candidates.job_id
       WHERE image_jobs.origin_project_id = ? AND EXISTS (
         SELECT 1 FROM project_image_links
         WHERE project_image_links.image_job_id = image_candidates.job_id
           AND project_image_links.image_candidate_index = image_candidates.candidate_index
           AND project_image_links.project_id <> ?
       )`,
    ).get(projectId, projectId) as { count: number }).count);

    return {
      project,
      videoCandidates,
      imageCandidates,
      audioJobs,
      externalMedia,
      busy: {
        video: Number(busyVideo.count) + Number(busyVariants.count),
        image: Number(busyImages.count),
        audio: Number(busyAudio.count),
      },
      preserved: {
        videoJobs: preservedVideoJobs,
        imageCandidates: preservedImageCandidates,
        externalMedia: preservedExternalMedia,
      },
    };
  }

  delete(projectId: string) {
    const project = this.get(projectId);
    if (!project) throw new Error("Progetto non trovato");
    const remainingVideoCandidates = this.database.prepare(
      `SELECT COUNT(*) AS count FROM candidates JOIN jobs ON jobs.id = candidates.job_id
       WHERE jobs.project_id = ? AND NOT EXISTS (
         SELECT 1 FROM project_clips
         WHERE project_clips.source_job_id = jobs.id AND project_clips.project_id <> ?
       )`,
    ).get(projectId, projectId) as { count: number };
    const remainingImageCandidates = this.database.prepare(
      `SELECT COUNT(*) AS count FROM image_candidates
       JOIN image_jobs ON image_jobs.id = image_candidates.job_id
       WHERE image_jobs.origin_project_id = ? AND NOT EXISTS (
         SELECT 1 FROM project_image_links
         WHERE project_image_links.image_job_id = image_candidates.job_id
           AND project_image_links.image_candidate_index = image_candidates.candidate_index
           AND project_image_links.project_id <> ?
       )`,
    ).get(projectId, projectId) as { count: number };
    if (Number(remainingVideoCandidates.count) > 0 || Number(remainingImageCandidates.count) > 0) {
      throw new Error("Pulizia media incompleta: il progetto non è stato eliminato");
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `UPDATE jobs SET project_id = (
           SELECT project_clips.project_id FROM project_clips
           WHERE project_clips.source_job_id = jobs.id
             AND project_clips.project_id <> ?
           ORDER BY project_clips.created_at LIMIT 1
         ) WHERE project_id = ? AND EXISTS (
           SELECT 1 FROM project_clips
           WHERE project_clips.source_job_id = jobs.id
             AND project_clips.project_id <> ?
         )`,
      ).run(projectId, projectId, projectId);
      this.database.prepare(
        `DELETE FROM jobs WHERE project_id = ? AND NOT EXISTS (
           SELECT 1 FROM project_clips
           WHERE project_clips.source_job_id = jobs.id
             AND project_clips.project_id <> ?
         )`,
      ).run(projectId, projectId);
      this.database.prepare(
        `UPDATE image_jobs SET origin_project_id = (
           SELECT project_image_links.project_id FROM project_image_links
           WHERE project_image_links.image_job_id = image_jobs.id
             AND project_image_links.project_id <> ?
           ORDER BY project_image_links.created_at LIMIT 1
         ) WHERE origin_project_id = ? AND EXISTS (
           SELECT 1 FROM project_image_links
           WHERE project_image_links.image_job_id = image_jobs.id
             AND project_image_links.project_id <> ?
         )`,
      ).run(projectId, projectId, projectId);
      this.database.prepare(
        `DELETE FROM image_jobs WHERE origin_project_id = ? AND NOT EXISTS (
           SELECT 1 FROM project_image_links
           WHERE project_image_links.image_job_id = image_jobs.id
             AND project_image_links.project_id <> ?
         )`,
      ).run(projectId, projectId);
      const result = this.database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
      if (result.changes !== 1) throw new Error("Progetto non trovato");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { id: project.id, name: project.name };
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
       project_clips.external_media_id, external_media.file AS external_file,
       external_media.name AS external_name, external_media.original_name AS external_original_name,
       external_media.kind AS external_kind, external_media.has_audio AS external_has_audio,
       project_clips.source_variant_id, candidate_variants.kind AS variant_kind,
       candidate_variants.target_megapixels AS variant_target_megapixels,
       project_clips.label, project_clips.created_at, project_clips.trim_start,
       project_clips.trim_end, project_clips.volume, project_clips.crop_x,
       project_clips.crop_y, project_clips.crop_zoom, project_clips.crop_width,
       project_clips.crop_height, project_clips.crop_aspect,
       COALESCE(
         jobs.aspect_format,
         CASE WHEN external_media.width > 0 AND external_media.height > 0
           THEN CAST(external_media.width AS TEXT) || ':' || CAST(external_media.height AS TEXT)
           ELSE '16:9 landscape'
         END
       ) AS source_aspect_format,
       candidates.seed,
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
       COALESCE(project_clips.source_duration_override, jobs.duration_seconds * jobs.shot_count, external_media.duration, 0) AS source_duration
       FROM project_clips LEFT JOIN candidates ON candidates.job_id = project_clips.source_job_id
       AND candidates.candidate_index = project_clips.source_candidate_index
       LEFT JOIN candidate_variants ON candidate_variants.id = project_clips.source_variant_id
       LEFT JOIN jobs ON jobs.id = project_clips.source_job_id
       LEFT JOIN external_media ON external_media.id = project_clips.external_media_id
       WHERE project_clips.timeline_id = ? ORDER BY project_clips.position, project_clips.created_at`
    ).all(timelineId) as unknown as ClipRow[];
    return {
      ...mapTimeline(timeline),
      clips: rows.map((row) => ({
        ...mapClip(row),
        variants: row.source_job_id !== null && row.source_candidate_index !== null
          ? this.clipVariants(row.source_job_id, row.source_candidate_index)
          : [],
      })),
      audioTracks: this.listAudioTracks(timelineId),
    };
  }
  listAudioTracks(timelineId: string) {
    return (this.database.prepare(
      "SELECT * FROM timeline_audio_tracks WHERE timeline_id = ? ORDER BY position",
    ).all(timelineId) as unknown as AudioTrackRow[]).map(mapAudioTrack);
  }
  upsertAudioTrack(timelineId: string, positionValue: unknown, value: {
    file?: unknown; name?: unknown; sourceDuration?: unknown; startTime?: unknown;
    trimStart?: unknown; trimEnd?: unknown; gain?: unknown; muted?: unknown;
    solo?: unknown; loop?: unknown; fadeIn?: unknown; fadeOut?: unknown;
  }) {
    const timeline = this.timelineRow(timelineId);
    if (!timeline) throw new Error("Montaggio non trovato");
    const position = Number(positionValue);
    if (!Number.isInteger(position) || position < 0 || position > 7) throw new Error("Posizione traccia non valida");
    const existing = this.database.prepare(
      "SELECT * FROM timeline_audio_tracks WHERE timeline_id = ? AND position = ?",
    ).get(timelineId, position) as AudioTrackRow | undefined;
    if (value.file === null || value.file === "") {
      if (existing) this.database.prepare("DELETE FROM timeline_audio_tracks WHERE id = ?").run(existing.id);
      const now = new Date().toISOString();
      this.touchTimeline(timelineId, now); this.touchProject(timeline.project_id, now);
      return this.getTimeline(timelineId);
    }
    const file = value.file === undefined ? existing?.file : typeof value.file === "string" ? value.file.trim() : "";
    if (!file) throw new Error("File audio mancante");
    const rawName = value.name === undefined ? existing?.name ?? `Traccia audio ${position + 1}` : value.name;
    const name = typeof rawName === "string" ? rawName.trim().slice(0, 160) : "";
    if (!name) throw new Error("Nome traccia non valido");
    const sourceDuration = value.sourceDuration === undefined
      ? existing?.source_duration ?? null
      : value.sourceDuration === null || value.sourceDuration === "" ? null : numberBetween(value.sourceDuration, 0.01, 21600, "Durata audio");
    const startTime = value.startTime === undefined ? existing?.start_time ?? 0 : numberBetween(value.startTime, 0, 21600, "Posizione audio");
    const trimStart = value.trimStart === undefined ? existing?.trim_start ?? 0 : numberBetween(value.trimStart, 0, sourceDuration ?? 21600, "Inizio trim audio");
    const defaultEnd = existing?.trim_end ?? sourceDuration;
    const trimEnd = value.trimEnd === undefined ? defaultEnd : value.trimEnd === null || value.trimEnd === "" ? null : numberBetween(value.trimEnd, 0.01, sourceDuration ?? 21600, "Fine trim audio");
    if (trimEnd !== null && trimEnd - trimStart < 0.05) throw new Error("La traccia audio deve durare almeno 0,05 secondi");
    const gain = value.gain === undefined ? existing?.gain ?? 1 : numberBetween(value.gain, 0, 2, "Volume traccia");
    const fadeIn = value.fadeIn === undefined ? existing?.fade_in ?? 0 : numberBetween(value.fadeIn, 0, 21600, "Fade in");
    const fadeOut = value.fadeOut === undefined ? existing?.fade_out ?? 0 : numberBetween(value.fadeOut, 0, 21600, "Fade out");
    const muted = value.muted === undefined ? existing?.muted ?? 0 : value.muted ? 1 : 0;
    const solo = value.solo === undefined ? existing?.solo ?? 0 : value.solo ? 1 : 0;
    const loop = value.loop === undefined ? existing?.loop ?? 0 : value.loop ? 1 : 0;
    const now = new Date().toISOString();
    if (existing) {
      this.database.prepare(
        `UPDATE timeline_audio_tracks SET file = ?, name = ?, source_duration = ?, start_time = ?,
         trim_start = ?, trim_end = ?, gain = ?, muted = ?, solo = ?, loop = ?, fade_in = ?, fade_out = ?, updated_at = ?
         WHERE id = ?`,
      ).run(file, name, sourceDuration, startTime, trimStart, trimEnd, gain, muted, solo, loop, fadeIn, fadeOut, now, existing.id);
    } else {
      this.database.prepare(
        `INSERT INTO timeline_audio_tracks(
           id, timeline_id, position, file, name, source_duration, start_time, trim_start,
           trim_end, gain, muted, solo, loop, fade_in, fade_out, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), timelineId, position, file, name, sourceDuration, startTime, trimStart, trimEnd, gain, muted, solo, loop, fadeIn, fadeOut, now, now);
    }
    this.touchTimeline(timelineId, now); this.touchProject(timeline.project_id, now);
    return this.getTimeline(timelineId);
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
  setTimelineCropAspect(timelineId: string, aspectValue: unknown) {
    const timeline = this.timelineRow(timelineId);
    if (!timeline) throw new Error("Montaggio non trovato");
    const aspect = String(aspectValue ?? "");
    if (!CROP_ASPECTS.has(aspect)) throw new Error("Rapporto crop non valido");
    const clips = this.database.prepare(
      `SELECT project_clips.id, COALESCE(
         jobs.aspect_format,
         CASE WHEN external_media.width > 0 AND external_media.height > 0
           THEN CAST(external_media.width AS TEXT) || ':' || CAST(external_media.height AS TEXT)
           ELSE '16:9 landscape'
         END
       ) AS aspect_format
       FROM project_clips
       LEFT JOIN jobs ON jobs.id = project_clips.source_job_id
       LEFT JOIN external_media ON external_media.id = project_clips.external_media_id
       WHERE project_clips.timeline_id = ?`,
    ).all(timelineId) as unknown as Array<{ id: string; aspect_format: string }>;
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.database.prepare(
        `UPDATE project_clips SET crop_x = ?, crop_y = ?, crop_zoom = ?,
         crop_width = ?, crop_height = ?, crop_aspect = ?, updated_at = ? WHERE id = ?`,
      );
      for (const clip of clips) {
        const crop = centeredCrop(clip.aspect_format, aspect);
        update.run(crop.x, crop.y, Math.min(crop.width, crop.height), crop.width, crop.height, aspect, now, clip.id);
      }
      this.touchTimeline(timelineId, now); this.touchProject(timeline.project_id, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
    const candidate = this.database.prepare(
      `SELECT candidates.status, candidates.output_filename, jobs.aspect_format
       FROM candidates JOIN jobs ON jobs.id = candidates.job_id
       WHERE candidates.job_id = ? AND candidates.candidate_index = ?`,
    ).get(jobId, candidateIndex) as { status: string; output_filename: string | null; aspect_format: string } | undefined;
    if (!candidate || candidate.status !== "ready" || !candidate.output_filename) throw new Error("Il candidato deve essere completato e avere un video");
    const variantId = this.resolveVariant(jobId, candidateIndex, variantValue);
    const position = timeline.clips.length, id = randomUUID(), now = new Date().toISOString();
    const label = normalizeLabel(labelValue, `Clip ${position + 1}`);
    const firstClip = timeline.clips[0];
    const cropAspect = firstClip
      ? firstClip.cropAspect === "original" ? canonicalAspect(firstClip.sourceAspectFormat) : firstClip.cropAspect
      : "original";
    const crop = centeredCrop(candidate.aspect_format, cropAspect);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT INTO project_clips(id, project_id, timeline_id, source_job_id,
         source_candidate_index, source_variant_id, position, label, crop_x, crop_y,
         crop_zoom, crop_width, crop_height, crop_aspect, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, timeline.projectId, timelineId, jobId, candidateIndex, variantId, position,
        label, crop.x, crop.y, Math.min(crop.width, crop.height), crop.width,
        crop.height, cropAspect, now, now,
      );
      this.database.prepare("UPDATE jobs SET project_id = ?, updated_at = ? WHERE id = ?").run(timeline.projectId, now, jobId);
      this.touchTimeline(timelineId, now); this.touchProject(timeline.projectId, now);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.getTimeline(timelineId);
  }
  addExternalClipToTimeline(timelineId: string, externalMediaId: string, labelValue?: unknown, durationValue?: unknown) {
    const timeline = this.getTimeline(timelineId);
    if (!timeline) throw new Error("Montaggio non trovato");
    const media = this.database.prepare(
      `SELECT id, kind, original_name, duration, width, height
       FROM external_media WHERE id = ?`,
    ).get(externalMediaId) as {
      id: string; kind: string; original_name: string; duration: number | null;
      width: number | null; height: number | null;
    } | undefined;
    if (!media || (media.kind !== "video" && media.kind !== "picture")) {
      throw new Error("Seleziona un video o un'immagine validi");
    }
    const isStillImage = media.kind === "picture";
    const duration = isStillImage
      ? numberBetween(durationValue ?? 5, 0.5, 600, "Durata slide")
      : media.duration;
    if (!duration || duration <= 0.05) {
      throw new Error("Durata del video non disponibile: prova a caricarlo di nuovo");
    }
    const position = timeline.clips.length, id = randomUUID(), now = new Date().toISOString();
    const fallbackLabel = media.original_name.replace(/\.[^.]+$/, "")
      || `${isStillImage ? "Slide" : "Video esterno"} ${position + 1}`;
    const label = normalizeLabel(labelValue, fallbackLabel);
    const firstClip = timeline.clips[0];
    const cropAspect = firstClip
      ? firstClip.cropAspect === "original" ? canonicalAspect(firstClip.sourceAspectFormat) : firstClip.cropAspect
      : "original";
    const sourceAspect = media.width && media.height ? `${media.width}:${media.height}` : "16:9 landscape";
    const crop = centeredCrop(sourceAspect, cropAspect);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT INTO project_clips(
           id, project_id, timeline_id, source_job_id, source_candidate_index,
           source_variant_id, external_media_id, position, label, trim_end,
           source_duration_override,
           crop_x, crop_y, crop_zoom, crop_width, crop_height, crop_aspect,
           created_at, updated_at
         ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, timeline.projectId, timelineId, media.id, position, label, duration,
        isStillImage ? duration : null,
        crop.x, crop.y, Math.min(crop.width, crop.height), crop.width, crop.height,
        cropAspect, now, now,
      );
      this.touchTimeline(timelineId, now); this.touchProject(timeline.projectId, now);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.getTimeline(timelineId);
  }
  updateClip(clipId: string, value: {
    trimStart?: unknown; trimEnd?: unknown; volume?: unknown; variantId?: unknown;
    durationSeconds?: unknown;
    cropX?: unknown; cropY?: unknown; cropZoom?: unknown; cropWidth?: unknown;
    cropHeight?: unknown; cropAspect?: unknown;
  }) {
    const clip = this.clip(clipId);
    if (!clip) throw new Error("Clip non trovata");
    const durationRow = this.database.prepare(
      `SELECT COALESCE(project_clips.source_duration_override, jobs.duration_seconds * jobs.shot_count, external_media.duration) AS source_duration
       FROM project_clips
       LEFT JOIN jobs ON jobs.id = project_clips.source_job_id
       LEFT JOIN external_media ON external_media.id = project_clips.external_media_id
       WHERE project_clips.id = ?`,
    ).get(clipId) as { source_duration: number | null } | undefined;
    if (!durationRow?.source_duration) throw new Error("Sorgente della clip non trovata");
    const durationOverride = clip.source_duration_override === null
      ? null
      : value.durationSeconds === undefined
        ? clip.source_duration_override
        : numberBetween(value.durationSeconds, 0.5, 600, "Durata slide");
    const sourceDuration = durationOverride ?? durationRow.source_duration;
    const trimStart = durationOverride !== null
      ? 0
      : value.trimStart === undefined ? clip.trim_start : numberBetween(value.trimStart, 0, sourceDuration - 0.05, "Inizio trim");
    const trimEnd = durationOverride !== null
      ? durationOverride
      : value.trimEnd === undefined || value.trimEnd === null || value.trimEnd === "" ? clip.trim_end ?? sourceDuration : numberBetween(value.trimEnd, 0.05, sourceDuration, "Fine trim");
    if (trimEnd - trimStart < 0.05) throw new Error("La clip deve durare almeno 0,05 secondi");
    const volume = value.volume === undefined ? clip.volume : numberBetween(value.volume, 0, 2, "Volume clip");
    const legacyZoom = value.cropZoom === undefined ? undefined : numberBetween(value.cropZoom, 0.1, 1, "Zoom crop");
    const cropWidth = value.cropWidth === undefined
      ? legacyZoom ?? clip.crop_width
      : numberBetween(value.cropWidth, 0.05, 1, "Larghezza crop");
    const cropHeight = value.cropHeight === undefined
      ? legacyZoom ?? clip.crop_height
      : numberBetween(value.cropHeight, 0.05, 1, "Altezza crop");
    const cropX = value.cropX === undefined
      ? Math.min(clip.crop_x, 1 - cropWidth)
      : numberBetween(value.cropX, 0, 1 - cropWidth, "Posizione crop orizzontale");
    const cropY = value.cropY === undefined
      ? Math.min(clip.crop_y, 1 - cropHeight)
      : numberBetween(value.cropY, 0, 1 - cropHeight, "Posizione crop verticale");
    const cropAspect = value.cropAspect === undefined ? clip.crop_aspect : String(value.cropAspect);
    if (!CROP_ASPECTS.has(cropAspect)) throw new Error("Rapporto crop non valido");
    if (clip.external_media_id && value.variantId !== undefined && value.variantId !== null && value.variantId !== "" && value.variantId !== "original") {
      throw new Error("I media esterni non hanno varianti di rendering");
    }
    const variantId = clip.external_media_id
      ? null
      : value.variantId === undefined
        ? clip.source_variant_id
        : this.resolveVariant(clip.source_job_id!, clip.source_candidate_index!, value.variantId);
    const now = new Date().toISOString();
    this.database.prepare(
      "UPDATE project_clips SET trim_start = ?, trim_end = ?, volume = ?, source_duration_override = ?, crop_x = ?, crop_y = ?, crop_zoom = ?, crop_width = ?, crop_height = ?, crop_aspect = ?, source_variant_id = ?, updated_at = ? WHERE id = ?",
    ).run(trimStart, trimEnd, volume, durationOverride, cropX, cropY, Math.min(cropWidth, cropHeight), cropWidth, cropHeight, cropAspect, variantId, now, clipId);
    this.touchTimeline(clip.timeline_id, now); this.touchProject(clip.project_id, now);
    return this.getTimeline(clip.timeline_id);
  }
  copyClip(clipId: string, targetId: string) {
    const clip = this.clip(clipId);
    if (!clip) throw new Error("Clip non trovata");
    const timeline = this.resolveTimeline(targetId);
    if (!timeline) throw new Error("Montaggio di destinazione non trovato");
    const result = clip.external_media_id
      ? this.addExternalClipToTimeline(timeline.id, clip.external_media_id, clip.label, clip.source_duration_override ?? undefined)
      : this.addClipToTimeline(timeline.id, clip.source_job_id!, clip.source_candidate_index!, clip.label, clip.source_variant_id);
    const copied = result?.clips.at(-1);
    if (copied) this.updateClip(copied.id, {
      trimStart: clip.trim_start,
      trimEnd: clip.trim_end,
      volume: clip.volume,
      ...(copied.cropAspect === clip.crop_aspect ? {
        cropX: clip.crop_x,
        cropY: clip.crop_y,
        cropWidth: clip.crop_width,
        cropHeight: clip.crop_height,
        cropAspect: clip.crop_aspect,
      } : {}),
    });
    return this.getTimeline(timeline.id);
  }
  moveClip(clipId: string, targetId: string) {
    const clip = this.clip(clipId), target = this.resolveTimeline(targetId);
    if (!clip || !target) throw new Error("Clip o montaggio di destinazione non trovato");
    if (clip.timeline_id === target.id) return this.getTimeline(target.id);
    const targetDetail = this.getTimeline(target.id), now = new Date().toISOString();
    const source = this.database.prepare(
      `SELECT COALESCE(
         jobs.aspect_format,
         CASE WHEN external_media.width > 0 AND external_media.height > 0
           THEN CAST(external_media.width AS TEXT) || ':' || CAST(external_media.height AS TEXT)
           ELSE '16:9 landscape'
         END
       ) AS aspect_format
       FROM project_clips
       LEFT JOIN jobs ON jobs.id = project_clips.source_job_id
       LEFT JOIN external_media ON external_media.id = project_clips.external_media_id
       WHERE project_clips.id = ?`,
    ).get(clipId) as { aspect_format: string } | undefined;
    const targetAspect = targetDetail?.clips[0]?.cropAspect ?? "original";
    const crop = centeredCrop(source?.aspect_format ?? "16:9 landscape", targetAspect);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE project_clips SET position = position - 1, updated_at = ? WHERE timeline_id = ? AND position > ?").run(now, clip.timeline_id, clip.position);
      this.database.prepare(
        `UPDATE project_clips SET project_id = ?, timeline_id = ?, position = ?,
         crop_x = ?, crop_y = ?, crop_zoom = ?, crop_width = ?, crop_height = ?,
         crop_aspect = ?, updated_at = ? WHERE id = ?`,
      ).run(
        target.project_id, target.id, targetDetail?.clips.length ?? 0,
        crop.x, crop.y, Math.min(crop.width, crop.height), crop.width, crop.height,
        targetAspect, now, clipId,
      );
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
      id: string; project_id: string; timeline_id: string; source_job_id: string | null;
      source_candidate_index: number | null; external_media_id: string | null;
      source_duration_override: number | null;
      position: number; label: string;
      source_variant_id: string | null;
      trim_start: number; trim_end: number | null; volume: number;
      crop_x: number; crop_y: number; crop_zoom: number;
      crop_width: number; crop_height: number; crop_aspect: string;
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
  private externalMediaUsedOutsideProject(media: ProjectDeletionExternalMedia, projectId: string) {
    const directReference = this.database.prepare(
      `SELECT 1
       WHERE EXISTS (SELECT 1 FROM creative_asset_references WHERE file = ?)
          OR EXISTS (
            SELECT 1 FROM project_clips
            WHERE project_clips.external_media_id = ?
              AND project_clips.project_id <> ?
          )
          OR EXISTS (SELECT 1 FROM audio_jobs WHERE project_id <> ? AND reference_file = ?)
          OR EXISTS (
            SELECT 1 FROM project_timelines
            WHERE project_id <> ? AND external_audio_file = ?
          )
          OR EXISTS (
            SELECT 1 FROM timeline_audio_tracks
            JOIN project_timelines ON project_timelines.id = timeline_audio_tracks.timeline_id
            WHERE project_timelines.project_id <> ? AND timeline_audio_tracks.file = ?
          )
          OR EXISTS (
            SELECT 1 FROM image_job_references
            JOIN image_jobs ON image_jobs.id = image_job_references.job_id
            WHERE image_job_references.file = ? AND (
              image_jobs.origin_project_id IS NULL
              OR image_jobs.origin_project_id <> ?
              OR EXISTS (
                SELECT 1 FROM project_image_links
                WHERE project_image_links.image_job_id = image_jobs.id
                  AND project_image_links.project_id <> ?
              )
            )
          )`,
    ).get(
      media.file,
      media.id,
      projectId,
      projectId,
      media.file,
      projectId,
      media.file,
      projectId,
      media.file,
      media.file,
      projectId,
      projectId,
    );
    if (directReference) return true;

    const needles = [media.id, media.file];
    const serializedRows = [
      ...(this.database.prepare(
        "SELECT media_state AS value FROM jobs WHERE project_id IS NULL OR project_id <> ?",
      ).all(projectId) as unknown as Array<{ value: string }>),
      ...(this.database.prepare(
        "SELECT attachments_json AS value FROM chat_messages WHERE project_id <> ?",
      ).all(projectId) as unknown as Array<{ value: string }>),
    ];
    return serializedRows.some((row) => needles.some((needle) => row.value.includes(needle)));
  }
  private projectExists(projectId: string) { return Boolean(this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)); }
  private touchProject(projectId: string, now = new Date().toISOString()) { this.database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId); }
  private touchTimeline(timelineId: string, now = new Date().toISOString()) { this.database.prepare("UPDATE project_timelines SET updated_at = ? WHERE id = ?").run(now, timelineId); }
  close() { this.database.close(); }
}
