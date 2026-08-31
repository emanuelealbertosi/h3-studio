import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SamRuntimeProcess = {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
};

type CommandRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

function normalizeProcess(value: unknown): SamRuntimeProcess | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const pid = Number(item.ProcessId ?? item.pid);
  const parentPid = Number(item.ParentProcessId ?? item.parentPid ?? 0);
  const name = String(item.Name ?? item.name ?? "");
  const commandLine = String(item.CommandLine ?? item.commandLine ?? "");
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(name)) return null;
  if (!/persistent_worker\.py/i.test(commandLine)) return null;
  if (!/(?:comfyui[-_]sam3|sam3[-_]nodes)/i.test(commandLine)) return null;
  return { pid, parentPid, name, commandLine };
}

export function parseWindowsSamWorkers(output: string): SamRuntimeProcess[] {
  const text = output.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .map(normalizeProcess)
      .filter((item): item is SamRuntimeProcess => item !== null);
  } catch {
    return [];
  }
}

export function parseLinuxSamWorkers(output: string): SamRuntimeProcess[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(\S+)\s+([\s\S]+)$/.exec(line);
      if (!match) return null;
      return normalizeProcess({
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        name: match[3],
        commandLine: match[4],
      });
    })
    .filter((item): item is SamRuntimeProcess => item !== null);
}

export class SamRuntimeControl {
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

  async processes() {
    try {
      if (this.platform === "win32") {
        const command = [
          "Get-CimInstance Win32_Process",
          "Where-Object { $_.Name -match '^python(?:\\d+(?:\\.\\d+)*)?(?:\\.exe)?$' -and $_.CommandLine -like '*persistent_worker.py*' -and ($_.CommandLine -match '(?i)(comfyui[-_]sam3|sam3[-_]nodes)') }",
          "Select-Object ProcessId,ParentProcessId,Name,CommandLine",
          "ConvertTo-Json -Compress",
        ].join(" | ");
        const result = await this.run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          command,
        ]);
        return parseWindowsSamWorkers(result.stdout);
      }
      if (this.platform === "linux") {
        const result = await this.run("ps", ["-eo", "pid=,ppid=,comm=,args="]);
        return parseLinuxSamWorkers(result.stdout);
      }
      return [];
    } catch {
      return [];
    }
  }

  async release() {
    const before = await this.processes();
    for (const worker of before) {
      try {
        if (this.platform === "win32") {
          await this.run("taskkill.exe", ["/PID", String(worker.pid), "/T", "/F"]);
        } else if (this.platform === "linux") {
          await this.run("kill", ["-TERM", String(worker.pid)]);
        }
      } catch {
        // The isolated worker may already have exited while the job advanced.
      }
    }
    if (before.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { before, after: await this.processes() };
  }
}
