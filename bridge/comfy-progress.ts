import { randomUUID } from "node:crypto";
import type { ComfyApiPrompt } from "./comfy-client.js";

export type ComfyPromptProgress = {
  phase:
    | "submitted"
    | "planning"
    | "loading"
    | "preparing"
    | "sampling"
    | "finalizing"
    | "completed"
    | "failed";
  phaseLabel: string;
  progress: number | null;
  exact: boolean;
  currentNode: string | null;
  updatedAt: string;
};

export type ComfyPromptTerminalEvent = {
  promptId: string;
  outcome: "completed" | "failed";
};

type TerminalListener = (
  event: ComfyPromptTerminalEvent,
) => void | Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function promptIdFrom(data: Record<string, unknown>) {
  return typeof data.prompt_id === "string" ? data.prompt_id : null;
}

export class ComfyProgressTracker {
  private readonly clientId = `h3-studio-bridge-${randomUUID()}`;
  private readonly progress = new Map<string, ComfyPromptProgress>();
  private readonly nodeClasses = new Map<string, Map<string, string>>();
  private readonly mediaKinds = new Map<string, "video" | "image" | "audio">();
  private readonly terminalListeners = new Set<TerminalListener>();
  private socket: WebSocket | null = null;
  private socketConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly comfyBaseUrl: string) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  register(
    promptId: string,
    prompt: ComfyApiPrompt,
    mediaKind: "video" | "image" | "audio" = "video",
  ) {
    this.nodeClasses.set(
      promptId,
      new Map(Object.entries(prompt).map(([id, node]) => [id, node.class_type])),
    );
    this.mediaKinds.set(promptId, mediaKind);
    this.set(promptId, {
      phase: "submitted",
      phaseLabel: "Inviato a ComfyUI",
      progress: null,
      exact: false,
      currentNode: null,
    });
  }

  get(promptId: string) {
    return this.progress.get(promptId) ?? null;
  }

  nodeClass(promptId: string, nodeId?: string | null) {
    const resolvedNodeId = nodeId ?? this.progress.get(promptId)?.currentNode;
    return resolvedNodeId
      ? this.nodeClasses.get(promptId)?.get(resolvedNodeId) ?? null
      : null;
  }

  onTerminal(listener: TerminalListener) {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  get connected() {
    return this.socketConnected;
  }

  private connect() {
    if (this.stopped) return;
    const url = new URL(this.comfyBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
    url.search = new URLSearchParams({ clientId: this.clientId }).toString();

    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.socketConnected = true;
    });
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => this.scheduleReconnect());
    socket.addEventListener("error", () => socket.close());
  }

  private scheduleReconnect() {
    this.socketConnected = false;
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  private set(
    promptId: string,
    value: Omit<ComfyPromptProgress, "updatedAt">,
  ) {
    this.progress.set(promptId, {
      ...value,
      updatedAt: new Date().toISOString(),
    });
  }

  private update(
    promptId: string,
    value: Partial<Omit<ComfyPromptProgress, "updatedAt">>,
  ) {
    const current = this.progress.get(promptId);
    if (!current) return;
    this.progress.set(promptId, {
      ...current,
      ...value,
      updatedAt: new Date().toISOString(),
    });
  }

  private emitTerminal(event: ComfyPromptTerminalEvent) {
    for (const listener of this.terminalListeners) {
      try {
        void Promise.resolve(listener(event)).catch(() => undefined);
      } catch {
        // Cleanup listeners must never break ComfyUI progress handling.
      }
    }
  }

  private classifyNode(promptId: string, nodeId: string) {
    const classType = this.nodeClasses.get(promptId)?.get(nodeId) ?? "";
    if (/H3SaveContinuation|CreateVideo|FinalAudioRouter/i.test(classType)) {
      return { phase: "finalizing" as const, phaseLabel: "Finalizzazione video" };
    }
    if (/H3ReferenceMemorySampler/i.test(classType)) {
      return { phase: "preparing" as const, phaseLabel: "Preparazione modello" };
    }
    if (/AIO|OfficialPromptSkill|DaSiWa_LLM|ComposerPreValidator/i.test(classType)) {
      return { phase: "planning" as const, phaseLabel: "Autoprompter e validazione" };
    }
    if (/Loader|Lora|Attention|SigmaShift|VAE|Clip/i.test(classType)) {
      return { phase: "loading" as const, phaseLabel: "Caricamento modelli" };
    }
    return { phase: "loading" as const, phaseLabel: "Preparazione workflow" };
  }

  private handleMessage(raw: unknown) {
    if (typeof raw !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string" || !isRecord(message.data)) {
      return;
    }
    const promptId = promptIdFrom(message.data);
    if (!promptId || !this.progress.has(promptId)) return;

    if (message.type === "execution_start") {
      this.update(promptId, {
        phase: "loading",
        phaseLabel: "Avvio workflow",
        progress: null,
        exact: false,
      });
      return;
    }

    if (message.type === "executing" && typeof message.data.node === "string") {
      const nodeId = message.data.node;
      const classified = this.classifyNode(promptId, nodeId);
      this.update(promptId, {
        ...classified,
        progress: classified.phase === "finalizing" ? 100 : null,
        exact: false,
        currentNode: nodeId,
      });
      return;
    }

    if (message.type === "progress") {
      const value = Number(message.data.value);
      const max = Number(message.data.max);
      const progress =
        Number.isFinite(value) && Number.isFinite(max) && max > 0
          ? Math.max(0, Math.min(100, Math.round((value / max) * 100)))
          : null;
      this.update(promptId, {
        phase: "sampling",
        phaseLabel:
          this.mediaKinds.get(promptId) === "image"
            ? "Generazione immagine"
            : this.mediaKinds.get(promptId) === "audio"
              ? "Generazione audio"
              : "Generazione video",
        progress,
        exact: progress !== null,
        currentNode:
          typeof message.data.node === "string" ? message.data.node : null,
      });
      return;
    }

    if (message.type === "execution_success") {
      this.update(promptId, {
        phase: "completed",
        phaseLabel: "Completato",
        progress: 100,
        exact: true,
      });
      this.emitTerminal({ promptId, outcome: "completed" });
      return;
    }

    if (message.type === "execution_error" || message.type === "execution_interrupted") {
      this.update(promptId, {
        phase: "failed",
        phaseLabel: "Esecuzione fallita",
        progress: null,
        exact: false,
      });
      this.emitTerminal({ promptId, outcome: "failed" });
    }
  }
}
