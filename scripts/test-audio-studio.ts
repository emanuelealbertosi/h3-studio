import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AudioJobRepository } from "../bridge/audio-job-repository.js";
import { normalizeMusicPlan } from "../bridge/audio-studio-service.js";
import { normalizePromptPlan } from "../bridge/prompt-planner.js";
import { JobRepository } from "../bridge/job-repository.js";
import { ProjectRepository } from "../bridge/project-repository.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "h3-studio-audio-"));
const jobs = new JobRepository(dataDir);
const projects = new ProjectRepository(jobs.databasePath);
const audio = new AudioJobRepository(jobs.databasePath);

  const panelSource = readFileSync(path.join(process.cwd(), "app", "audio-studio-panel.tsx"), "utf8");
  const serverSource = readFileSync(path.join(process.cwd(), "bridge", "server.ts"), "utf8");
  const transcriptionSource = readFileSync(path.join(process.cwd(), "bridge", "transcribe-reference.py"), "utf8");
  assert.match(panelSource, /TTS Planner AI/);
  assert.match(panelSource, /Trascrizione automatica del campione/);
  assert.match(serverSource, /api\/audio-jobs\/transcribe-reference/);
  assert.match(transcriptionSource, /openai\/whisper-small/);
  const plannedTts = normalizePromptPlan(
    '{"prompt":"<|emotion:contentment|> Buongiorno. <|prosody:pause|> Benvenuti.","summary":"Voce calma.","language":"Italian"}',
    "tts",
  );
  assert.match(plannedTts.prompt, /Buongiorno/);
  assert.equal(plannedTts.language, "Italian");
try {
  const project = projects.create("Audio test");
  if (!project) throw new Error("Progetto audio di test non creato");
  const plannedSong = normalizeMusicPlan(JSON.stringify({
    caption: "Energetic Italian synth-pop at 118 BPM with bright analog synths and a concise radio arrangement.",
    lyrics: "[Verse 1]\nSotto il sole corro via\n\n[Chorus]\nQuesta estate e casa mia",
    instrumental: false,
    summary: "Synth-pop estivo con ritornello breve.",
  }), false);
  assert.match(plannedSong.caption, /118 BPM/);
  assert.match(plannedSong.lyrics, /\[Chorus\]/);
  const plannedInstrumental = normalizeMusicPlan(
    '{"caption":"Cinematic instrumental orchestral cue with brass, strings and a decisive ending.","lyrics":"ignored","instrumental":true,"summary":"Tema orchestrale."}',
    true,
  );
  assert.equal(plannedInstrumental.lyrics, "");
  const tts = audio.create({
    projectId: project.id,
    kind: "tts",
    prompt: "Questa è una prova audio.",
    voice: "Italian_Female.wav",
    seed: 1234,
    settings: { engine: "higgs", unloadAfterJob: true },
  });
  assert.equal(tts.status, "prepared");
  assert.equal(tts.seed, 1234);
  assert.equal(tts.settings.unloadAfterJob, true);

  const ready = audio.update(tts.id, {
    status: "ready",
    phaseLabel: "Voce pronta · modello scaricato",
    progress: 100,
    output: {
      filename: "tts.wav",
      subfolder: "H3_STUDIO_AUDIO",
      type: "output",
      format: "audio/wav",
    },
  });
  assert.equal(ready.output?.mediaPath.includes("H3_STUDIO_AUDIO"), true);
  assert.equal(ready.processingSeconds !== null, true);

  const music = audio.create({
    projectId: project.id,
    kind: "music",
    prompt: "Bright cinematic orchestral theme",
    lyrics: "[Instrumental]",
    durationSeconds: 30,
    seed: 99,
    settings: { engine: "minimax-music-3", tiledDecode: true },
  });
  audio.update(music.id, { status: "queued", promptId: "prompt-music", phaseLabel: "In coda" });
  assert.equal(audio.list(10, project.id).length, 2);
  assert.equal(audio.pending().length, 1);

  const database = new DatabaseSync(jobs.databasePath);
  const migration = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
  assert.equal(migration.version, 22);
  database.close();
  console.log("Audio Studio persistence, output and migration: OK");
} finally {
  audio.close();
  projects.close();
  jobs.close();
  rmSync(dataDir, { recursive: true, force: true });
}
