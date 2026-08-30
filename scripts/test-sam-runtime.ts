import assert from "node:assert/strict";
import {
  parseLinuxSamWorkers,
  parseWindowsSamWorkers,
  SamRuntimeControl,
} from "../bridge/sam-runtime-control.js";

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
});
const released = await control.release();
assert.equal(released.before.length, 1);
assert.equal(released.after.length, 0);
assert.equal(calls.some((call) => call.file === "taskkill.exe"), true);

console.log("SAM isolated runtime cleanup test passed");
