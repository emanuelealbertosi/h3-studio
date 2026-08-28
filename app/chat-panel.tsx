"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Project = { id: string; name: string };
type ChatRoute = "auto" | "video" | "krea" | "anima" | "edit";
type ChatMemory = { active: boolean; summarizedMessages: number; summary: string };
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

export default function ChatPanel({
  bridgeUrl,
  projectId,
  projectName,
  onOpenStudio,
}: {
  bridgeUrl: string;
  projectId: string;
  projectName?: string;
  projects: Project[];
  onOpenStudio: (kind: "video" | "image") => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [route, setRoute] = useState<ChatRoute>("auto");
  const [memory, setMemory] = useState<ChatMemory | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [library, setLibrary] = useState<Attachment[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Caricamento Chat locale…");
  const [runtime, setRuntime] = useState<{ ready: boolean; loaded: boolean; error?: string | null } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    if (!projectId) return;
    setAttachments([]);
    Promise.all([
      fetch(`${bridgeUrl}/api/chat/${projectId}`, { cache: "no-store" }),
      fetch(`${bridgeUrl}/api/chat/status`, { cache: "no-store" }),
    ]).then(async ([messageResponse, statusResponse]) => {
      const messagePayload = await messageResponse.json() as { messages?: ChatMessage[]; memory?: ChatMemory; error?: string };
      const statusPayload = await statusResponse.json() as { chat?: { ready: boolean; loaded: boolean; error?: string | null } };
      if (!messageResponse.ok) throw new Error(messagePayload.error ?? "Chat non disponibile");
      if (disposed) return;
      setMessages(messagePayload.messages ?? []);
      setMemory(messagePayload.memory ?? null);
      setRuntime(statusPayload.chat ?? null);
      setNotice(statusPayload.chat?.ready
        ? "Gemma 4 Vision pronta · il modello resta caricato tra i messaggi e viene liberato prima dei render"
        : statusPayload.chat?.error ?? "Nodo Chat non pronto: installalo e riavvia ComfyUI");
    }).catch((error) => !disposed && setNotice(error instanceof Error ? error.message : "Chat non disponibile"));
    return () => { disposed = true; };
  }, [bridgeUrl, projectId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

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

  async function send() {
    if (!projectId || !text.trim() || busy) return;
    setBusy(true);
    setNotice("Gemma 4 sta preparando la risposta…");
    try {
      const response = await fetch(`${bridgeUrl}/api/chat/${projectId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text.trim(), attachments, route }),
      });
      const payload = await response.json() as { messages?: ChatMessage[]; memory?: ChatMemory; error?: string };
      if (!response.ok || !payload.messages) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setMessages(payload.messages);
      setMemory(payload.memory ?? null);
      setText("");
      setAttachments([]);
      const last = payload.messages.at(-1);
      setNotice(last?.action?.status === "started"
        ? `${actionLabel(last.action.type)} avviato · Gemma è stata scaricata dalla memoria`
        : last?.status === "failed" ? last.error ?? "Risposta fallita" : "Chat pronta");
      setRuntime((current) => current ? { ...current, loaded: !last?.action } : current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Invio Chat fallito");
    } finally {
      setBusy(false);
    }
  }

  async function clearChat() {
    if (!projectId || !window.confirm(`Cancellare la conversazione del progetto “${projectName ?? "corrente"}”?`)) return;
    const response = await fetch(`${bridgeUrl}/api/chat/${projectId}`, { method: "DELETE" });
    if (response.ok) { setMessages([]); setMemory(null); setNotice("Conversazione e memoria cancellate"); }
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
    <section className="chat-panel">
      <header className="chat-heading">
        <div><span className="section-index">CHAT · {projectName ?? "PROGETTO"}</span><h2>Gemma 4 Vision</h2><p>{notice}</p></div>
        <div className="chat-heading-actions">
          {memory?.active && (
            <span className="chat-memory" title={memory.summary}>⌁ Memoria · {memory.summarizedMessages}</span>
          )}
          <span className={runtime?.ready ? "chat-runtime ready" : "chat-runtime error"}>{runtime?.ready ? runtime.loaded ? "● Modello caricato" : "○ Pronto" : "! Setup richiesto"}</span>
          <button disabled={!messages.length || busy} onClick={() => void clearChat()} type="button">Pulisci</button>
        </div>
      </header>

      <div className="chat-messages">
        {!messages.length && (
          <div className="chat-welcome">
            <span>H3</span><h3>Parlami normalmente.</h3>
            <p>Posso ragionare con te oppure avviare direttamente Video H3, immagini Krea, edit Flux.2 Klein e immagini Anima. Scegli “Anima” sotto al messaggio quando vuoi garantire un disegno o un’illustrazione.</p>
            <div>{suggestions.map((suggestion) => <button key={suggestion} onClick={() => setText(suggestion)} type="button">{suggestion}</button>)}</div>
          </div>
        )}
        {messages.map((message) => (
          <article className={`chat-message ${message.role} ${message.status}`} key={message.id}>
            <span>{message.role === "assistant" ? "H3" : "TU"}</span>
            <div>
              {message.attachments?.length > 0 && <div className="chat-message-media">{message.attachments.map((item) => (
                <div key={item.file}>{item.kind === "picture" ? <img alt="" src={`${bridgeUrl}${item.mediaPath}`} /> : item.kind === "video" ? <video muted src={`${bridgeUrl}${item.mediaPath}`} /> : <b>♪</b>}<small>{item.name}</small></div>
              ))}</div>}
              <p>{message.content}</p>
              {message.action && <div className={`chat-action-card ${message.action.status}`}>
                <div><strong>{actionLabel(message.action.type)}</strong><small>{message.action.status === "started" ? `Job ${message.action.jobId?.slice(0, 8)} avviato` : message.action.error}</small></div>
                {message.action.status === "started" && <button onClick={() => onOpenStudio(message.action!.type === "generate_video" ? "video" : "image")} type="button">Apri nello Studio</button>}
              </div>}
              <time>{new Date(message.createdAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</time>
            </div>
          </article>
        ))}
        {busy && <article className="chat-message assistant thinking"><span>H3</span><div><p><i /><i /><i /></p><small>Caricamento / inferenza locale…</small></div></article>}
        <div ref={bottomRef} />
      </div>

      <footer className="chat-composer">
        <div className="chat-route-bar">
          <span>Crea con</span>
          <div>{routes.map((item) => (
            <button
              className={route === item.id ? "active" : ""}
              key={item.id}
              onClick={() => setRoute(item.id)}
              title={item.help}
              type="button"
            >{item.label}</button>
          ))}</div>
          <small>{routes.find((item) => item.id === route)?.help}</small>
        </div>
        {attachments.length > 0 && <div className="chat-attachment-strip">{attachments.map((item, index) => (
          <div key={item.file}>{item.kind === "picture" ? <img alt="" src={`${bridgeUrl}${item.mediaPath}`} /> : item.kind === "video" ? <video muted src={`${bridgeUrl}${item.mediaPath}`} /> : <span>♪</span>}<b>{index + 1}</b><small>{item.name}</small><button aria-label={`Rimuovi ${item.name}`} onClick={() => setAttachments((current) => current.filter((entry) => entry.file !== item.file))} type="button">×</button></div>
        ))}</div>}
        <div className="chat-input-row">
          <button className="chat-library-button" onClick={() => void loadLibrary()} title="Scegli dalla Libreria" type="button">＋</button>
          <textarea
            disabled={busy}
            onChange={(event) => { const value = event.target.value; setText(value); if (/(^|\s)@$/.test(value)) void loadLibrary(); }}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
            placeholder="Scrivi un messaggio oppure usa @ per allegare media…"
            rows={2}
            value={text}
          />
          <button className="chat-send-button" disabled={busy || !text.trim() || !runtime?.ready} onClick={() => void send()} type="button">{busy ? "…" : "Invia ↗"}</button>
        </div>
        <small>Invio per mandare · Shift+Invio per andare a capo · la memoria lunga viene riassunta automaticamente · max 4 immagini vision / 8 media per azione</small>
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
  );
}
