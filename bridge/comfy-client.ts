export type ComfyQueueSummary = {
  running: number;
  pending: number;
};

export type ComfyHealth = {
  connected: boolean;
  url: string;
  latencyMs: number | null;
  queue: ComfyQueueSummary;
  error: string | null;
};

type QueueResponse = {
  queue_running?: unknown[];
  queue_pending?: unknown[];
};

function promptIdsFromQueue(items: unknown[] | undefined) {
  const ids = new Set<string>();
  for (const item of items ?? []) {
    if (Array.isArray(item) && typeof item[1] === "string") ids.add(item[1]);
  }
  return ids;
}

export type ComfyQueuePromptResponse = {
  prompt_id?: string;
  number?: number;
  node_errors?: Record<string, unknown>;
};

export type ComfyApiNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export type ComfyApiPrompt = Record<string, ComfyApiNode>;

export type ComfyHistoryEntry = {
  prompt?: unknown[];
  outputs?: Record<string, unknown>;
  status?: Record<string, unknown>;
};

export type ComfyHistory = Record<string, ComfyHistoryEntry>;

function errorMessage(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") {
    return "ComfyUI non ha risposto entro il timeout";
  }
  if (error instanceof Error) return error.message;
  return "Errore sconosciuto durante la connessione a ComfyUI";
}

export class ComfyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  private async requestJson<T>(
    path: string,
    init: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`ComfyUI ha risposto HTTP ${response.status}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestVoid(path: string, body?: unknown) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`ComfyUI ha risposto HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<ComfyHealth> {
    const startedAt = performance.now();

    try {
      const [, queue] = await Promise.all([
        this.requestJson<Record<string, unknown>>("/system_stats"),
        this.requestJson<QueueResponse>("/queue"),
      ]);

      return {
        connected: true,
        url: this.baseUrl,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        queue: {
          running: Array.isArray(queue.queue_running)
            ? queue.queue_running.length
            : 0,
          pending: Array.isArray(queue.queue_pending)
            ? queue.queue_pending.length
            : 0,
        },
        error: null,
      };
    } catch (error) {
      return {
        connected: false,
        url: this.baseUrl,
        latencyMs: null,
        queue: { running: 0, pending: 0 },
        error: errorMessage(error),
      };
    }
  }

  async chatStatus() {
    return this.requestJson<{
      ok: boolean;
      ready: boolean;
      loaded: boolean;
      runtimeVersion?: string | null;
      error?: string | null;
      models: string[];
      projectors: string[];
    }>("/h3_studio/chat/status");
  }

  async chatGenerate(body: unknown) {
    return this.requestJson<{ ok: boolean; text?: string; model?: string; error?: string }>(
      "/h3_studio/chat",
      { method: "POST", body, timeoutMs: 15 * 60_000 },
    );
  }

  async chatUnload() {
    return this.requestJson<{ ok: boolean; loaded: boolean }>(
      "/h3_studio/chat/unload",
      { method: "POST", timeoutMs: 120_000 },
    );
  }

  async freeMemory(unloadModels = true) {
    await this.requestVoid("/free", {
      unload_models: unloadModels,
      free_memory: true,
    });
  }

  async history(maxItems = 50): Promise<ComfyHistory> {
    const safeMaxItems = Math.min(200, Math.max(1, Math.trunc(maxItems)));
    return this.requestJson<ComfyHistory>(
      `/history?max_items=${safeMaxItems}`,
    );
  }

  async queuePrompt(prompt: ComfyApiPrompt, clientId: string) {
    const response = await this.requestJson<ComfyQueuePromptResponse>(
      "/prompt",
      {
        method: "POST",
        body: { prompt, client_id: clientId },
      },
    );

    if (!response.prompt_id) {
      throw new Error("ComfyUI non ha restituito prompt_id");
    }
    if (response.node_errors && Object.keys(response.node_errors).length > 0) {
      throw new Error("ComfyUI ha rifiutato uno o più nodi del workflow");
    }

    return {
      promptId: response.prompt_id,
      queueNumber: response.number ?? null,
    };
  }

  async queueState() {
    const queue = await this.requestJson<QueueResponse>("/queue");
    return {
      runningPromptIds: promptIdsFromQueue(queue.queue_running),
      pendingPromptIds: promptIdsFromQueue(queue.queue_pending),
    };
  }

  async cancelPrompts(promptIds: string[]) {
    const requested = new Set(promptIds.filter(Boolean));
    if (requested.size === 0) return { interrupted: false, deleted: [] as string[] };
    const queue = await this.queueState();
    const pending = [...requested].filter((id) => queue.pendingPromptIds.has(id));
    const running = [...requested].filter((id) => queue.runningPromptIds.has(id));
    if (pending.length > 0) await this.requestVoid("/queue", { delete: pending });
    if (running.length > 0) {
      const unrelatedRunning = [...queue.runningPromptIds].filter((id) => !requested.has(id));
      if (unrelatedRunning.length > 0) {
        throw new Error(
          "Stop non eseguito: ComfyUI sta processando anche un prompt estraneo a questo run.",
        );
      }
      await this.requestVoid("/interrupt");
    }
    return { interrupted: running.length > 0, deleted: pending };
  }

  async mediaResponse(
    filename: string,
    subfolder: string,
    type: "input" | "output" | "temp",
    range?: string,
  ) {
    const query = new URLSearchParams({ filename, subfolder, type });
    return fetch(`${this.baseUrl}/view?${query.toString()}`, {
      headers: range ? { range } : undefined,
    });
  }

  async uploadMedia(body: Uint8Array, contentType: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 120_000));
    try {
      const response = await fetch(`${this.baseUrl}/minimax_h3/upload`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": contentType },
        body: body as unknown as BodyInit,
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        file?: string;
        name?: string;
        original?: string;
        kind?: "picture" | "video" | "audio";
        size?: number;
        duration?: number | null;
        has_audio?: boolean;
        width?: number | null;
        height?: number | null;
      };
      if (!response.ok || !payload.file || !payload.kind) {
        throw new Error(payload.error ?? `Upload ComfyUI HTTP ${response.status}`);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async models(folder: "diffusion_models" | "loras" | "text_encoders" | "vae") {
    const models = await this.requestJson<unknown>(`/models/${folder}`);
    if (!Array.isArray(models)) return [];
    return models.filter((item): item is string => typeof item === "string");
  }

  async modelFiles(folder:
    | "diffusion_models"
    | "text_encoders"
    | "vae"
    | "loras"
    | "pdd_acc"
    | "latent_upscale_models"
    | "llm"
    | "ultralytics_bbox"
  ) {
    const models = await this.requestJson<unknown>(`/models/${folder}`);
    if (!Array.isArray(models)) return [];
    return models.filter((item): item is string => typeof item === "string");
  }

  async objectInfo(nodeName: string) {
    return this.requestJson<Record<string, unknown>>(
      `/object_info/${encodeURIComponent(nodeName)}`,
    );
  }
}
