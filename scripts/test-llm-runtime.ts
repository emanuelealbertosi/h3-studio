import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LlmRuntimeControl,
  parseLinuxProcessList,
  parseNvidiaMemory,
  parseWindowsTaskList,
} from "../bridge/llm-runtime-control.js";

const taskList = '"llama-server.exe","284","Console","1","1,234 K"\r\n' +
  '"python.exe","29996","Console","1","2,345 K"\r\n';
assert.deepEqual(parseWindowsTaskList(taskList), [
  { name: "llama-server.exe", pid: 284 },
]);
assert.deepEqual(parseLinuxProcessList(
  "  284 llama-server /opt/llama.cpp/llama-server --model planner.gguf\n" +
  "29996 python3 python3 worker.py\n",
), [{ name: "llama-server", pid: 284 }]);
assert.deepEqual(parseNvidiaMemory("10240, 16303\r\n"), {
  usedMiB: 10240,
  totalMiB: 16303,
});
assert.equal(parseNvidiaMemory("N/A, N/A"), null);

const adminSource = readFileSync(path.join(process.cwd(), "app", "page.tsx"), "utf8");
assert.match(adminSource, /llmResponse\.status === 404/);
assert.match(adminSource, /Controllo LLM disponibile dopo il riavvio del bridge/);

let active = true;
const calls: Array<{ file: string; args: string[] }> = [];
const runtime = new LlmRuntimeControl("win32", async (file, args) => {
  calls.push({ file, args });
  if (file === "tasklist.exe") {
    return {
      stdout: active ? '"llama-server.exe","284","Console","1","1,234 K"\r\n' : "INFO: No tasks are running",
      stderr: "",
    };
  }
  if (file === "nvidia-smi.exe") {
    return { stdout: active ? "10240, 16303\r\n" : "900, 16303\r\n", stderr: "" };
  }
  if (file === "taskkill.exe") {
    assert.deepEqual(args, ["/PID", "284", "/F"]);
    active = false;
    return { stdout: "SUCCESS", stderr: "" };
  }
  throw new Error("Comando inatteso: " + file);
});

const before = await runtime.status();
assert.equal(before.processes[0]?.pid, 284);
assert.equal(before.gpu?.usedMiB, 10240);
const stopped = await runtime.terminate(284);
assert.equal(stopped.terminatedPid, 284);
assert.deepEqual(stopped.after.processes, []);
assert.equal(stopped.after.gpu?.usedMiB, 900);
assert.equal(calls.some((call) => call.file === "taskkill.exe"), true);
await assert.rejects(() => runtime.terminate(29996), /non è un processo llama-server attivo/);

let linuxActive = true;
const linuxCalls: Array<{ file: string; args: string[] }> = [];
const linuxRuntime = new LlmRuntimeControl("linux", async (file, args) => {
  linuxCalls.push({ file, args });
  if (file === "ps") {
    return {
      stdout: linuxActive ? "  812 llama-server /usr/local/bin/llama-server --model planner.gguf\n" : "",
      stderr: "",
    };
  }
  if (file === "nvidia-smi") return { stdout: "2048, 16303\n", stderr: "" };
  if (file === "kill") {
    assert.deepEqual(args, ["-TERM", "812"]);
    linuxActive = false;
    return { stdout: "", stderr: "" };
  }
  throw new Error("Comando Linux inatteso: " + file);
});
const linuxBefore = await linuxRuntime.status();
assert.equal(linuxBefore.supported, true);
assert.equal(linuxBefore.processes[0]?.pid, 812);
assert.equal(linuxBefore.gpu?.usedMiB, 2048);
const linuxStopped = await linuxRuntime.terminate(812);
assert.deepEqual(linuxStopped.after.processes, []);
assert.equal(linuxCalls.some((call) => call.file === "kill"), true);

console.log("Admin LLM runtime control: OK");
