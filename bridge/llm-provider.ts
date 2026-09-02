import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ComfyClient } from "./comfy-client.js";
import type { RuntimeSettingsStore } from "./runtime-settings.js";

export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };
export type LlmPurpose = "planner" | "chat";
export type LlmRequest = {
  messages: LlmMessage[];
  purpose?: LlmPurpose;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
};
export type LlmResult = {
  ok: boolean;
  text?: string;
  model?: string;
  backend: "local" | "remote";
  fallbackUsed: boolean;
  error?: string;
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function endpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/chat\/completions$/i.test(pathname)
    ? pathname
    : `${pathname}/chat/completions`.replace(/\/{2,}/g, "/");
  return url.toString();
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map((part) =>
    typeof part === "string" ? part
      : typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text : ""
  ).join("").trim();
}

export class PlannerSecretStore {
  readonly filePath: string;
  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "planner-api-key.txt");
  }
  async get() {
    try { return (await readFile(this.filePath, "utf8")).trim(); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    }
  }
  async has() { return Boolean(await this.get()); }
  async set(value: unknown) {
    const key = typeof value === "string" ? value.trim() : "";
    if (!key) throw new Error("La chiave API non puo essere vuota");
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    const backup = `${this.filePath}.bak`;
    await writeFile(temporary, `${key}\n`, { encoding: "utf8", mode: 0o600 });
    await rm(backup, { force: true });
    let previousMoved = false;
    try {
      await rename(this.filePath, backup);
      previousMoved = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        await rm(temporary, { force: true });
        throw error;
      }
    }
    try {
      await rename(temporary, this.filePath);
    } catch (error) {
      if (previousMoved) await rename(backup, this.filePath).catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
    await rm(backup, { force: true });
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }
  async clear() { await rm(this.filePath, { force: true }); }
}

export class LlmProviderService {
  constructor(
    private readonly comfy: ComfyClient,
    private readonly settingsStore: RuntimeSettingsStore,
    private readonly secrets: PlannerSecretStore,
  ) {}

  async unloadLocal() {
    await this.comfy.chatUnload().catch(() => undefined);
  }

  async status(purpose: LlmPurpose = "planner") {
    const settings = await this.settingsStore.get();
    const remote = settings.planner.backend !== "local" &&
      (purpose === "planner" || settings.planner.useForChat);
    const apiKeyConfigured = await this.secrets.has();
    if (remote) return {
      ready: Boolean(settings.planner.baseUrl && settings.planner.model),
      backend: "remote" as const,
      configuredBackend: settings.planner.backend,
      model: settings.planner.model,
      baseUrl: settings.planner.baseUrl,
      apiKeyConfigured,
      fallbackLocal: settings.planner.backend === "auto",
      error: settings.planner.baseUrl && settings.planner.model
        ? null : "Configura URL e modello del planner remoto",
    };
    const local = await this.comfy.chatStatus().catch((error) => ({
      ready: false, loaded: false, error: errorText(error),
    }));
    return {
      ...local,
      ready: local.ready === true,
      backend: "local" as const,
      configuredBackend: settings.planner.backend,
      model: settings.chat.model,
      baseUrl: null,
      apiKeyConfigured,
      fallbackLocal: false,
    };
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    const settings = await this.settingsStore.get();
    const purpose = request.purpose ?? "planner";
    const remote = settings.planner.backend !== "local" &&
      (purpose === "planner" || settings.planner.useForChat);
    if (!remote) return this.local(request, false);
    try { return await this.remote(request); }
    catch (error) {
      if (settings.planner.backend !== "auto") {
        return { ok: false, backend: "remote", fallbackUsed: false, error: errorText(error) };
      }
      const local = await this.local(request, true);
      if (!local.ok) local.error =
        `API remota: ${errorText(error)} - fallback locale: ${local.error ?? "errore sconosciuto"}`;
      return local;
    }
  }

