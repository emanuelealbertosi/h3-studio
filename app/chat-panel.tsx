"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Project = { id: string; name: string };
type ChatConversation = {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  titleIsAuto: boolean;
  memoryActive: boolean;
  messageCount: number;
  lastMessage?: string | null;
  createdAt: string;
  updatedAt: string;
};
type ChatRoute = "auto" | "video" | "krea" | "anima" | "edit";
type ChatMemory = { active: boolean; summarizedMessages: number; summary: string };
type ChatTrackedCandidate = {
  index: number;
  status: string;
  phaseLabel?: string | null;
  progress?: number | null;
  progressExact?: boolean;
  error?: string | null;
  output?: { mediaPath: string; filename?: string } | null;
};
type ChatTrackedJob = {
  id: string;
  kind: "video" | "image";
  status: string;
  width?: number;
  height?: number;
  candidates: ChatTrackedCandidate[];
  fetchError?: string;
};
type Attachment = {
  id: string;
  kind: "picture" | "video" | "audio";
  file: string;
  name: string;
  mediaPath: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  hasAudio?: boolean;
  remembered?: boolean;
};
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments: Attachment[];
  action: null | {
    type: "generate_video" | "generate_image" | "edit_image" | "generate_anima";
    prompt: string;
    jobId?: string;
    status: "started" | "failed";
    error?: string;
  };
  status: "pending" | "ready" | "failed";
  error?: string | null;
  createdAt: string;
};
type ExternalAsset = {
  id: string; kind: Attachment["kind"]; file: string; name: string;
  originalName?: string; mediaPath: string; width?: number | null;
  height?: number | null; duration?: number | null; hasAudio?: boolean;
};
type ImageJob = {
  id: string; prompt: string; width: number; height: number;
  candidates: Array<{ index: number; status: string; output?: {
    filename: string; subfolder: string; type: "input" | "output" | "temp";
    mediaPath: string; width?: number | null; height?: number | null;
  } | null }>;
};
type VideoJob = {
  id: string; request: { prompt: string; durationSeconds: number };
  candidates: Array<{ index: number; status: string; output?: {
    filename: string; subfolder: string; type: "input" | "output" | "temp";
    mediaPath: string;
  } | null }>;
};

function annotated(output: { filename: string; subfolder: string; type: string }) {
  const path = [output.subfolder, output.filename].filter(Boolean).join("/");
  return `${path} [${output.type}]`;
}

function actionLabel(type: NonNullable<ChatMessage["action"]>["type"]) {
  if (type === "generate_video") return "Video H3";
  if (type === "generate_anima") return "Immagine Anima";
  if (type === "edit_image") return "Edit Flux.2 Klein";
  return "Immagine Krea";
}

function terminalCandidate(candidate: ChatTrackedCandidate | undefined) {
  return Boolean(candidate && ["ready", "failed", "cancelled"].includes(candidate.status));
}

function trackedJobActive(job: ChatTrackedJob | undefined) {
  if (!job) return true;
  if (job.fetchError) return false;
  return job.candidates.length > 0 && job.candidates.some((candidate) => !terminalCandidate(candidate));
}

function trackedStatus(candidate: ChatTrackedCandidate | undefined, thinking = false) {
  if (thinking) return "Gemma sta preparando prompt e motore";
  if (!candidate) return "Collegamento alla coda…";
  if (candidate.phaseLabel) return candidate.phaseLabel;
  if (["prepared", "submitted"].includes(candidate.status)) return "Invio a ComfyUI";
  if (candidate.status === "queued") return "In coda";
  if (["running", "rendering", "processing"].includes(candidate.status)) return "Generazione in corso";
  if (candidate.status === "ready") return "Completato";
  if (candidate.status === "cancelled") return "Interrotto";
  if (candidate.status === "failed") return "Generazione fallita";
  return candidate.status;
}

