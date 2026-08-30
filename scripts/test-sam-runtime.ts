import assert from "node:assert/strict";
import {
  parseLinuxSamWorkers,
  parseWindowsSamWorkers,
  SamRuntimeControl,
} from "../bridge/sam-runtime-control.js";
import { ComfyProgressTracker } from "../bridge/comfy-progress.js";

const windows = parseWindowsSamWorkers(JSON.stringify({
  ProcessId: 22812,
  ParentProcessId: 23008,
  Name: "python.exe",
  CommandLine: "python.exe C:\\Temp\\persistent_worker.py tcp://127.0.0.1:30729 sam3-nodes",
}));
assert.equal(windows.length, 1);
assert.equal(windows[0]?.pid, 22812);
assert.equal(parseWindowsSamWorkers("not-json").length, 0);

const linux = parseLinuxSamWorkers([
  "22812 23008 python python /tmp/persistent_worker.py unix:///tmp/socket sam3-nodes",
  "100 1 python python unrelated.py",
].join("\n"));
assert.equal(linux.length, 1);
assert.equal(linux[0]?.parentPid, 23008);

const calls: Array<{ file: string; args: string[] }> = [];
let statusCalls = 0;
const control = new SamRuntimeControl("win32", async (file, args) => {
  calls.push({ file, args });
  if (file === "powershell.exe") {
    statusCalls += 1;
    return {
      stdout: statusCalls === 1
        ? JSON.stringify({
            ProcessId: 22812,
            ParentProcessId: 23008,
            Name: "python.exe",
            CommandLine: "python persistent_worker.py sam3-nodes",
          })
        : "",
      stderr: "",
    };
  }
  return { stdout: "", stderr: "" };
}, 0);
const released = await control.release();
assert.equal(released.before.length, 1);
assert.equal(released.after.length, 0);
assert.equal(calls.some((call) => call.file === "taskkill.exe"), true);

const progress = new ComfyProgressTracker("http://127.0.0.1:9000");
const terminalEvents: Array<{ promptId: string; outcome: string }> = [];
progress.onTerminal((event) => {
  terminalEvents.push(event);
});
progress.register("sam-prompt", {
  "42": { class_type: "SAM3Propagate", inputs: {} },
  "99": { class_type: "H3ReferenceMemorySampler", inputs: {} },
});
const handleMessage = (
  progress as unknown as { handleMessage(raw: unknown): void }
).handleMessage.bind(progress);
handleMessage(JSON.stringify({
  type: "executing",
  data: { prompt_id: "sam-prompt", node: "99" },
}));
assert.equal(progress.nodeClass("sam-prompt"), "H3ReferenceMemorySampler");
handleMessage(JSON.stringify({
  type: "execution_interrupted",
  data: { prompt_id: "sam-prompt" },
}));
await Promise.resolve();
assert.deepEqual(terminalEvents, [
  { promptId: "sam-prompt", outcome: "failed" },
]);

console.log("SAM isolated runtime cleanup test passed");
