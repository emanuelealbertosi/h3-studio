import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChatRepository } from "../bridge/chat-repository.js";
import {
  extractRequestedVideoDuration,
  extractRequestedLyrics,
  musicInstrumentalIntent,
  normalizePlan,
  preserveMiniMaxImageIntent,
  preserveMusicIntent,
  resolveChatKeyframePositions,
  resolveChatTtsText,
  resolveChatVideoAudioRole,
  resolveChatVideoMode,
  resolveChatVideoTiming,
  routeAction,
  shouldRecallMedia,
} from "../bridge/chat-service.js";
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
  assert.equal(routeAction(proposedImage, "tts")?.type, "generate_tts");
  assert.equal(routeAction(proposedImage, "music")?.type, "generate_music");
  assert.equal(routeAction(proposedImage, "minimax")?.type, "generate_minimax_image");
  assert.equal(routeAction(proposedImage, "auto")?.type, "generate_image");
  assert.equal(preserveMiniMaxImageIntent(proposedImage, "usa MiniMax per questa immagine")?.type, "generate_minimax_image");
  assert.equal(preserveMiniMaxImageIntent(proposedImage, "crea una foto generica")?.type, "generate_image");
  assert.equal(preserveMiniMaxImageIntent(proposedImage, "crea una foto generica", "minimax")?.type, "generate_minimax_image");
  assert.equal(routeAction(null, "anima"), null);
  const vocalRequest = 'crea una canzone jazz di 10s cantata da una donna che dice "Buongiornissimo caffè, Buongiornissimo caffeee" in italiano';
  assert.equal(musicInstrumentalIntent(vocalRequest), false);
  assert.equal(extractRequestedLyrics(vocalRequest), "Buongiornissimo caffè, Buongiornissimo caffeee");
  assert.equal(musicInstrumentalIntent("Crea un tema jazz strumentale senza voce"), true);
  assert.equal(
    resolveChatTtsText(
      '<d>[Italian] Vi faccio secchi brutti bastardi!</d> The speaker delivers the line with an angry and intense expression.',
      'usa questo audio come riferimento per creare un parlato in italiano che dice arrabbiato "Vi faccio secchi brutti bastardi!"',
    ),
    "<|emotion:anger|> <|style:shouting|> Vi faccio secchi brutti bastardi!",
  );
  assert.equal(resolveChatTtsText("Questa è una prova.", "Crea un parlato neutro"), "Questa è una prova.");
  const preservedSong = preserveMusicIntent({
    type: "generate_music",
    prompt: "Sophisticated jazz with warm female vocal",
    instrumental: true,
  }, vocalRequest);
  assert.equal(preservedSong?.instrumental, false);
  assert.equal(preservedSong?.lyrics, "Buongiornissimo caffè, Buongiornissimo caffeee");
  const videoEditAlias = normalizePlan(JSON.stringify({
    reply: "Modifica avviata",
    title: "Goku blu",
    action: {
      type: "video_editing",
      prompt: "In Video 1, change Goku's primary colors to blue.",
      videoMode: "VIDEO EDITING",
    },
  }));
  assert.equal(videoEditAlias.action?.type, "generate_video");
  assert.equal(videoEditAlias.action?.videoMode, "VIDEO EDITING");
  assert.equal(shouldRecallMedia("Ora modificala rendendo il cielo rosso"), true);
  assert.equal(shouldRecallMedia("Crea una animazione partendo da questa immagine"), true);
  assert.equal(shouldRecallMedia("crea un video da questa ultim immagine"), true);
  assert.equal(shouldRecallMedia("anima l'immagine precedente"), true);
  assert.equal(shouldRecallMedia("usa le immagini precedenti come keyframe"), true);
  assert.equal(shouldRecallMedia("Parliamo di regia cinematografica"), false);
  assert.deepEqual(resolveChatVideoTiming(), {
    shotCount: 1, durationSeconds: 10, totalSeconds: 10,
  });
  assert.deepEqual(resolveChatVideoTiming(30), {
    shotCount: 3, durationSeconds: 10, totalSeconds: 30,
  });
  assert.deepEqual(resolveChatVideoTiming(120), {
    shotCount: 12, durationSeconds: 10, totalSeconds: 120,
  });
  assert.deepEqual(resolveChatVideoTiming(180), {
    shotCount: 12, durationSeconds: 15, totalSeconds: 180,
  });
  assert.throws(() => resolveChatVideoTiming(181), /massimo 180 secondi/i);
  assert.equal(extractRequestedVideoDuration("crea un video di 30s"), 30);
  assert.equal(extractRequestedVideoDuration("crea un video di 30 secondi"), 30);
  assert.equal(extractRequestedVideoDuration("crea un video di 2 minuti"), 120);
  assert.equal(extractRequestedVideoDuration("crea un video fantasy"), null);
  assert.equal(resolveChatVideoMode("anima l'immagine precedente", "R2V", 1, 0, 0), "I2V");
  assert.equal(resolveChatVideoMode("crea un video da questa ultima immagine", "T2V", 1, 0, 0), "I2V");
  assert.equal(resolveChatVideoMode("usa questa immagine come riferimento", "I2V", 1, 0, 0), "R2V");
  assert.equal(resolveChatVideoMode("falla parlare con questa voce", "I2V", 1, 0, 1), "I2V");
  assert.equal(resolveChatVideoMode("falla parlare con questa voce", "R2V", 0, 0, 1), "R2V");
  assert.equal(resolveChatVideoMode("usa questa immagine come riferimento e questa voce", "I2V", 1, 0, 1), "R2V");
  assert.equal(resolveChatVideoMode("usa questa immagine come ultimo frame", "I2V", 1, 0, 0), "KEYFRAMES");
  assert.equal(resolveChatVideoMode("usa le tre immagini come keyframe intermedi", "T2V", 3, 0, 0), "KEYFRAMES");
  assert.equal(resolveChatVideoMode("usa come keyframe", "KEYFRAMES", 0, 0, 0), "T2V");
  assert.equal(
    resolveChatVideoAudioRole(
      "usa questa voce solo come riferimento di timbro e falle dire: Ciao mondo",
      "I2V",
      1,
    ),
    "voice_ref",
  );
  assert.equal(
    resolveChatVideoAudioRole(
      "usa questo audio come riferimento vocale nei keyframes e falle dire buongiorno",
      "KEYFRAMES",
      1,
    ),
    "voice_ref",
  );
  assert.equal(
    resolveChatVideoAudioRole(
      "usa l'immagine come start frame e falle dire esattamente l'audio allegato con lipsync",
      "I2V",
      1,
    ),
    "music_video_lipsync",
  );
  assert.equal(
    resolveChatVideoAudioRole("anima questa immagine con l'audio allegato", "I2V", 1),
    "music_video_lipsync",
  );
  assert.equal(resolveChatKeyframePositions("usa questa immagine come ultimo frame", 1, 10), "100%");
  assert.equal(resolveChatKeyframePositions("usa questa immagine come primo frame", 1, 10), "0%");
  assert.equal(resolveChatKeyframePositions("usa questa immagine come frame intermedio", 1, 10), "50%");
  assert.equal(resolveChatKeyframePositions("usa le immagini come keyframe", 2, 10), "0%, 100%");
  assert.equal(resolveChatKeyframePositions("usa le tre immagini come keyframe intermedi", 3, 10), "25%, 50%, 75%");
  assert.equal(resolveChatKeyframePositions("keyframe alle posizioni 10%, 40%, 90%", 3, 10), "10%, 40%, 90%");
  assert.equal(resolveChatKeyframePositions("Picture 1 al secondo 2 e Picture 2 al secondo 8", 2, 10), "20%, 80%");
  const keyframePlan = normalizePlan(JSON.stringify({
    reply: "Creo il video con i fotogrammi indicati",
    title: "Keyframe ordinati",
    action: {
      type: "generate_video",
      prompt: "A continuous cinematic transition through Picture 1, Picture 2 and Picture 3.",
      videoMode: "KEYFRAMES",
      durationSeconds: 10,
    },
  }));
  assert.equal(keyframePlan.action?.videoMode, "KEYFRAMES");

  const [server, service, audioService, panel, dialog, styles, node, installer, manifest, page, imagePanel, audioPanel] = await Promise.all([
    readFile("bridge/server.ts", "utf8"),
    readFile("bridge/chat-service.ts", "utf8"),
    readFile("bridge/audio-studio-service.ts", "utf8"),
    readFile("app/chat-panel.tsx", "utf8"),
    readFile("app/regenerate-dialog.tsx", "utf8"),
    readFile("app/globals.css", "utf8"),
    readFile("comfyui_nodes/H3-Studio-Gemma4-Chat/h3_studio_chat.py", "utf8"),
    readFile("scripts/INSTALL_COMFY_DEPENDENCIES.ps1", "utf8"),
    readFile("workflows/dependencies.json", "utf8"),
    readFile("app/page.tsx", "utf8"),
    readFile("app/image-studio-panel.tsx", "utf8"),
    readFile("app/audio-studio-panel.tsx", "utf8"),
  ]);
  assert.match(server, /\/api\/chat\/:projectId\/messages/);
  assert.match(server, /\/api\/chat\/conversations\/:conversationId/);
  assert.match(server, /\/api\/chat\/conversations\/:conversationId\/regenerate/);
  assert.match(server, /preserveMedia/);
  assert.match(server, /deleteChatMedia/);
  assert.match(server, /external-media\/:mediaId\/rename/);
  assert.match(server, /image-jobs\/:jobId\/candidates\/:candidateIndex\/rename/);
  assert.match(server, /jobs\/:jobId\/candidates\/:candidateIndex\/rename/);
  assert.match(server, /await comfy\.chatUnload\(\)\.catch/);
  assert.ok((server.match(/await comfy\.chatUnload\(\)\.catch/g) ?? []).length >= 5);
  assert.match(service, /explicitDuration \?\? \(VIDEO_DURATION_CUE\.test\(requestText\)/);
  assert.match(service, /shotCount: timing\.shotCount/);
  assert.match(service, /durationSeconds: timing\.durationSeconds/);
  assert.match(service, /megapixels: 0\.5/);
  assert.match(service, /qualityMode: "fast"/);
  assert.match(service, /ROUTE_OVERRIDE/);
  assert.match(service, /MEMORY_SYSTEM_PROMPT/);
  assert.match(service, /recallLatestMedia/);
  assert.match(service, /recentMediaSources/);
  assert.match(service, /generate_anima for anime, manga, illustration, drawing or cartoon-style/);
  assert.match(service, /generate_tts/);
  assert.match(service, /generate_music/);
  assert.match(service, /VOICE_COVER_PATTERN/);
  assert.match(service, /kind: voiceCover \? "voice_cover" : "music"/);
  assert.match(service, /natural lip synchronization/);
  assert.match(service, /audio_role: audioRole/);
  assert.match(service, /resolveChatVideoAudioRole\(/);
  assert.match(service, /PDD remains an explicit[\s\S]*?Studio-only FAST choice/);
  assert.match(service, /turboEnabled: false/);
  assert.doesNotMatch(service, /turboEnabled: true/);
  assert.match(service, /resolveChatVideoMode\(/);
  assert.match(service, /KEEP_SOURCE_ASPECT_PATTERN\.test\(requestText\)/);
  assert.match(service, /resolveChatKeyframePositions\(requestText, pictures\.length, timing\.totalSeconds\)/);
  assert.match(service, /T2V\|I2V\|R2V\|KEYFRAMES\|VIDEO EXTENSION\|VIDEO EDITING/);
  assert.match(service, /audioStudio\.planMusic/);
  assert.match(service, /preserveMusicIntent/);
  assert.match(service, /lyrics: plan\.lyrics/);
  assert.match(service, /referenceFile: reference\?\.file/);
  assert.match(service, /const ttsText = resolveChatTtsText\(plan\.prompt, originalRequest \?\? ""\)/);
  assert.match(service, /video_editing: \{ type: "generate_video", videoMode: "VIDEO EDITING" \}/);
  assert.match(service, /catch \(error\) \{\s+await this\.comfy\.chatUnload\(\)\.catch/);
  assert.match(audioService, /Trascrizione reference con Whisper/);
  assert.match(audioService, /transcribeReference/);
  assert.match(panel, /\(\^\|\\s\)@\$/);
  assert.match(panel, /chat-picker-grid/);
  assert.match(panel, /Crea con/);
  assert.match(panel, /"auto" \| "video" \| "krea" \| "minimax" \| "anima" \| "edit"/);
  assert.match(panel, /trackedActions/);
  assert.match(panel, /Connessione temporaneamente persa · nuovo tentativo automatico/);
  assert.match(panel, /if \(job\.fetchError\) return true/);
  assert.doesNotMatch(panel, /tracked\?\.fetchError \|\| action\?\.status === "failed"/);
  assert.match(panel, /\/api\/image-jobs\/\$\{action\.jobId\}/);
  assert.match(panel, /\/api\/audio-jobs\/\$\{action\.jobId\}/);
  assert.match(panel, /audio\/\*/);
  assert.match(panel, /Carica dal disco/);
  assert.match(panel, /Musica H3/);
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
  assert.match(panel, /onOpenStudio: \(kind: "video" \| "image" \| "audio", jobId: string\)/);
  assert.match(panel, /onOpenStudio\([\s\S]*?action\.jobId!\)/);
  assert.match(page, /openChatMediaInStudio/);
  assert.match(page, /\/api\/jobs\/\$\{jobId\}/);
  assert.match(page, /initialJobId=\{imageStudioHandoff\?\.jobId\}/);
  assert.match(page, /initialJobId=\{audioStudioJobId\}/);
  assert.match(imagePanel, /loadJobs\(initialJobId\)/);
  assert.match(audioPanel, /const preferred = preferId \? loaded\.find/);
  assert.match(dialog, /Prompt della nuova generazione/);
  assert.match(dialog, /Nuovo casuale/);
  assert.match(dialog, /secondaryLabel/);
  assert.match(panel, /Lyrics cantate/);
  assert.match(styles, /\.chat-render-preview/);
  assert.match(styles, /\.chat-stop-button/);
  assert.match(styles, /\.chat-thread-sidebar/);
  assert.match(styles, /\.content\.chat-content\s*\{[\s\S]*?width:\s*100%[\s\S]*?padding-left:\s*0/);
  assert.match(styles, /\.chat-thread-sidebar\s*\{[\s\S]*?position:\s*sticky[\s\S]*?top:\s*88px/);
  assert.match(styles, /\.chat-thread-groups[^}]*overflow-y:\s*auto/);
  assert.match(styles, /\.chat-delete-dialog/);
  assert.match(node, /llama-server/);
  assert.match(node, /--reasoning", "off"/);
  assert.match(node, /H3_CHAT_LLAMA_SERVER/);
  assert.match(node, /\/h3_studio\/chat\/unload/);
  assert.match(node, /if "mmproj" in low:[\s\S]*?else:[\s\S]*?models\.append\(rel\)/);
  assert.match(node, /H3 Studio · Local Vision LLM/);
  assert.ok(server.includes("llmFiles.filter((file) => /\\.gguf$/i.test(file) && !/mmproj/i.test(file))"));
  assert.ok(page.includes("compatibleEngineOptions(data.capabilities.chatModels, data.settings.chat.model, /\\.gguf$/i)"));
  assert.doesNotMatch(panel, /Gemma/i);
  assert.doesNotMatch(page, /Gemma/i);
  assert.doesNotMatch(imagePanel, /Gemma/i);
  assert.doesNotMatch(audioPanel, /Gemma/i);
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