export default function ChatPanel({
  bridgeUrl,
  projectId,
  projectName,
  projects,
  onSelectProject,
  onOpenStudio,
}: {
  bridgeUrl: string;
  projectId: string;
  projectName?: string;
  projects: Project[];
  onSelectProject: (projectId: string) => void;
  onOpenStudio: (kind: "video" | "image") => void;
}) {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ChatConversation | null>(null);
  const [preserveMedia, setPreserveMedia] = useState(true);
  const [deletingConversation, setDeletingConversation] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [route, setRoute] = useState<ChatRoute>("auto");
  const [memory, setMemory] = useState<ChatMemory | null>(null);
  const [jobStates, setJobStates] = useState<Record<string, ChatTrackedJob>>({});
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [library, setLibrary] = useState<Attachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Caricamento Chat locale…");
  const [runtime, setRuntime] = useState<{ ready: boolean; loaded: boolean; error?: string | null } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pendingConversationRef = useRef<string | null>(null);
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? null;

  const trackedActions = useMemo(() => messages
    .flatMap((message) => message.action?.jobId ? [{ ...message.action, messageId: message.id }] : [])
    .slice(-20), [messages]);
  const trackedActionKey = trackedActions.map((action) => `${action.jobId}:${action.type}`).join("|");
  const renderActive = trackedActions.some((action) => trackedJobActive(jobStates[action.jobId!]));
  const chatLocked = busy || renderActive || cancellingJobId !== null || deletingConversation;

  useEffect(() => {
    let disposed = false;
    if (!projectId) return;
    setAttachments([]);
    Promise.all([
      fetch(`${bridgeUrl}/api/chat/conversations`, { cache: "no-store" }),
      fetch(`${bridgeUrl}/api/chat/status`, { cache: "no-store" }),
    ]).then(async ([conversationResponse, statusResponse]) => {
      const conversationPayload = await conversationResponse.json() as { conversations?: ChatConversation[]; error?: string };
      const statusPayload = await statusResponse.json() as { chat?: { ready: boolean; loaded: boolean; error?: string | null } };
      if (!conversationResponse.ok) throw new Error(conversationPayload.error ?? "Chat non disponibile");
      let available = conversationPayload.conversations ?? [];
      const pendingId = pendingConversationRef.current;
      let selected = pendingId
        ? available.find((conversation) => conversation.id === pendingId && conversation.projectId === projectId)
        : undefined;
      selected ??= available.find((conversation) => conversation.projectId === projectId);
      if (!selected) {
        const createResponse = await fetch(`${bridgeUrl}/api/chat/${projectId}/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const createPayload = await createResponse.json() as { conversation?: ChatConversation; error?: string };
        if (!createResponse.ok || !createPayload.conversation) {
          throw new Error(createPayload.error ?? "Nuova Chat non creata");
        }
        selected = createPayload.conversation;
        available = [selected, ...available];
      }
      if (disposed) return;
      pendingConversationRef.current = null;
      setConversations(available);
      setActiveConversationId(selected.id);
      setRuntime(statusPayload.chat ?? null);
      setNotice(statusPayload.chat?.ready
        ? "Gemma 4 Vision pronta · il modello resta caricato tra i messaggi e viene liberato prima dei render"
        : statusPayload.chat?.error ?? "Nodo Chat non pronto: installalo e riavvia ComfyUI");
    }).catch((error) => !disposed && setNotice(error instanceof Error ? error.message : "Chat non disponibile"));
    return () => { disposed = true; };
  }, [bridgeUrl, projectId]);

  useEffect(() => {
    if (!activeConversationId) {
      setMessages([]);
      setMemory(null);
      return;
    }
    let disposed = false;
    fetch(`${bridgeUrl}/api/chat/conversations/${activeConversationId}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as {
          conversation?: ChatConversation;
          messages?: ChatMessage[];
          memory?: ChatMemory;
          error?: string;
        };
        if (!response.ok || !payload.conversation) {
          throw new Error(payload.error ?? "Conversazione Chat non disponibile");
        }
        if (disposed) return;
        setMessages(payload.messages ?? []);
        setMemory(payload.memory ?? null);
        setConversations((current) => current.map((conversation) =>
          conversation.id === payload.conversation!.id ? payload.conversation! : conversation
        ));
        setNotice("Chat pronta");
      })
      .catch((error) => !disposed && setNotice(error instanceof Error ? error.message : "Chat non disponibile"));
    return () => { disposed = true; };
  }, [activeConversationId, bridgeUrl]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

  useEffect(() => {
    if (!trackedActions.length) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const updates = await Promise.all(trackedActions.map(async (action): Promise<[string, ChatTrackedJob]> => {
        const kind = action.type === "generate_video" ? "video" : "image";
        const endpoint = kind === "video" ? `/api/jobs/${action.jobId}` : `/api/image-jobs/${action.jobId}`;
        try {
          const response = await fetch(`${bridgeUrl}${endpoint}`, { cache: "no-store" });
          const payload = await response.json() as { job?: Omit<ChatTrackedJob, "kind">; error?: string };
          if (!response.ok || !payload.job) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
          return [action.jobId!, { ...payload.job, kind }];
        } catch (error) {
          return [action.jobId!, {
            id: action.jobId!, kind, status: "failed", candidates: [],
            fetchError: error instanceof Error ? error.message : "Job non disponibile",
          }];
        }
      }));
      if (disposed) return;
      setJobStates((current) => ({ ...current, ...Object.fromEntries(updates) }));
      if (updates.some(([, job]) => trackedJobActive(job))) {
        timer = setTimeout(() => void poll(), 1_000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [bridgeUrl, trackedActionKey, trackedActions]);

  async function loadLibrary() {
    setPickerOpen(true);
    try {
      const [externalResponse, imageResponse, videoResponse] = await Promise.all([
        fetch(`${bridgeUrl}/api/external-media`, { cache: "no-store" }),
        fetch(`${bridgeUrl}/api/image-jobs?limit=200&projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" }),
        fetch(`${bridgeUrl}/api/jobs?limit=80&projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" }),
      ]);
      const externalPayload = await externalResponse.json() as { assets?: ExternalAsset[] };
      const imagePayload = await imageResponse.json() as { jobs?: ImageJob[] };
      const videoPayload = await videoResponse.json() as { jobs?: VideoJob[] };
      const items: Attachment[] = [];
      for (const asset of externalPayload.assets ?? []) items.push({
        id: `external:${asset.id}`, kind: asset.kind, file: asset.file,
        name: asset.originalName ?? asset.name, mediaPath: asset.mediaPath,
        width: asset.width, height: asset.height, duration: asset.duration,
        hasAudio: asset.hasAudio,
      });
      for (const job of imagePayload.jobs ?? []) for (const candidate of job.candidates) {
        if (candidate.status !== "ready" || !candidate.output) continue;
        items.push({
          id: `image:${job.id}:${candidate.index}`, kind: "picture",
          file: annotated(candidate.output), name: `Immagine ${job.id.slice(0, 8)} · ${candidate.index}`,
          mediaPath: candidate.output.mediaPath,
          width: candidate.output.width ?? job.width, height: candidate.output.height ?? job.height,
        });
      }
      for (const job of videoPayload.jobs ?? []) for (const candidate of job.candidates) {
        if (candidate.status !== "ready" || !candidate.output) continue;
        items.push({
          id: `video:${job.id}:${candidate.index}`, kind: "video",
          file: annotated(candidate.output), name: `Video ${job.id.slice(0, 8)} · ${candidate.index}`,
          mediaPath: candidate.output.mediaPath, duration: job.request.durationSeconds,
        });
      }
      const seen = new Set<string>();
      setLibrary(items.filter((item) => !seen.has(item.file.toLowerCase()) && Boolean(seen.add(item.file.toLowerCase()))));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Libreria non disponibile");
    }
  }

  function addAttachment(item: Attachment) {
    setAttachments((current) => current.some((entry) => entry.file === item.file)
      ? current
      : [...current, item].slice(0, 8));
    setText((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${item.name} `);
    setPickerOpen(false);
  }

  function selectConversation(conversation: ChatConversation) {
    if (chatLocked) return;
    pendingConversationRef.current = conversation.id;
    setActiveConversationId(conversation.id);
    setAttachments([]);
    setText("");
    if (conversation.projectId !== projectId) onSelectProject(conversation.projectId);
  }

  async function createConversationForProject(targetProjectId: string, ignoreLock = false) {
    if (chatLocked && !ignoreLock) return null;
    setNotice("Creazione nuova Chat…");
    const response = await fetch(`${bridgeUrl}/api/chat/${targetProjectId}/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await response.json() as { conversation?: ChatConversation; error?: string };
    if (!response.ok || !payload.conversation) {
      throw new Error(payload.error ?? "Nuova Chat non creata");
    }
    const conversation = payload.conversation;
    pendingConversationRef.current = conversation.id;
    setConversations((current) => [conversation, ...current]);
    setActiveConversationId(conversation.id);
    setMessages([]);
    setMemory(null);
    setAttachments([]);
    setText("");
    if (targetProjectId !== projectId) onSelectProject(targetProjectId);
    setNotice("Nuova Chat pronta");
    return conversation;
  }

  async function saveConversationTitle(conversationId: string) {
    const title = editingTitle.trim();
    if (!title) return;
    const response = await fetch(`${bridgeUrl}/api/chat/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const payload = await response.json() as { conversation?: ChatConversation; error?: string };
    if (!response.ok || !payload.conversation) {
      setNotice(payload.error ?? "Rinomina fallita");
      return;
    }
    setConversations((current) => current.map((conversation) =>
      conversation.id === conversationId ? payload.conversation! : conversation
    ));
    setEditingConversationId(null);
    setNotice("Titolo Chat aggiornato");
  }

  function requestConversationDeletion(conversation: ChatConversation) {
    if (conversation.id === activeConversationId && chatLocked) {
      setNotice("Interrompi prima la produzione attiva");
      return;
    }
    setPreserveMedia(true);
    setDeleteTarget(conversation);
  }

  async function confirmConversationDeletion() {
    if (!deleteTarget || deletingConversation) return;
    setDeletingConversation(true);
    setNotice("Eliminazione conversazione…");
    try {
      const response = await fetch(`${bridgeUrl}/api/chat/conversations/${deleteTarget.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preserveMedia }),
      });
      const payload = await response.json() as {
        removedJobs?: number;
        removedClips?: number;
        removedFiles?: number;
        warnings?: string[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? "Conversazione non eliminata");
      const remaining = conversations.filter((conversation) => conversation.id !== deleteTarget.id);
      setConversations(remaining);
      if (activeConversationId === deleteTarget.id) {
        const next = remaining.find((conversation) => conversation.projectId === deleteTarget.projectId);
        if (next) {
          pendingConversationRef.current = next.id;
          setActiveConversationId(next.id);
        } else {
          await createConversationForProject(deleteTarget.projectId, true);
        }
      }
      setDeleteTarget(null);
      setNotice(preserveMedia
        ? "Chat eliminata · media conservati in Libreria"
        : `Chat e media eliminati · ${payload.removedJobs ?? 0} job · ${payload.removedFiles ?? 0} file` +
          (payload.warnings?.length ? ` · ${payload.warnings.join(" · ")}` : ""));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Conversazione non eliminata");
    } finally {
      setDeletingConversation(false);
    }
  }

  async function send() {
    if (!projectId || !activeConversationId || !text.trim() || chatLocked) return;
    setBusy(true);
    setNotice("Gemma 4 sta preparando la risposta…");
    try {
      const response = await fetch(`${bridgeUrl}/api/chat/conversations/${activeConversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text.trim(), attachments, route }),
      });
      const payload = await response.json() as {
        conversation?: ChatConversation;
        messages?: ChatMessage[];
        memory?: ChatMemory;
        reusedAttachments?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.messages) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setMessages(payload.messages);
      setMemory(payload.memory ?? null);
      if (payload.conversation) {
        setConversations((current) => [
          payload.conversation!,
          ...current.filter((conversation) => conversation.id !== payload.conversation!.id),
        ]);
      }
      setText("");
      setAttachments([]);
      const last = payload.messages.at(-1);
      setNotice(last?.action?.status === "started"
        ? `${actionLabel(last.action.type)} avviato${payload.reusedAttachments ? " · media recuperato dalla memoria" : ""} · Gemma è stata scaricata dalla memoria`
        : last?.status === "failed" ? last.error ?? "Risposta fallita" : "Chat pronta");
      setRuntime((current) => current ? { ...current, loaded: !last?.action } : current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Invio Chat fallito");
    } finally {
      setBusy(false);
    }
  }

  async function clearChat() {
    if (!projectId || !activeConversationId || !window.confirm(
      `Cancellare tutti i messaggi di “${activeConversation?.title ?? "questa Chat"}”? I media prodotti resteranno in Libreria.`,
    )) return;
    const response = await fetch(
      `${bridgeUrl}/api/chat/conversations/${activeConversationId}/messages`,
      { method: "DELETE" },
    );
    if (response.ok) {
      setMessages([]);
      setMemory(null);
      setConversations((current) => current.map((conversation) =>
        conversation.id === activeConversationId
          ? { ...conversation, messageCount: 0, memoryActive: false, lastMessage: null, updatedAt: new Date().toISOString() }
          : conversation
      ));
      setNotice("Conversazione e memoria cancellate");
    }
  }

  async function cancelAction(action: NonNullable<ChatMessage["action"]>) {
    if (!action.jobId || cancellingJobId) return;
    setCancellingJobId(action.jobId);
    setNotice("Interruzione del job Chat…");
    try {
      const endpoint = action.type === "generate_video"
        ? `/api/jobs/${action.jobId}/cancel`
        : `/api/image-jobs/${action.jobId}/cancel`;
      const response = await fetch(`${bridgeUrl}${endpoint}`, { method: "POST" });
      const payload = await response.json() as { job?: Omit<ChatTrackedJob, "kind">; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      const kind = action.type === "generate_video" ? "video" : "image";
      setJobStates((current) => ({ ...current, [action.jobId!]: { ...payload.job!, kind } }));
      setNotice("Produzione interrotta");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Interruzione fallita");
    } finally {
      setCancellingJobId(null);
    }
  }

  const suggestions = useMemo(() => [
    "Creami un video di 10 secondi con…",
    "Genera un'immagine fotorealistica di…",
    "Crea un'immagine anime di…",
  ], []);
  const routes: Array<{ id: ChatRoute; label: string; help: string }> = [
    { id: "auto", label: "Auto", help: "Gemma sceglie in base alla richiesta" },
    { id: "video", label: "Video H3", help: "Forza la generazione video" },
    { id: "krea", label: "Krea", help: "Forza una immagine fotografica/generale" },
    { id: "anima", label: "Anima", help: "Forza disegno, anime, manga o illustrazione" },
    { id: "edit", label: "Edit", help: "Forza Flux Klein sulle immagini allegate" },
  ];

  return (
    <section className="chat-workspace">
      <aside className="chat-thread-sidebar" aria-label="Conversazioni per progetto">
        <header>
          <div><span className="section-index">CHAT</span><h3>Conversazioni</h3></div>
          <small>{conversations.length} totali</small>
        </header>
        <div className="chat-thread-groups">
          {projects.map((project) => {
            const projectConversations = conversations.filter(
              (conversation) => conversation.projectId === project.id,
            );
            return <section className="chat-thread-project" key={project.id}>
              <header>
                <strong title={project.name}>{project.name}</strong>
                <button
                  aria-label={`Nuova Chat in ${project.name}`}
                  disabled={chatLocked}
                  onClick={() => void createConversationForProject(project.id).catch((error) =>
                    setNotice(error instanceof Error ? error.message : "Nuova Chat non creata")
                  )}
                  title="Nuova Chat"
                  type="button"
                >＋</button>
              </header>
              <div>
                {projectConversations.map((conversation) => (
                  <div className={`chat-thread-item ${conversation.id === activeConversationId ? "active" : ""}`} key={conversation.id}>
                    {editingConversationId === conversation.id ? (
                      <input
                        autoFocus
                        maxLength={80}
                        onBlur={() => void saveConversationTitle(conversation.id)}
                        onChange={(event) => setEditingTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") setEditingConversationId(null);
                        }}
                        value={editingTitle}
                      />
                    ) : (
                      <button className="chat-thread-main" disabled={chatLocked} onClick={() => selectConversation(conversation)} type="button">
                        <strong>{conversation.title}</strong>
                        <small>{conversation.messageCount} messaggi{conversation.memoryActive ? " · memoria" : ""}</small>
                      </button>
                    )}
                    <div className="chat-thread-actions">
                      <button
                        aria-label={`Rinomina ${conversation.title}`}
                        disabled={chatLocked}
                        onClick={() => {
                          setEditingConversationId(conversation.id);
                          setEditingTitle(conversation.title);
                        }}
                        title="Rinomina"
                        type="button"
                      >✎</button>
                      <button
                        aria-label={`Elimina ${conversation.title}`}
                        className="danger"
                        disabled={conversation.id === activeConversationId && chatLocked}
                        onClick={() => requestConversationDeletion(conversation)}
                        title="Elimina Chat"
                        type="button"
                      >⌫</button>
                    </div>
                  </div>
                ))}
                {!projectConversations.length && <small className="chat-thread-empty">Nessuna Chat</small>}
              </div>
            </section>;
          })}
        </div>
      </aside>

      <section className="chat-panel">
      <header className="chat-heading">
        <div><span className="section-index">CHAT · {projectName ?? "PROGETTO"}</span><h2>{activeConversation?.title ?? "Gemma 4 Vision"}</h2><p>{notice}</p></div>
        <div className="chat-heading-actions">
          {memory?.active && (
            <span className="chat-memory" title={memory.summary}>⌁ Memoria · {memory.summarizedMessages}</span>
          )}
          <span className={runtime?.ready ? "chat-runtime ready" : "chat-runtime error"}>{runtime?.ready ? runtime.loaded ? "● Modello caricato" : "○ Pronto" : "! Setup richiesto"}</span>
          <button disabled={!messages.length || chatLocked} onClick={() => void clearChat()} type="button">Pulisci</button>
        </div>
      </header>

      <div className="chat-messages">
        {!messages.length && (
          <div className="chat-welcome">
            <span>H3</span><h3>Parlami normalmente.</h3>
            <p>Posso ragionare con te oppure avviare direttamente Video H3, immagini Krea, edit Flux.2 Klein e immagini Anima. Scegli “Anima” sotto al messaggio quando vuoi garantire un disegno o un’illustrazione.</p>
            <div>{suggestions.map((suggestion) => <button disabled={chatLocked} key={suggestion} onClick={() => setText(suggestion)} type="button">{suggestion}</button>)}</div>
          </div>
        )}
        {messages.map((message) => {
          const action = message.action;
          const tracked = action?.jobId ? jobStates[action.jobId] : undefined;
          const candidate = tracked?.candidates[0];
          const actionActive = Boolean(action?.jobId && trackedJobActive(tracked));
          const ready = candidate?.status === "ready" && Boolean(candidate.output?.mediaPath);
          const failed = Boolean(tracked?.fetchError || action?.status === "failed" || candidate?.status === "failed" || candidate?.status === "cancelled");
          const progress = typeof candidate?.progress === "number" ? Math.max(0, Math.min(100, Math.round(candidate.progress))) : null;
          const exact = candidate?.progressExact === true && progress !== null;
          const mediaUrl = candidate?.output?.mediaPath ? `${bridgeUrl}${candidate.output.mediaPath}` : null;
          return (
            <article className={`chat-message ${message.role} ${message.status}`} key={message.id}>
              <span>{message.role === "assistant" ? "H3" : "TU"}</span>
              <div>
                {message.attachments?.length > 0 && <div className="chat-message-media">{message.attachments.map((item) => (
                  <div key={item.file}>{item.kind === "picture" ? <img alt="" src={`${bridgeUrl}${item.mediaPath}`} /> : item.kind === "video" ? <video muted src={`${bridgeUrl}${item.mediaPath}`} /> : <b>♪</b>}<small>{item.remembered ? "⌁ Memoria · " : ""}{item.name}</small></div>
                ))}</div>}
                <p>{message.content}</p>
                {action && <div className={`chat-action-card ${failed ? "failed" : action.status}`}>
                  <div className="chat-action-heading">
                    <div>
                      <strong>{actionLabel(action.type)}</strong>
                      <small>{action.jobId ? `Job ${action.jobId.slice(0, 8)} · ${tracked?.fetchError ?? candidate?.error ?? trackedStatus(candidate)}` : action.error}</small>
                    </div>
                    <div className="chat-action-buttons">
                      {actionActive && <button className="chat-stop-button" disabled={cancellingJobId === action.jobId} onClick={() => void cancelAction(action)} type="button">■ {cancellingJobId === action.jobId ? "Interruzione…" : "Interrompi"}</button>}
                      {action.status === "started" && <button onClick={() => onOpenStudio(action.type === "generate_video" ? "video" : "image")} type="button">Apri nello Studio</button>}
                    </div>
                  </div>
                  {action.jobId && <div
                    className={`chat-render-preview ${ready ? "ready" : failed ? "failed" : "working"}`}
                    style={tracked?.kind === "image" && tracked.width && tracked.height ? { aspectRatio: `${tracked.width} / ${tracked.height}` } : undefined}
                  >
                    {ready && mediaUrl ? tracked?.kind === "video"
                      ? <video controls playsInline preload="metadata" src={mediaUrl} />
                      : <a href={mediaUrl} rel="noreferrer" target="_blank"><img alt={candidate?.output?.filename ?? actionLabel(action.type)} src={mediaUrl} /></a>
                      : <>
                        <div className="video-noise" />
                        <div className="video-blur" />
                        <div className="progress-overlay">
                          <strong>{failed ? "!" : exact ? `${progress}%` : "H3"}</strong>
                          <span>{tracked?.fetchError ?? candidate?.error ?? trackedStatus(candidate)}</span>
                          {!failed && <div className={`progress-track ${exact ? "" : "indeterminate"}`}><i style={exact ? { width: `${progress}%` } : undefined} /></div>}
                        </div>
                      </>}
                  </div>}
                </div>}
                <time>{new Date(message.createdAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</time>
              </div>
            </article>
          );
        })}
        {busy && <article className="chat-message assistant thinking"><span>H3</span><div className="chat-thinking-body"><div className="chat-render-preview chat-thinking-preview working"><div className="video-noise" /><div className="video-blur" /><div className="progress-overlay"><strong>H3</strong><span>{trackedStatus(undefined, true)}</span><div className="progress-track indeterminate"><i /></div></div></div><small>Caricamento / inferenza locale…</small></div></article>}
        <div ref={bottomRef} />
      </div>

      <footer className="chat-composer">
        <div className="chat-route-bar">
          <span>Crea con</span>
          <div>{routes.map((item) => (
            <button
              className={route === item.id ? "active" : ""}
              disabled={chatLocked}
              key={item.id}
              onClick={() => setRoute(item.id)}
              title={item.help}
              type="button"
            >{item.label}</button>
          ))}</div>
          <small>{routes.find((item) => item.id === route)?.help}</small>
        </div>
        {attachments.length > 0 && <div className="chat-attachment-strip">{attachments.map((item, index) => (
          <div key={item.file}>{item.kind === "picture" ? <img alt="" src={`${bridgeUrl}${item.mediaPath}`} /> : item.kind === "video" ? <video muted src={`${bridgeUrl}${item.mediaPath}`} /> : <span>♪</span>}<b>{index + 1}</b><small>{item.name}</small><button aria-label={`Rimuovi ${item.name}`} disabled={chatLocked} onClick={() => setAttachments((current) => current.filter((entry) => entry.file !== item.file))} type="button">×</button></div>
        ))}</div>}
        <div className="chat-input-row">
          <button className="chat-library-button" disabled={chatLocked} onClick={() => void loadLibrary()} title="Scegli dalla Libreria" type="button">＋</button>
          <textarea
            disabled={chatLocked}
            onChange={(event) => { const value = event.target.value; setText(value); if (/(^|\s)@$/.test(value)) void loadLibrary(); }}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
            placeholder="Scrivi un messaggio oppure usa @ per allegare media…"
            rows={2}
            value={text}
          />
          <button className="chat-send-button" disabled={chatLocked || !text.trim() || !runtime?.ready} onClick={() => void send()} type="button">{chatLocked ? "…" : "Invia ↗"}</button>
        </div>
        <small>{renderActive ? "Produzione in corso: la Chat resta bloccata fino al termine oppure premi Interrompi." : "Invio per mandare · Shift+Invio per andare a capo · la memoria lunga viene riassunta automaticamente · max 4 immagini vision / 8 media per azione"}</small>
      </footer>

      {pickerOpen && <div className="chat-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPickerOpen(false); }}>
        <section className="chat-picker-modal">
          <header><div><span className="section-index">@ LIBRERIA</span><h3>Allega un media</h3></div><button onClick={() => setPickerOpen(false)} type="button">×</button></header>
          <div className="chat-picker-grid">{library.map((item) => (
            <button key={item.id} onClick={() => addAttachment(item)} type="button">
              <div>{item.kind === "picture" ? <img alt="" src={`${bridgeUrl}${item.mediaPath}`} /> : item.kind === "video" ? <video muted src={`${bridgeUrl}${item.mediaPath}`} /> : <span>♪</span>}</div>
              <strong>{item.name}</strong><small>{item.kind}</small>
            </button>
          ))}</div>
          {!library.length && <p className="chat-picker-empty">Nessun media disponibile in questo progetto o tra gli Esterni.</p>}
        </section>
      </div>}
      </section>

      {deleteTarget && <div
        className="chat-delete-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deletingConversation) setDeleteTarget(null);
        }}
      >
        <section className="chat-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-delete-title">
          <span className="section-index">ELIMINA CHAT</span>
          <h3 id="chat-delete-title">Eliminare “{deleteTarget.title}”?</h3>
          <p>Verranno cancellati messaggi e memoria di questa conversazione.</p>
          <label>
            <input
              checked={preserveMedia}
              disabled={deletingConversation}
              onChange={(event) => setPreserveMedia(event.target.checked)}
              type="checkbox"
            />
            <span><strong>Conserva i media generati</strong><small>Consigliato · immagini e video restano nel progetto e nella Libreria.</small></span>
          </label>
          {!preserveMedia && <div className="chat-delete-warning">
            Verranno eliminati anche i job prodotti da questa Chat, i relativi file, le varianti Face/Upscale e le clip presenti nei Montaggi.
          </div>}
          <footer>
            <button disabled={deletingConversation} onClick={() => setDeleteTarget(null)} type="button">Annulla</button>
            <button className="danger" disabled={deletingConversation} onClick={() => void confirmConversationDeletion()} type="button">
              {deletingConversation ? "Eliminazione…" : "Elimina Chat"}
            </button>
          </footer>
        </section>
      </div>}
    </section>
  );
}
