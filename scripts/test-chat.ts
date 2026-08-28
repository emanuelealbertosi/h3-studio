import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatRepository } from "../bridge/chat-repository.js";
import { routeAction } from "../bridge/chat-service.js";
import { JobRepository } from "../bridge/job-repository.js";
import { ProjectRepository } from "../bridge/project-repository.js";
import { DEFAULT_RUNTIME_SETTINGS, RuntimeSettingsStore } from "../bridge/runtime-settings.js";

const temp = mkdtempSync(path.join(os.tmpdir(), "h3-chat-test-"));
try {
  const jobs = new JobRepository(temp);
  const projects = new ProjectRepository(jobs.databasePath);
  const project = projects.create("Chat test");
  assert.ok(project?.id);
  const chat = new ChatRepository(jobs.databasePath);
  chat.add({ projectId: project!.id, role: "user", content: "Ciao" });
  chat.add({
    projectId: project!.id,
    role: "assistant",
    content: "Ciao!",
    action: { type: "generate_video", prompt: "A bright cinematic shot", status: "started", jobId: "job-1" },
  });
  const messages = chat.list(project!.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].action?.jobId, "job-1");
  const initialContext = chat.context(project!.id);
  assert.equal(initialContext.summary, "");
  assert.equal(initialContext.messages.length, 2);
  chat.updateMemory(project!.id, "Il progetto usa uno stile anime luminoso.", initialContext.messages[0].sequence);
  const compactedContext = chat.context(project!.id);
  assert.match(compactedContext.summary, /stile anime/);
  assert.equal(compactedContext.messages.length, 1);
  assert.equal(chat.memoryStatus(project!.id).summarizedMessages, 1);
  chat.clear(project!.id);
  assert.equal(chat.list(project!.id).length, 0);
  assert.equal(chat.memoryStatus(project!.id).active, false);
  chat.close(); projects.close(); jobs.close();

  const runtime = await new RuntimeSettingsStore(temp).get();
  assert.equal(runtime.chat.model, DEFAULT_RUNTIME_SETTINGS.chat.model);
  assert.match(runtime.chat.projector, /mmproj.*\.gguf$/i);

  const proposedImage = {
    type: "generate_image" as const,
    prompt: "A luminous illustrated heroine",
    aspect: "1:1" as const,
  };
  assert.equal(routeAction(proposedImage, "anima")?.type, "generate_anima");
  assert.equal(routeAction({ ...proposedImage, type: "generate_anima" }, "krea")?.type, "generate_image");
  assert.equal(routeAction(proposedImage, "video")?.type, "generate_video");
  assert.equal(routeAction(proposedImage, "edit")?.type, "edit_image");
  assert.equal(routeAction(proposedImage, "auto")?.type, "generate_image");
  assert.equal(routeAction(null, "anima"), null);

  const [server, service, panel, node, installer, manifest] = await Promise.all([
    readFile("bridge/server.ts", "utf8"),
    readFile("bridge/chat-service.ts", "utf8"),
    readFile("app/chat-panel.tsx", "utf8"),
    readFile("comfyui_nodes/H3-Studio-Gemma4-Chat/h3_studio_chat.py", "utf8"),
    readFile("scripts/INSTALL_COMFY_DEPENDENCIES.ps1", "utf8"),
    readFile("workflows/dependencies.json", "utf8"),
  ]);
  assert.match(server, /\/api\/chat\/:projectId\/messages/);
  assert.match(server, /await comfy\.chatUnload\(\)\.catch/);
  assert.ok((server.match(/await comfy\.chatUnload\(\)\.catch/g) ?? []).length >= 5);
  assert.match(service, /durationSeconds: 10/);
  assert.match(service, /megapixels: 0\.5/);
  assert.match(service, /qualityMode: "fast"/);
  assert.match(service, /ROUTE_OVERRIDE/);
  assert.match(service, /MEMORY_SYSTEM_PROMPT/);
  assert.match(service, /generate_anima for anime, manga, illustration, drawing or cartoon-style/);
  assert.match(panel, /\(\^\|\\s\)@\$/);
  assert.match(panel, /chat-picker-grid/);
  assert.match(panel, /Crea con/);
  assert.match(panel, /"auto" \| "video" \| "krea" \| "anima" \| "edit"/);
  assert.match(node, /llama-server/);
  assert.match(node, /--reasoning", "off"/);
  assert.match(node, /H3_CHAT_LLAMA_SERVER/);
  assert.match(node, /\/h3_studio\/chat\/unload/);
  assert.match(installer, /H3-Studio-Gemma4-Chat/);
  const parsed = JSON.parse(manifest) as { items: Array<{ id: string }> };
  assert.ok(parsed.items.some((item) => item.id === "h3-studio-chat-node"));
  assert.ok(parsed.items.some((item) => item.id === "h3-chat-mmproj"));
  console.log("Chat contract: OK");
} finally {
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  } catch (error) {
    // node:sqlite on Windows can retain WAL file handles until process exit.
    if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
  }
}
