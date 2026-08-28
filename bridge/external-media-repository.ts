import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type ExternalMediaKind = "picture" | "video" | "audio";

type ExternalMediaRow = {
  id: string;
  kind: ExternalMediaKind;
  file: string;
  name: string;
  original_name: string;
  source_key: string;
  size: number | null;
  duration: number | null;
  has_audio: number;
  width: number | null;
  height: number | null;
  origin_project_id: string | null;
  project_name: string | null;
  created_at: string;
  updated_at: string;
};

type UploadedMedia = {
  kind?: unknown;
  file?: unknown;
  name?: unknown;
  original?: unknown;
  size?: unknown;
  duration?: unknown;
  has_audio?: unknown;
  width?: unknown;
  height?: unknown;
};

function requiredText(value: unknown, field: string, maximum = 1_024) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum) throw new Error(`${field} non valido`);
  return normalized;
}

function optionalNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function mediaPath(file: string) {
  const match = /^(.*?)(?: \[(input|output|temp)\])?$/.exec(file.trim());
  const annotatedPath = (match?.[1] ?? file).replace(/\\/g, "/");
  const type = match?.[2] ?? "input";
  const slash = annotatedPath.lastIndexOf("/");
  const filename = slash >= 0 ? annotatedPath.slice(slash + 1) : annotatedPath;
  const subfolder = slash >= 0 ? annotatedPath.slice(0, slash) : "";
  return `/api/media?${new URLSearchParams({ filename, subfolder, type }).toString()}`;
}

function fromRow(row: ExternalMediaRow) {
  return {
    id: row.id,
    origin: "external" as const,
    kind: row.kind,
    file: row.file,
    name: row.name,
    originalName: row.original_name,
    size: row.size,
    duration: row.duration,
    hasAudio: row.has_audio === 1,
    width: row.width,
    height: row.height,
    originProjectId: row.origin_project_id,
    originProjectName: row.project_name,
    mediaPath: mediaPath(row.file),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ExternalMediaRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
  }

  list() {
    return (
      this.database
        .prepare(
          `SELECT external_media.*, projects.name AS project_name
           FROM external_media
           LEFT JOIN projects ON projects.id = external_media.origin_project_id
           ORDER BY external_media.updated_at DESC`,
        )
        .all() as unknown as ExternalMediaRow[]
    ).map(fromRow);
  }

  upsert(raw: UploadedMedia, originProjectId: string | null) {
    const kind = raw.kind;
    if (kind !== "picture" && kind !== "video" && kind !== "audio") {
      throw new Error("Tipo media esterno non valido");
    }
    const file = requiredText(raw.file, "File");
    const name = requiredText(raw.name, "Nome", 240);
    const originalName = typeof raw.original === "string" && raw.original.trim()
      ? raw.original.trim().slice(0, 240)
      : name;
    const size = optionalNumber(raw.size);
    const sourceKey = `${kind}:${originalName.toLocaleLowerCase("en-US")}:${size ?? "unknown"}`;
    const current = this.database
      .prepare("SELECT id FROM external_media WHERE source_key = ?")
      .get(sourceKey) as { id: string } | undefined;
    const now = new Date().toISOString();
    if (current) {
      this.database
        .prepare(
          `UPDATE external_media
           SET updated_at = ?, origin_project_id = COALESCE(origin_project_id, ?)
           WHERE id = ?`,
        )
        .run(now, originProjectId, current.id);
      return this.get(current.id)!;
    }
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO external_media(
          id, kind, file, name, original_name, source_key, size, duration,
          has_audio, width, height, origin_project_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        kind,
        file,
        name,
        originalName,
        sourceKey,
        size,
        optionalNumber(raw.duration),
        raw.has_audio === true ? 1 : 0,
        optionalNumber(raw.width),
        optionalNumber(raw.height),
        originProjectId,
        now,
        now,
      );
    return this.get(id)!;
  }

  get(id: string) {
    const row = this.database
      .prepare(
        `SELECT external_media.*, projects.name AS project_name
         FROM external_media
         LEFT JOIN projects ON projects.id = external_media.origin_project_id
         WHERE external_media.id = ?`,
      )
      .get(id) as ExternalMediaRow | undefined;
    return row ? fromRow(row) : null;
  }

  count() {
    return Number(
      (this.database.prepare("SELECT COUNT(*) AS count FROM external_media").get() as { count: number }).count,
    );
  }

  rename(id: string, value: unknown) {
    const name = requiredText(value, "Nome", 120);
    const result = this.database
      .prepare("UPDATE external_media SET original_name = ?, updated_at = ? WHERE id = ?")
      .run(name, new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error("Media esterno non trovato");
    return this.get(id)!;
  }

  delete(id: string) {
    const result = this.database.prepare("DELETE FROM external_media WHERE id = ?").run(id);
    if (result.changes !== 1) throw new Error("Media esterno non trovato");
  }

  close() {
    this.database.close();
  }
}
