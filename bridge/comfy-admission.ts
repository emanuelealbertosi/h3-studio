import type { ComfyClient } from "./comfy-client.js";

export class ComfyBusyError extends Error {
  readonly code = "COMFY_BUSY";

  constructor(message: string) {
    super(message);
    this.name = "ComfyBusyError";
  }
}

type AdmissionStatus = {
  busy: boolean;
  activity: string | null;
  running: number;
  pending: number;
};

/**
 * Serializes the short admission phase for every operation that can load a
 * model or enqueue work in ComfyUI. The admitted callback may enqueue a whole
 * batch; once it returns, ComfyUI's own queue keeps subsequent operations out.
 */
export class ComfyAdmissionController {
  private mutex: Promise<void> = Promise.resolve();
  private active: { token: symbol; activity: string } | null = null;

  constructor(private readonly comfy: ComfyClient) {}

  private async locked<T>(callback: () => Promise<T> | T): Promise<T> {
    const previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async status(): Promise<AdmissionStatus> {
    const queue = await this.comfy.queueState();
    return {
      busy: this.active !== null
        || queue.runningPromptIds.size > 0
        || queue.pendingPromptIds.size > 0,
      activity: this.active?.activity ?? null,
      running: queue.runningPromptIds.size,
      pending: queue.pendingPromptIds.size,
    };
  }

  async run<T>(activity: string, callback: () => Promise<T>): Promise<T> {
    const token = Symbol(activity);
    await this.locked(async () => {
      if (this.active) {
        throw new ComfyBusyError(
          `Motore occupato: ${this.active.activity}. Attendi il completamento oppure interrompi il job in corso.`,
        );
      }

      const queue = await this.comfy.queueState();
      const running = queue.runningPromptIds.size;
      const pending = queue.pendingPromptIds.size;
      if (running > 0 || pending > 0) {
        const details = [
          running > 0 ? `${running} in esecuzione` : "",
          pending > 0 ? `${pending} in coda` : "",
        ].filter(Boolean).join(", ");
        throw new ComfyBusyError(
          `ComfyUI è occupata (${details}). Attendi il completamento oppure interrompi il job prima di inviare un’altra richiesta.`,
        );
      }

      this.active = { token, activity };
    });

    try {
      return await callback();
    } finally {
      await this.locked(() => {
        if (this.active?.token === token) this.active = null;
      });
    }
  }
}

export function isComfyBusyError(error: unknown): error is ComfyBusyError {
  return error instanceof ComfyBusyError;
}
