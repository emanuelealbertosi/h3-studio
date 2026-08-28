import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChatRepository } from "../bridge/chat-repository.js";
import { routeAction, shouldRecallMedia } from "../bridge/chat-service.js";
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
  const primary = chat.createConversation(project!.id);
  assert.equal(primary.title, "Nuova chat");
  chat.add({
    projectId: project!.id,
    conversationId: primary.id,
    role: "user",
    content: "Crea un castello luminoso nel cielo",
  });
  const titled = chat.maybeAutoTitle(primary.id, "Crea un castello luminoso nel cielo");
  assert.match(titled?.title ?? "", /Castello luminoso/i);
  chat.add({
    projectId: project!.id,
    conversationId: primary.id,
    role: "assistant",
    content: "Ciao!",
    action: { type: "generate_video", prompt: "A bright cinematic shot", status: "started", jobId: "job-1" },
  });
  const messages = chat.list(project!.id, primary.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].action?.jobId, "job-1");
  assert.deepEqual(chat.mediaJobs(primary.id), [{ kind: "video", jobId: "job-1" }]);
  const actionSources = chat.recentMediaSources(project!.id, primary.id);
  assert.equal(actionSources[0].action?.jobId, "job-1");
  assert.deepEqual(actionSources[0].attachments, []);
  chat.add({
    projectId: project!.id,
    conversationId: primary.id,
    role: "user",
    content: "Analizza questa immagine",
    attachments: [{ kind: "picture", file: "chat/test.png [input]", name: "Test" }],
  });
  const recalled = chat.latestAttachments(project!.id, primary.id);
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].remembered, true);
  const initialContext = chat.context(project!.id, primary.id);
  assert.equal(initialContext.summary, "");
  assert.equal(initialContext.messages.length, 3);
  chat.updateMemory(
    project!.id,
    primary.id,
    "Il progetto usa uno stile anime luminoso.",
    initialContext.messages[0].sequence,
  );
  const compactedContext = chat.context(project!.id, primary.id);
  assert.match(compactedContext.summary, /stile anime/);
  assert.equal(compactedContext.messages.length, 2);
  assert.equal(chat.memoryStatus(project!.id, primary.id).summarizedMessages, 1);
  const secondary = chat.createConversation(project!.id, "Seconda idea");
  chat.add({
    projectId: project!.id,
    conversationId: secondary.id,
    role: "user",
    content: "Questa cronologia è separata",
  });
  assert.equal(chat.list(project!.id, secondary.id).length, 1);
  assert.equal(chat.list(project!.id, primary.id).length, 3);
  assert.equal(chat.listConversations(project!.id).length, 2);
  assert.equal(chat.renameConversation(secondary.id, "Titolo modificato").title, "Titolo modificato");
  chat.clear(project!.id, primary.id);
  assert.equal(chat.list(project!.id, primary.id).length, 0);
  assert.equal(chat.memoryStatus(project!.id, primary.id).active, false);
  assert.equal(chat.deleteConversation(secondary.id).deleted, true);
  const migration = new DatabaseSync(jobs.databasePath, { readOnly: true });
  assert.ok(migration.prepare("SELECT version FROM schema_migrations WHERE version = 20").get());
  assert.equal(migration.prepare("PRAGMA foreign_key_check").all().length, 0);
  migration.close();
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
  assert.equal(shouldRecallMedia("Ora modificala rendendo il cielo rosso"), true);
  assert.equal(shouldRecallMedia("Crea una animazione partendo da questa immagine"), true);
  assert.equal(shouldRecallMedia("Parliamo di regia cinematografica"), false);

  const [server, service, panel, dialog, styles, node, installer, manifest] = await Promise.all([
    readFile("bridge/server.ts", "utf8"),
    readFile("bridge/chat-service.ts", "utf8"),
    readFile("app/chat-panel.tsx", "utf8"),
    readFile("app/regenerate-dialog.tsx", "utf8"),
    readFile("app/globals.css", "utf8"),
    readFile("comfyui_nodes/H3-Studio-Gemma4-Chat/h3_studio_chat.py", "utf8"),
    readFile("scripts/INSTALL_COMFY_DEPENDENCIES.ps1", "utf8"),
    readFile("workflows/dependencies.json", "utf8"),
  ]);
  assert.match(server, /\/api\/chat\/:projectId\/messages/);
  assert.match(server, /\/api\/chat\/conversations\/:conversationId/);
  assert.match(server, /\/api\/chat\/conversations\/:conversationId\/regenerate/);
  assert.match(server, /preserveMedia/);
  assert.match(server, /deleteChatMedia/);
  assert.match(server, /await comfy\.chatUnload\(\)\.catch/);
  assert.ok((server.match(/await comfy\.chatUnload\(\)\.catch/g) ?? []).length >= 5);
  assert.match(service, /durationSeconds: 10/);
  assert.match(service, /megapixels: 0\.5/);
  assert.match(service, /qualityMode: "fast"/);
  assert.match(service, /ROUTE_OVERRIDE/);
  assert.match(service, /MEMORY_SYSTEM_PROMPT/);
  assert.match(service, /recallLatestMedia/);
  assert.match(service, /recentMediaSources/);
  assert.match(service, /generate_anima for anime, manga, illustration, drawing or cartoon-style/);
  assert.match(panel, /\(\^\|\\s\)@\$/);
  assert.match(panel, /chat-picker-grid/);
  assert.match(panel, /Crea con/);
  assert.match(panel, /"auto" \| "video" \| "krea" \| "anima" \| "edit"/);
  assert.match(panel, /trackedActions/);
  assert.match(panel, /\/api\/image-jobs\/\$\{action\.jobId\}/);
  assert.match(panel, /cancelAction/);
  assert.match(panel, /chat-render-preview/);
  assert.match(panel, /Interrompi/);
  assert.match(panel, /disabled=\{chatLocked\}/);
  assert.match(panel, /chat-thread-sidebar/);
  assert.match(panel, /Nuova Chat/);
  assert.match(panel, /Conserva i media generati/);
  assert.match(panel, /saveConversationTitle/);
  assert.match(panel, /RegenerateDialog/);
  assert.match(panel, /↻ Rigenera/);
  assert.match(dialog, /Prompt della nuova generazione/);
  assert.match(dialog, /Nuovo casuale/);
  assert.match(styles, /\.chat-render-preview/);
  assert.match(styles, /\.chat-stop-button/);
  assert.match(styles, /\.chat-thread-sidebar/);
  assert.match(styles, /\.chat-delete-dialog/);
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
