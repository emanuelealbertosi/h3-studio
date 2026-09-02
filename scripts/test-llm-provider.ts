import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  LlmProviderService,
  PlannerSecretStore,
} from "../bridge/llm-provider.js";
import {
  injectRemoteVideoPlan,
  planH3Video,
  validateRemoteVideoPlan,
} from "../bridge/video-prompt-planner.js";
import type { ComfyClient } from "../bridge/comfy-client.js";
import type { RuntimeSettingsStore } from "../bridge/runtime-settings.js";
import type { StudioJobRequest } from "../bridge/studio-job.js";

let failRemote = false;
let receivedAuth = "";
let receivedPath = "";
let receivedBody: Record<string, unknown> = {};
const server = createServer((request, response) => {
  receivedPath = request.url ?? "";
  receivedAuth = String(request.headers.authorization ?? "");
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  request.once("end", () => {
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.setHeader("content-type", "application/json");
    if (failRemote) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { message: "offline" } }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{ message: { content: "REMOTE_OK" } }],
    }));
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address === "object");

const temporary = await mkdtemp(path.join(os.tmpdir(), "h3-planner-"));
const secrets = new PlannerSecretStore(temporary);
await secrets.set("old-secret");
await secrets.set("secret-value");
assert.equal(await secrets.get(), "secret-value");
const settings = {
  planner: {
    backend: "remote" as "local" | "remote" | "auto",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "remote-model",
    timeoutSeconds: 10,
    maxTokens: 4096,
    temperature: 0.2,
    topP: 0.9,
    useForChat: true,
  },
  chat: {
    model: "local.gguf",
    projector: "mmproj.gguf",
    nCtx: 16384,
    nGpuLayers: -1,
    nThreads: 8,
    maxNewTokens: 1536,
    temperature: 0.35,
    topP: 0.9,
  },
};
let localCalls = 0;
const comfy = {
  chatGenerate: async () => {
    localCalls += 1;
    return { ok: true, text: "LOCAL_OK", model: "local.gguf" };
  },
  chatStatus: async () => ({ ok: true, ready: true, loaded: false }),
  chatUnload: async () => ({ ok: true, loaded: false }),
} as unknown as ComfyClient;
const settingsStore = {
  get: async () => settings,
} as unknown as RuntimeSettingsStore;
const provider = new LlmProviderService(comfy, settingsStore, secrets);

const remote = await provider.generate({
  purpose: "planner",
  maxTokens: 8_192,
  temperature: 1.5,
  topP: 0.1,
  messages: [{ role: "user", content: "test" }],
});
assert.equal(remote.text, "REMOTE_OK");
assert.equal(remote.backend, "remote");
assert.equal(receivedPath, "/v1/chat/completions");
assert.equal(receivedAuth, "Bearer secret-value");
assert.equal(receivedBody.max_tokens, 4_096);
assert.equal(receivedBody.temperature, 0.2);
assert.equal(receivedBody.top_p, 0.9);
assert.equal(localCalls, 0);

failRemote = true;
settings.planner.backend = "auto";
const fallback = await provider.generate({
  purpose: "planner",
  messages: [{ role: "user", content: "fallback" }],
});
assert.equal(fallback.text, "LOCAL_OK");
assert.equal(fallback.backend, "local");
assert.equal(fallback.fallbackUsed, true);
assert.equal(localCalls, 1);

const request = {
  videoEngine: "h3",
  generationMode: "T2V",
  shotCount: 1,
} as StudioJobRequest;
const plan = '{"mode":"T2V","continuity_bible":"stable","shots":[{"description":"[Shot 1] scene","soundscape":"N/A","music":"N/A"}]}';
assert.equal(validateRemoteVideoPlan("~~~json\n" + plan + "\n~~~", request), plan);
assert.throws(
  () => validateRemoteVideoPlan(plan.replace('"T2V"', '"I2V"'), request),
  /modalita video diversa/,
);
const prompt = {
  "70": {
    class_type: "H3AIOComposerPreValidator",
    inputs: { llm_response: ["64", 0] },
  },
};
injectRemoteVideoPlan(prompt, plan);
assert.equal(prompt["70"].inputs.llm_response, plan);

type AudioRole = "music_video_lipsync" | "exact_soundtrack" |
  "exact_soundtrack_plus_h3_sfx" | "voice_ref" | "ignore" | "reference_audio";
let capturedPlannerPrompt = "";
const remotePlanLlm = {
  generate: async (value: { messages: Array<{ content: string }> }) => {
    capturedPlannerPrompt = value.messages.at(-1)?.content ?? "";
    return {
      ok: true,
      backend: "remote" as const,
      fallbackUsed: false,
      text: JSON.stringify({
        mode: "R2V",
        subject_definitions: "Picture 1 is the visual reference.",
        task_types: ["reference generation", "audio reference"],
        summary: "Test plan.",
        retention_analysis: "Preserve Picture 1.",
        style: "Natural.",
        shots: [{
          description: "[Shot 1] The subject performs with <Audio 1>.",
          soundscape: "Room tone.",
          music: "Generated score.",
          active_ref_images: [1],
          active_ref_videos: [],
          active_ref_audios: [1],
        }],
      }),
    };
  },
} as unknown as LlmProviderService;

async function audioPlan(role: AudioRole, muteDiegetic = false) {
  const videoRequest = {
    prompt: "Create a synchronized performance",
    videoEngine: "h3",
    generationMode: "R2V",
    shotCount: 1,
    durationSeconds: 10,
    mediaState: JSON.stringify([
      { kind: "picture", file: "picture.png" },
      { kind: "audio", file: "audio.wav", audio_role: role },
    ]),
    referenceRoles: "Picture 1: performer",
    keyframePositions: "AUTO",
    sourceVideoAudio: "AUTO",
    muteDiegetic,
    muteNonDiegetic: false,
  } as StudioJobRequest;
  const result = await planH3Video(remotePlanLlm, videoRequest);
  return JSON.parse(result.response) as {
    shots: Array<Record<string, unknown>>;
  };
}

for (const role of [
  "music_video_lipsync",
  "exact_soundtrack",
  "exact_soundtrack_plus_h3_sfx",
] as const) {
  const routed = await audioPlan(role);
  assert.deepEqual(routed.shots[0].active_ref_audios, []);
  assert.equal(routed.shots[0].music, "N/A");
  assert.doesNotMatch(String(routed.shots[0].description), /<Audio 1>/i);
}
const ignored = await audioPlan("ignore");
assert.deepEqual(ignored.shots[0].active_ref_audios, []);
assert.doesNotMatch(String(ignored.shots[0].description), /<Audio 1>/i);
const lipsync = await audioPlan("music_video_lipsync");
assert.match(String(lipsync.shots[0].description), /<Soundtrack>/);
assert.match(capturedPlannerPrompt, /active_ref_audios array to \[\]/);
const voice = await audioPlan("voice_ref");
assert.deepEqual(voice.shots[0].active_ref_audios, [1]);
assert.match(capturedPlannerPrompt, /include audio reference in task_types/);
const mutedVoice = await audioPlan("voice_ref", true);
assert.deepEqual(mutedVoice.shots[0].active_ref_audios, []);
assert.equal(mutedVoice.shots[0].soundscape, "N/A");
const reference = await audioPlan("reference_audio");
assert.deepEqual(reference.shots[0].active_ref_audios, [1]);

await secrets.clear();
assert.equal(await secrets.has(), false);
server.close();
await once(server, "close");
await rm(temporary, { recursive: true, force: true });
console.log("LLM provider remoto e Video H3 planner: OK");
