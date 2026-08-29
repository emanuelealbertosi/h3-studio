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

export function parseLinuxProcessList(output: string): LlmRuntimeProcess[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (!match) return null;
      const pid = Number(match[1]);
      const commandName = match[2] ?? "";
      const commandLine = match[3] ?? "";
      const executable = commandLine.trim().split(/\s+/)[0] ?? "";
      const name = commandName.split("/").at(-1) ?? commandName;
      const executableName = executable.split("/").at(-1) ?? executable;
      return name === "llama-server" || executableName === "llama-server"
        ? { name: "llama-server", pid }
        : null;
    })
    .filter((process): process is LlmRuntimeProcess =>
      process !== null && Number.isInteger(process.pid) && process.pid > 0,
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
    try {
      if (this.platform === "win32") {
        const result = await this.run("tasklist.exe", [
          "/FI",
          "IMAGENAME eq llama-server.exe",
          "/FO",
          "CSV",
          "/NH",
        ]);
        return parseWindowsTaskList(result.stdout);
      }
      if (this.platform === "linux") {
        const result = await this.run("ps", ["-eo", "pid=,comm=,args="]);
        return parseLinuxProcessList(result.stdout);
      }
      return [];
    } catch {
      return [];
    }
  }

  private async gpuMemory() {
    try {
      const result = await this.run(this.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi", [
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
      supported: this.platform === "win32" || this.platform === "linux",
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
    if (this.platform === "win32") {
      await this.run("taskkill.exe", ["/PID", String(pid), "/F"]);
    } else if (this.platform === "linux") {
      await this.run("kill", ["-TERM", String(pid)]);
    } else {
      throw new Error(`Arresto LLM non supportato su ${this.platform}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    return { before, after: await this.status(), terminatedPid: pid };
  }
}
