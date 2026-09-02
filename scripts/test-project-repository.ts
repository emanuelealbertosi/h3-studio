import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JobRepository } from "../bridge/job-repository.js";
import { ProjectRepository } from "../bridge/project-repository.js";
import { ExternalMediaRepository } from "../bridge/external-media-repository.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "h3-studio-projects-"));
const jobs = new JobRepository(dataDir);
const database = new DatabaseSync(jobs.databasePath);
const now = new Date().toISOString();
const processingStarted = "2026-08-27T10:00:00.000Z";
const candidateCompleted = "2026-08-27T10:01:03.250Z";
const upscaleCompleted = "2026-08-27T10:00:45.000Z";
const faceUpscaleCompleted = "2026-08-27T10:00:30.000Z";

try {
  database
    .prepare(
      `INSERT INTO jobs(
        id, status, created_at, updated_at, prompt, candidate_count,
        shot_count, duration_seconds, megapixels, generation_mode, aspect_format,
        requested_seed, seed_mode, model, lora, lora_strength, steps,
        selected_candidate_index
      ) VALUES (?, 'completed', ?, ?, ?, 1, 3, 5, 0.5, 'T2V',
                '16:9 landscape', '123', 'base', 'test-model', 'test-lora',
                1, 8, 1)`,
    )
    .run("test-job", now, now, "Test project timeline");
  database
    .prepare(
      `INSERT INTO candidates(
        job_id, candidate_index, seed, filename_prefix, prompt_id,
        queue_number, status, api_prompt_json, output_filename,
        output_subfolder, output_type, output_format, created_at, updated_at
      ) VALUES (
        'test-job', 1, '123', 'test/candidate_1', 'test-prompt',
        1, 'ready', '{}', 'candidate_1.mp4', '', 'output', 'video/mp4', ?, ?
      )`,
    )
    .run(processingStarted, candidateCompleted);
  database
    .prepare(
      `INSERT INTO candidate_variants(
        id, source_job_id, source_candidate_index, kind, stage, status,
        target_megapixels, api_prompt_json, filename_prefix, output_filename, output_subfolder,
        output_type, output_format, created_at, updated_at
      ) VALUES (
        'test-variant', 'test-job', 1, 'upscale', 'upscale', 'ready',
        2, '{}', 'test/upscale', 'candidate_1_upscale.mp4', '',
        'output', 'video/mp4', ?, ?
      )`,
    )
    .run(processingStarted, upscaleCompleted);
  database
    .prepare(
      `INSERT INTO candidate_variants(
        id, source_job_id, source_candidate_index, source_variant_id,
        target_megapixels, kind, stage, status, api_prompt_json,
        filename_prefix, output_filename, output_subfolder,
        output_type, output_format, created_at, updated_at
      ) VALUES (
        'test-face-upscale', 'test-job', 1, 'test-variant',
        2, 'face_upscale', 'face', 'ready', '{}',
        'test/face-upscale', 'candidate_1_face_upscale.mp4', '',
        'output', 'video/mp4', ?, ?
      )`,
    )
    .run(processingStarted, faceUpscaleCompleted);
  database
    .prepare(
      `INSERT INTO jobs(
        id, status, created_at, updated_at, prompt, candidate_count,
        duration_seconds, megapixels, generation_mode, aspect_format,
        requested_seed, seed_mode, model, lora, lora_strength, steps
      ) VALUES (?, 'failed', ?, ?, ?, 1, 5, 0.5, 'T2V',
                '16:9 landscape', '456', 'base', 'test-model', '',
                0, 8)`,
    )
    .run("failed-job", now, now, "Failed candidate cleanup");
  database
    .prepare(
      `INSERT INTO candidates(
        job_id, candidate_index, seed, filename_prefix, prompt_id,
        queue_number, status, api_prompt_json, error, created_at, updated_at
      ) VALUES (
        'failed-job', 1, '456', 'test/failed_candidate_1', 'failed-prompt',
        2, 'failed', '{}', 'Test failure', ?, ?
      )`,
    )
    .run(now, now);
  database.close();
  const renamedJob = jobs.renameCandidate("test-job", 1, "Duello del drago");
  assert.equal(renamedJob?.candidates[0].displayName, "Duello del drago");

  const projects = new ProjectRepository(jobs.databasePath);
  const externalMedia = new ExternalMediaRepository(jobs.databasePath);
  try {
    const first = projects.create("Progetto A");
    const second = projects.create("Progetto B");
    assert(first && second);

    const withClip = projects.addClip(first.id, "test-job", 1, "Apertura");
    assert.equal(withClip?.clips.length, 1);
    assert.equal(withClip?.clips[0].position, 0);
    assert.equal(withClip?.clips[0].sourceDuration, 15);
    assert.equal(withClip?.clips[0].processingSeconds, 63.25);
    assert.equal(first.timelines.length, 1);

    const alternate = projects.createTimeline(first.id, "Versione breve");
    assert(alternate);
    const alternateWithClip = projects.addClipToTimeline(
      alternate.id,
      "test-job",
      1,
      "Trim test",
    );
    assert.equal(alternateWithClip?.clips.length, 1);
    const switched = projects.updateClip(alternateWithClip!.clips[0].id, {
      variantId: "test-variant",
    });
    assert.equal(switched?.clips[0].sourceVariantId, "test-variant");
    assert.equal(switched?.clips[0].variantKind, "upscale");
    assert.equal(switched?.clips[0].targetMegapixels, 2);
    assert.equal(switched?.clips[0].processingSeconds, 45);
    assert.equal(switched?.clips[0].output.filename, "candidate_1_upscale.mp4");
    const chained = switched?.clips[0].variants.find(
      (variant) => variant.id === "test-face-upscale",
    );
    assert.equal(chained?.sourceVariantId, "test-variant");
    assert.equal(chained?.targetMegapixels, 2);
    assert.equal(chained?.processingSeconds, 30);
    const trimmed = projects.updateClip(switched!.clips[0].id, {
      trimStart: 0.5,
      trimEnd: 3.5,
      volume: 0.75,
    });
    assert.equal(trimmed?.clips[0].trimStart, 0.5);
    assert.equal(trimmed?.clips[0].trimEnd, 3.5);
    assert.equal(trimmed?.clips[0].volume, 0.75);
    const mixed = projects.updateTimeline(alternate.id, {
      externalAudioFile: "music/test.wav [input]",
      externalAudioName: "test.wav",
      originalAudioGain: 0.6,
      externalAudioGain: 1.2,
      externalAudioLoop: true,
    });
    assert.equal(mixed?.externalAudioFile, "music/test.wav [input]");
    assert.equal(mixed?.originalAudioGain, 0.6);
    assert.equal(mixed?.externalAudioLoop, true);
    assert.equal(projects.get(first.id)?.timelines.length, 2);
    const deletedTimeline = projects.deleteTimeline(alternate.id);
    assert.equal(deletedTimeline.name, "Versione breve");
    assert.equal(deletedTimeline.removedClips, 1);
    assert.equal(projects.getTimeline(alternate.id), null);
    assert.equal(projects.get(first.id)?.timelines.length, 1);
    assert.throws(() => projects.deleteTimeline(alternate.id), /Montaggio non trovato/);

    const copied = projects.copyClip(withClip!.clips[0].id, second.id);
    assert.equal(copied?.clips.length, 1);

    const sharedProject = projects.create("Progetto condiviso da eliminare");
    assert(sharedProject);
    const sharedCopy = projects.copyClip(withClip!.clips[0].id, sharedProject.id);
    assert.equal(sharedCopy?.clips.length, 1);
    const sharedPlan = projects.deletionPlan(sharedProject.id);
    assert.equal(sharedPlan.videoCandidates.length, 0);
    assert.equal(sharedPlan.preserved.videoJobs, 1);
    projects.delete(sharedProject.id);
    assert.equal(projects.get(sharedProject.id), null);
    assert.equal(jobs.get("test-job")?.projectId, first.id);
    assert.equal(projects.get(first.id)?.clips.length, 1);
    assert.equal(projects.get(second.id)?.clips.length, 1);

    const moved = projects.moveClip(withClip!.clips[0].id, second.id);
    assert.equal(moved?.clips.length, 2);
    assert.equal(projects.get(first.id)?.clips.length, 0);

    const reordered = projects.reorderClip(moved!.clips[1].id, 0);
    assert.equal(reordered?.clips[0].id, moved!.clips[1].id);
    assert.equal(projects.list().length, 2);

    const removed = projects.removeClip(reordered!.clips[0].id);
    assert.equal(removed?.clips.length, 1);
    assert.equal(removed?.clips[0].position, 0);
    assert.equal(removed?.clips[0].id, reordered!.clips[1].id);
    assert.equal(projects.get(first.id)?.clips.length, 0);

    const deleted = jobs.deleteCandidate("test-job", 1);
    assert.equal(deleted.jobDeleted, true);
    assert.equal(deleted.removedClips, 1);
    assert.deepEqual(
      deleted.files.map((file) => file.filename).sort(),
      [
        "candidate_1.mp4",
        "candidate_1_face_upscale.mp4",
        "candidate_1_upscale.mp4",
        "latent_00001.safetensors",
      ],
    );
    assert.equal(projects.get(first.id)?.clips.length, 0);
    assert.equal(projects.get(second.id)?.clips.length, 0);
    assert.equal(jobs.get("test-job"), null);

    const doomedProject = projects.create("Progetto da eliminare");
    assert(doomedProject);
    jobs.assignProject("failed-job", doomedProject.id);
    const doomedUpload = externalMedia.upsert({
      kind: "picture",
      file: "uploads/doomed.png [input]",
      name: "doomed.png",
      original: "doomed.png",
      size: 123,
    }, doomedProject.id);
    const doomedPlan = projects.deletionPlan(doomedProject.id);
    assert.equal(doomedPlan.videoCandidates.length, 1);
    assert.equal(doomedPlan.videoCandidates[0].job_id, "failed-job");
    assert.equal(doomedPlan.videoCandidates[0].candidate_index, 1);
    assert.equal(doomedPlan.externalMedia.length, 1);
    assert.equal(doomedPlan.externalMedia[0].id, doomedUpload.id);
    assert.deepEqual(doomedPlan.busy, { video: 0, image: 0, audio: 0 });
    assert.throws(() => projects.delete(doomedProject.id), /Pulizia media incompleta/);
    const failedDeleted = jobs.deleteCandidate("failed-job", 1);
    assert.equal(failedDeleted.jobDeleted, true);
    assert.equal(failedDeleted.removedClips, 0);
    assert.deepEqual(failedDeleted.files, [
      {
        filename: "latent_00001.safetensors",
        subfolder: "video/H3_STUDIO_CONTEXT/failed-job",
        type: "output",
      },
    ]);
    assert.equal(jobs.get("failed-job"), null);
    externalMedia.delete(doomedUpload.id);
    const deletedProject = projects.delete(doomedProject.id);
    assert.equal(deletedProject.name, "Progetto da eliminare");
    assert.equal(projects.get(doomedProject.id), null);
  } finally {
    externalMedia.close();
    projects.close();
  }
  console.log("Project repository: OK");
} finally {
  try {
    database.close();
  } catch {}
  jobs.close();
  rmSync(dataDir, { recursive: true, force: true });
}