  async testRemote(overrides?: { baseUrl?: unknown; model?: unknown; apiKey?: unknown }) {
    const settings = await this.settingsStore.get();
    const baseUrl = typeof overrides?.baseUrl === "string" && overrides.baseUrl.trim()
      ? overrides.baseUrl.trim() : settings.planner.baseUrl;
    const model = typeof overrides?.model === "string" && overrides.model.trim()
      ? overrides.model.trim() : settings.planner.model;
    const apiKey = typeof overrides?.apiKey === "string" && overrides.apiKey.trim()
      ? overrides.apiKey.trim() : await this.secrets.get();
    const started = performance.now();
    const response = await this.request({
      baseUrl, model, apiKey,
      timeoutSeconds: Math.min(settings.planner.timeoutSeconds, 60),
      messages: [
        { role: "system", content: "Reply with exactly H3_OK and nothing else." },
        { role: "user", content: "Connection test" },
      ],
      maxTokens: 16, temperature: 0, topP: 1,
    });
    return {
      ok: true, backend: "remote" as const, model,
      response: response.slice(0, 100),
      latencyMs: Math.round(performance.now() - started),
    };
  }

  private async local(request: LlmRequest, fallbackUsed: boolean): Promise<LlmResult> {
    const settings = (await this.settingsStore.get()).chat;
    try {
      const result = await this.comfy.chatGenerate({
        model: settings.model, projector: settings.projector,
        n_ctx: settings.nCtx, n_gpu_layers: settings.nGpuLayers,
        n_threads: settings.nThreads,
        max_tokens: request.maxTokens ?? settings.maxNewTokens,
        temperature: request.temperature ?? settings.temperature,
        top_p: request.topP ?? settings.topP,
        messages: request.messages, images: [],
      });
      return { ...result, backend: "local", fallbackUsed };
    } catch (error) {
      return { ok: false, backend: "local", fallbackUsed, error: errorText(error) };
    }
  }

  private async remote(request: LlmRequest): Promise<LlmResult> {
    const settings = (await this.settingsStore.get()).planner;
    const text = await this.request({
      baseUrl: settings.baseUrl,
      model: settings.model,
      timeoutSeconds: settings.timeoutSeconds,
      apiKey: await this.secrets.get(),
      messages: request.messages,
      maxTokens: Math.min(request.maxTokens ?? settings.maxTokens, settings.maxTokens),
      temperature: settings.temperature,
      topP: settings.topP,
    });
    return {
      ok: true, text, model: settings.model,
      backend: "remote", fallbackUsed: false,
    };
  }

  private async request(value: {
    baseUrl: string; model: string; apiKey: string; timeoutSeconds: number;
    messages: LlmMessage[]; maxTokens: number; temperature: number; topP: number;
  }) {
    if (!value.baseUrl.trim()) throw new Error("URL planner remoto mancante");
    if (!value.model.trim()) throw new Error("Nome modello remoto mancante");
    let url: string;
    try { url = endpoint(value.baseUrl.trim()); }
    catch { throw new Error("URL planner remoto non valido"); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), value.timeoutSeconds * 1000);
    try {
      const response = await fetch(url, {
        method: "POST", signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(value.apiKey ? { authorization: `Bearer ${value.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: value.model, messages: value.messages,
          max_tokens: value.maxTokens, temperature: value.temperature, top_p: value.topP,
        }),
      });
      const raw = await response.text();
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { /* handled below */ }
      if (!response.ok) {
        const detail = typeof parsed === "object" && parsed !== null && "error" in parsed
          ? JSON.stringify(parsed.error) : raw;
        throw new Error(`Planner remoto HTTP ${response.status}: ${detail.slice(0, 1000)}`);
      }
      const choices = typeof parsed === "object" && parsed !== null && "choices" in parsed
        ? parsed.choices : null;
      const first = Array.isArray(choices) ? choices[0] : null;
      const message = typeof first === "object" && first !== null && "message" in first
        ? first.message : null;
      const content = typeof message === "object" && message !== null && "content" in message
        ? contentText(message.content) : "";
      if (!content) throw new Error("Il planner remoto ha restituito una risposta vuota");
      return content;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Timeout del planner remoto");
      throw error;
    } finally { clearTimeout(timer); }
  }
}
