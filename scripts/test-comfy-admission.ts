import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ComfyAdmissionController, ComfyBusyError } from "../bridge/comfy-admission.js";
import { ComfyClient } from "../bridge/comfy-client.js";

let runningIds: string[] = [];
let pendingIds: string[] = [];

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/queue") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      queue_running: runningIds.map((id, index) => [index, id]),
      queue_pending: pendingIds.map((id, index) => [index, id]),
    }));
    return;
  }
  response.statusCode = 404;
  response.end();
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");

const comfy = new ComfyClient(`http://127.0.0.1:${address.port}`, 2_000);
const admission = new ComfyAdmissionController(comfy);

let releaseFirst!: () => void;
const firstCanFinish = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});
let firstStarted = false;
const first = admission.run("prima generazione", async () => {
  firstStarted = true;
  await firstCanFinish;
  return "done";
});

while (!firstStarted) await new Promise((resolve) => setTimeout(resolve, 1));
await assert.rejects(
  admission.run("seconda generazione", async () => "should-not-run"),
  (error: unknown) => error instanceof ComfyBusyError && /prima generazione/i.test(error.message),
);

releaseFirst();
assert.equal(await first, "done");
assert.equal(await admission.run("nuova generazione", async () => "accepted"), "accepted");

runningIds = ["external-running"];
await assert.rejects(
  admission.run("planner LLM", async () => "should-not-run"),
  (error: unknown) => error instanceof ComfyBusyError && /1 in esecuzione/i.test(error.message),
);

runningIds = [];
pendingIds = ["external-pending"];
await assert.rejects(
  admission.run("planner LLM", async () => "should-not-run"),
  (error: unknown) => error instanceof ComfyBusyError && /1 in coda/i.test(error.message),
);

server.close();
await once(server, "close");
console.log("ComfyUI admission controller: OK");
