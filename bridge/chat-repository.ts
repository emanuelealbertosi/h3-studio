import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type ChatAttachment = {
  kind: "picture" | "video" | "audio";
  file: string;
  name: string;
  mediaPath?: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  hasAudio?: boolean;
  remembered?: boolean;
};

export type ChatActionRecord = {
  type: "generate_video" | "generate_image" | "generate_minimax_image" | "edit_image" | "generate_anima" | "generate_tts" | "generate_music";
  prompt: string;
  videoEngine?: "h3" | "ltx25";
  jobId?: string;
  status: "started" | "failed";
  error?: string;
};

type ChatMessageRow = {
  sequence: number;
  id: string;
  project_id: string;
  conversation_id: string | null;
  role: "user" | "assistant";
  content: string;
  attachments_json: string;
  action_json: string | null;
  status: "pending" | "ready" | "failed";
  error: string | null;
  created_at: string;
};

type ChatConversationRow = {
  id: string;
  project_id: string;
  project_name?: string;
  title: string;
  title_is_auto: number;
  memory_summary: string;
  memory_sequence: number;
  created_at: string;
  updated_at: string;
  message_count?: number;
  last_message?: string | null;
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function present(row: ChatMessageRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    attachments: parseJson<ChatAttachment[]>(row.attachments_json, []),
    action: parseJson<ChatActionRecord | null>(row.action_json, null),
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    sequence: row.sequence,
  };
}

function normalizeTitle(value: unknown, fallback = "Nuova chat") {
  if (typeof value !== "string") return fallback;
  const title = value.replace(/\s+/g, " ").trim().slice(0, 80);
  return title || fallback;
}

