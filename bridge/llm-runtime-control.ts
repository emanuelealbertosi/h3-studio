import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LlmRuntimeProcess = {
  pid: number;
  name: string;
};

export type LlmRuntimeStatus = {
  supported: boolean;
  processes: LlmRuntimeProcess[];
  gpu: { usedMiB: number; totalMiB: number } | null;
};

type CommandRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  values.push(current.trim());
  return values;
}

export function parseWindowsTaskList(output: string): LlmRuntimeProcess[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map(parseCsvLine)
    .map(([name, pid]) => ({ name, pid: Number(pid) }))
    .filter((process) =>
      process.name.toLowerCase() === "llama-server.exe" &&
      Number.isInteger(process.pid) &&
      process.pid > 0,
    );
}

export function parseNvidiaMemory(output: string) {
  const [used, total] = output.trim().split(/\s*,\s*/).map(Number);
  return Number.isFinite(used) && Number.isFinite(total) && total > 0
    ? { usedMiB: used, totalMiB: total }
    : null;
}

export class LlmRuntimeControl {
  constructor(
    private readonly platform = process.platform,
    private readonly run: CommandRunner = async (file, args) => {
      const result = await execFileAsync(file, args, {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    },
  ) {}

  private async processes() {
    if (this.platform !== "win32") return [];
    try {
      const result = await this.run("tasklist.exe", [
        "/FI",
        "IMAGENAME eq llama-server.exe",
        "/FO",
        "CSV",
        "/NH",
      ]);
      return parseWindowsTaskList(result.stdout);
    } catch {
      return [];
    }
  }

  private async gpuMemory() {
    try {
      const result = await this.run("nvidia-smi.exe", [
        "--query-gpu=memory.used,memory.total",
        "--format=csv,noheader,nounits",
      ]);
      return parseNvidiaMemory(result.stdout.split(/\r?\n/)[0] ?? "");
    } catch {
      return null;
    }
  }

  async status(): Promise<LlmRuntimeStatus> {
    const [processes, gpu] = await Promise.all([
      this.processes(),
      this.gpuMemory(),
    ]);
    return {
      supported: this.platform === "win32",
      processes,
      gpu,
    };
  }

  async terminate(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("PID LLM non valido");
    }
    const before = await this.status();
    if (!before.processes.some((process) => process.pid === pid)) {
      throw new Error(`Il PID ${pid} non è un processo llama-server attivo`);
    }
    await this.run("taskkill.exe", ["/PID", String(pid), "/F"]);
    await new Promise((resolve) => setTimeout(resolve, 700));
    return { before, after: await this.status(), terminatedPid: pid };
  }
}