function automaticTitle(content: string) {
  const cleaned = content
    .replace(/@[\wÀ-ÿ ._-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Nuova chat";
  const words = cleaned.split(" ").slice(0, 9).join(" ");
  const title = words.length < cleaned.length ? `${words}…` : words;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function presentConversation(row: ChatConversationRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? "",
    title: row.title,
    titleIsAuto: Boolean(row.title_is_auto),
    memoryActive: Boolean(row.memory_summary),
    messageCount: Number(row.message_count ?? 0),
    lastMessage: row.last_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ChatRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
  }

  private ensureProjectThread(projectId: string) {
    const project = this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Progetto Chat non trovato");
    const now = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO chat_threads(project_id, created_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO NOTHING`,
    ).run(projectId, now, now);
  }

  createConversation(projectId: string, titleValue?: unknown) {
    this.ensureProjectThread(projectId);
    const id = randomUUID();
    const now = new Date().toISOString();
    const title = normalizeTitle(titleValue);
    this.database.prepare(
      `INSERT INTO chat_conversations(
         id, project_id, title, title_is_auto, memory_summary, memory_sequence, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '', 0, ?, ?)`,
    ).run(id, projectId, title, title === "Nuova chat" ? 1 : 0, now, now);
    return this.getConversation(id)!;
  }

  getConversation(conversationId: string) {
    const row = this.database.prepare(
      `SELECT chat_conversations.*, projects.name AS project_name,
       (SELECT COUNT(*) FROM chat_messages
        WHERE chat_messages.conversation_id = chat_conversations.id) AS message_count,
       (SELECT content FROM chat_messages
        WHERE chat_messages.conversation_id = chat_conversations.id
        ORDER BY rowid DESC LIMIT 1) AS last_message
       FROM chat_conversations
       JOIN projects ON projects.id = chat_conversations.project_id
       WHERE chat_conversations.id = ?`,
    ).get(conversationId) as ChatConversationRow | undefined;
    return row ? presentConversation(row) : null;
  }

  listConversations(projectId?: string | null) {
    const select = `SELECT chat_conversations.*, projects.name AS project_name,
       (SELECT COUNT(*) FROM chat_messages
        WHERE chat_messages.conversation_id = chat_conversations.id) AS message_count,
       (SELECT content FROM chat_messages
        WHERE chat_messages.conversation_id = chat_conversations.id
        ORDER BY rowid DESC LIMIT 1) AS last_message
       FROM chat_conversations
       JOIN projects ON projects.id = chat_conversations.project_id`;
    const rows = projectId
      ? this.database.prepare(select + " WHERE chat_conversations.project_id = ? ORDER BY chat_conversations.updated_at DESC").all(projectId)
      : this.database.prepare(select + " ORDER BY projects.updated_at DESC, chat_conversations.updated_at DESC").all();
    return (rows as unknown as ChatConversationRow[]).map(presentConversation);
  }

  ensureConversation(projectId: string, conversationId?: string | null) {
    this.ensureProjectThread(projectId);
    if (conversationId) {
      const conversation = this.getConversation(conversationId);
      if (!conversation || conversation.projectId !== projectId) {
        throw new Error("Conversazione Chat non trovata nel progetto");
      }
      return conversation;
    }
    return this.listConversations(projectId)[0] ?? this.createConversation(projectId);
  }

  renameConversation(conversationId: string, titleValue: unknown) {
    const title = normalizeTitle(titleValue);
    const result = this.database.prepare(
      `UPDATE chat_conversations
       SET title = ?, title_is_auto = 0, updated_at = ?
       WHERE id = ?`,
    ).run(title, new Date().toISOString(), conversationId);
    if (result.changes !== 1) throw new Error("Conversazione Chat non trovata");
    return this.getConversation(conversationId)!;
  }

  maybeAutoTitle(conversationId: string, content: string) {
    const row = this.database.prepare(
      `SELECT title_is_auto,
       (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = ?) AS message_count
       FROM chat_conversations WHERE id = ?`,
    ).get(conversationId, conversationId) as { title_is_auto: number; message_count: number } | undefined;
    if (!row || !row.title_is_auto || row.message_count > 1) {
      return this.getConversation(conversationId);
    }
    this.database.prepare(
      "UPDATE chat_conversations SET title = ?, updated_at = ? WHERE id = ?",
    ).run(automaticTitle(content), new Date().toISOString(), conversationId);
    return this.getConversation(conversationId);
  }

  add(value: {
    projectId: string;
    conversationId?: string | null;
    role: "user" | "assistant";
    content: string;
    attachments?: ChatAttachment[];
    action?: ChatActionRecord | null;
    status?: "pending" | "ready" | "failed";
    error?: string | null;
  }) {
    const conversation = this.ensureConversation(value.projectId, value.conversationId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO chat_messages(
        id, project_id, conversation_id, role, content, attachments_json,
        action_json, status, error, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      value.projectId,
      conversation.id,
      value.role,
      value.content,
      JSON.stringify(value.attachments ?? []),
      value.action ? JSON.stringify(value.action) : null,
      value.status ?? "ready",
      value.error ?? null,
      now,
    );
    this.database.prepare(
      "UPDATE chat_conversations SET updated_at = ? WHERE id = ?",
    ).run(now, conversation.id);
    return this.get(id)!;
  }

  get(id: string) {
    const row = this.database.prepare(
      "SELECT rowid AS sequence, * FROM chat_messages WHERE id = ?",
    ).get(id) as ChatMessageRow | undefined;
    return row ? present(row) : null;
  }

  list(projectId: string, conversationId?: string | null, limit = 100) {
    const conversation = this.ensureConversation(projectId, conversationId);
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
    const rows = this.database.prepare(
      `SELECT * FROM (
        SELECT rowid AS sequence, * FROM chat_messages
        WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       ) ORDER BY created_at, sequence`,
    ).all(conversation.id, safeLimit) as unknown as ChatMessageRow[];
    return rows.map(present);
  }

  latestAttachments(projectId: string, conversationId?: string | null) {
    const conversation = this.ensureConversation(projectId, conversationId);
    const row = this.database.prepare(
      `SELECT attachments_json FROM chat_messages
       WHERE conversation_id = ? AND role = 'user' AND attachments_json <> '[]'
       ORDER BY rowid DESC LIMIT 1`,
    ).get(conversation.id) as { attachments_json: string } | undefined;
    return parseJson<ChatAttachment[]>(row?.attachments_json ?? null, [])
      .slice(0, 8)
      .map((attachment) => ({ ...attachment, remembered: true }));
  }

  recentMediaSources(projectId: string, conversationId?: string | null, limit = 20) {
    const conversation = this.ensureConversation(projectId, conversationId);
    const safeLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
    const rows = this.database.prepare(
      `SELECT rowid AS sequence, attachments_json, action_json
       FROM chat_messages
       WHERE conversation_id = ?
         AND (attachments_json <> '[]' OR action_json IS NOT NULL)
       ORDER BY rowid DESC LIMIT ?`,
    ).all(conversation.id, safeLimit) as unknown as Array<{
      sequence: number;
      attachments_json: string;
      action_json: string | null;
    }>;
    return rows.map((row) => ({
      sequence: row.sequence,
      attachments: parseJson<ChatAttachment[]>(row.attachments_json, []),
      action: parseJson<ChatActionRecord | null>(row.action_json, null),
    }));
  }

  context(projectId: string, conversationId?: string | null) {
    const conversation = this.ensureConversation(projectId, conversationId);
    const memory = this.database.prepare(
      `SELECT memory_summary, memory_sequence
       FROM chat_conversations WHERE id = ?`,
    ).get(conversation.id) as Pick<ChatConversationRow, "memory_summary" | "memory_sequence">;
    const rows = this.database.prepare(
      `SELECT rowid AS sequence, * FROM chat_messages
       WHERE conversation_id = ? AND rowid > ?
       ORDER BY created_at, rowid`,
    ).all(conversation.id, memory.memory_sequence) as unknown as ChatMessageRow[];
    return {
      summary: memory.memory_summary,
      sequence: memory.memory_sequence,
      messages: rows.map(present),
    };
  }

  memoryStatus(projectId: string, conversationId?: string | null) {
    const conversation = this.ensureConversation(projectId, conversationId);
    const memory = this.database.prepare(
      `SELECT memory_summary, memory_sequence
       FROM chat_conversations WHERE id = ?`,
    ).get(conversation.id) as Pick<ChatConversationRow, "memory_summary" | "memory_sequence">;
    const summarized = this.database.prepare(
      `SELECT COUNT(*) AS count FROM chat_messages
       WHERE conversation_id = ? AND rowid <= ?`,
    ).get(conversation.id, memory.memory_sequence) as { count: number };
    return {
      active: Boolean(memory.memory_summary),
      summarizedMessages: Number(summarized.count),
      summary: memory.memory_summary,
    };
  }

  updateMemory(projectId: string, conversationId: string, summary: string, throughSequence: number) {
    const conversation = this.ensureConversation(projectId, conversationId);
    this.database.prepare(
      `UPDATE chat_conversations
       SET memory_summary = ?, memory_sequence = ?, updated_at = ?
       WHERE id = ?`,
    ).run(summary, throughSequence, new Date().toISOString(), conversation.id);
    return this.memoryStatus(projectId, conversation.id);
  }

  mediaJobs(conversationId: string) {
    const rows = this.database.prepare(
      `SELECT action_json FROM chat_messages
       WHERE conversation_id = ? AND action_json IS NOT NULL`,
    ).all(conversationId) as unknown as Array<{ action_json: string }>;
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const action = parseJson<ChatActionRecord | null>(row.action_json, null);
      if (!action?.jobId || action.status !== "started") return [];
      const kind = action.type === "generate_video"
        ? "video" as const
        : action.type === "generate_tts" || action.type === "generate_music"
          ? "audio" as const
          : "image" as const;
      const key = kind + ":" + action.jobId;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ kind, jobId: action.jobId }];
    });
  }

  clear(projectId: string, conversationId?: string | null) {
    const conversation = this.ensureConversation(projectId, conversationId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM chat_messages WHERE conversation_id = ?").run(conversation.id);
      this.database.prepare(
        `UPDATE chat_conversations
         SET memory_summary = '', memory_sequence = 0, updated_at = ?
         WHERE id = ?`,
      ).run(new Date().toISOString(), conversation.id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { projectId, conversationId: conversation.id, cleared: true };
  }

  deleteConversation(conversationId: string) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error("Conversazione Chat non trovata");
    const result = this.database.prepare(
      "DELETE FROM chat_conversations WHERE id = ?",
    ).run(conversationId);
    if (result.changes !== 1) throw new Error("Conversazione Chat non eliminata");
    return { ...conversation, deleted: true };
  }

  close() { this.database.close(); }
}
