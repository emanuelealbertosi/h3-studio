import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CHARACTER_TURNAROUND_FORMAT,
  composeImagePrompt,
  IMAGE_EDIT_KEEP_ASPECT_FORMAT,
  IMAGE_COMPOSITION_PRESETS,
  imageEditKeepAspectDimensions,
} from "../lib/image-composition.js";
import { JobRepository } from "../bridge/job-repository.js";
import {
  ImageJobRepository,
  type ImageJobReferenceInput,
  type PreparedImageJob,
} from "../bridge/image-job-repository.js";
import {
  buildAnimaGeneratePrompt,
  buildFlux2KleinEditPrompt,
  buildKreaGeneratePrompt,
} from "../bridge/image-workflow-builder.js";
import {
  ImageStudioService,
  normalizeImageRequest,
} from "../bridge/image-studio-service.js";
import { ProjectRepository } from "../bridge/project-repository.js";
import {
  DEFAULT_RUNTIME_SETTINGS,
  isAnimaModelFilename,
  RuntimeSettingsStore,
} from "../bridge/runtime-settings.js";
import { normalizePromptPlan } from "../bridge/prompt-planner.js";

const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "h3-image-studio-"));

function reference(index: number): ImageJobReferenceInput {
  return {
    file: `uploads/reference-${index}.png [input]`,
    name: `reference-${index}.png`,
    role: index === 1 ? "base" : "other",
    width: 1024,
    height: 1024,
  };
}

try {
  const [imageStudioSource, pageSource, serverSource, regenerateDialogSource] = await Promise.all([
    readFile(path.join(process.cwd(), "app", "image-studio-panel.tsx"), "utf8"),
    readFile(path.join(process.cwd(), "app", "page.tsx"), "utf8"),
    readFile(path.join(process.cwd(), "bridge", "server.ts"), "utf8"),
    readFile(path.join(process.cwd(), "app", "regenerate-dialog.tsx"), "utf8"),
  ]);
  assert.match(imageStudioSource, /Prompt Compiler AI/);
  assert.match(serverSource, /\/api\/prompt-planner/);
  const plannedEdit = normalizePromptPlan(
    '{"prompt":"Change reference image 1 hair to blue and keep everything else unchanged.","summary":"Modifica conservativa.","language":"English"}',
    "image_edit",
  );
  assert.match(plannedEdit.prompt, /keep everything else unchanged/);
  assert.equal(plannedEdit.mode, "image_edit");
  assert.match(
    imageStudioSource,
    /const tags:[\s\S]*?value: "background", label: "Paesaggio"[\s\S]*?\];/,
  );
  assert.match(
    imageStudioSource,
    /const roles:[\s\S]*?value: "background", label: "Sfondo"[\s\S]*?\];/,
  );
  assert.match(imageStudioSource, /IMAGE_COMPOSITION_PRESETS\.map/);
  assert.match(imageStudioSource, /type ImageMode = "generate" \| "edit" \| "anima"/);
  assert.match(imageStudioSource, />Anima<\/button>/);
  assert.match(imageStudioSource, /api\/image-jobs\/\$\{job\.id\}\/regenerate/);
  assert.match(imageStudioSource, /RegenerateDialog/);
  assert.match(pageSource, /ANIME IMAGE ENGINE/);
  assert.match(pageSource, /nova\.\*am/);
  assert.match(pageSource, /api\/jobs\/\$\{currentJobId\}\/regenerate/);
  assert.match(pageSource, /Rigenera batch/);
  assert.match(pageSource, /RegenerateDialog/);
  assert.match(regenerateDialogSource, /initialPrompt/);
  assert.match(regenerateDialogSource, /Nuovo casuale/);
  assert.match(serverSource, /\/api\/jobs\/:jobId\/regenerate/);
  assert.match(serverSource, /\/api\/image-jobs\/:jobId\/regenerate/);
  assert.match(imageStudioSource, /Mantieni proporzioni · Reference 1/);
  assert.match(imageStudioSource, /imageEditKeepAspectDimensions/);
  assert.match(
    imageStudioSource,
    /JSON\.stringify\(\{[\s\S]*?effectivePrompt: engineEffectivePrompt,[\s\S]*?compositionPreset,/,
  );
  assert.match(pageSource, /<span className="rail-icon">◉<\/span>\s*Assets/);
  assert.match(pageSource, /function AssetLibraryPanel\(/);
  assert.match(pageSource, /fetch\(`\$\{bridgeUrl\}\/api\/image-jobs\?limit=200`/);
  assert.match(pageSource, /application\/x-h3-asset-id/);
  assert.match(pageSource, /onSendToStudio\(selectedImages\)/);
  assert.match(pageSource, /function sendAssetImagesToStudio/);
  assert.match(pageSource, /setImageStudioHandoff\(/);
  assert.match(pageSource, /setMediaAssets\(videoAttachments\)/);
  assert.match(pageSource, /<AssetLibraryPanel[\s\S]*?onSendToStudio=\{sendAssetImagesToStudio\}/);
  assert.match(pageSource, /Mantieni proporzioni · Picture 1/);
  assert.match(pageSource, /Mantieni proporzioni · Video 1/);
  assert.match(pageSource, /Mantieni proporzioni · Picture\/Video 1/);
  assert.match(pageSource, /dataRef\.current = next/);
  assert.match(pageSource, /Configurazione Engine salvata · Anima/);
  assert.doesNotMatch(pageSource, /<CreativeLibraryPanel/);
  assert.match(pageSource, />\s*Manda a Studio\s*<span>Allegato video<\/span>/);
  assert.match(
    pageSource,
    /function addRecentVideo\([\s\S]*?setStudioMediaMode\("video"\)[\s\S]*?setActiveView\("studio"\)/,
  );
  const landscapeKeep = imageEditKeepAspectDimensions(1920, 1080);
  assert.ok(landscapeKeep);
  assert.equal(landscapeKeep.width % 16, 0);
  assert.equal(landscapeKeep.height % 16, 0);
  assert.ok(Math.abs(landscapeKeep.width / landscapeKeep.height - 16 / 9) < 0.02);
  assert.equal(imageEditKeepAspectDimensions(null, 1080), null);
  assert.equal(IMAGE_EDIT_KEEP_ASPECT_FORMAT, "keep-source-aspect");
  assert.match(imageStudioSource, /incomingReferences\?: ImageStudioIncomingReference\[\]/);
  assert.match(imageStudioSource, /incomingReferences\.length \? "edit" : "generate"/);
  assert.match(imageStudioSource, /asset ricevuti dalla libreria/);
  assert.match(imageStudioSource, /async function openImageLibrary/);
  assert.match(imageStudioSource, /\/api\/image-jobs\?limit=200/);
  assert.match(imageStudioSource, /\/api\/library/);
  assert.match(imageStudioSource, /Scegli immagini dalla libreria/);
  assert.match(imageStudioSource, /void openImageLibrary\(\)/);
  assert.match(imageStudioSource, /function insertReferenceInPrompt/);
  assert.match(imageStudioSource, />Inserisci<\/button>/);
  assert.match(pageSource, /function insertMediaInPrompt/);
  assert.match(pageSource, /title=\{`Inserisci \$\{mediaToken\(mediaAssets, index\)\} nel prompt`\}/);
  assert.match(pageSource, /className="media-picker-backdrop"/);
  assert.match(pageSource, /aria-modal="true"/);
  assert.doesNotMatch(pageSource, /mediaProjectGeneratedImages\.slice\(0, 12\)/);
  assert.doesNotMatch(pageSource, /mediaOtherGeneratedImages\.slice\(0, 12\)/);
  assert.match(
    serverSource,
    /"\/api\/image-jobs"[\s\S]{0,500}request\.query\.projectId/,
    "the image jobs API should forward the project filter",
  );
  assert.match(pageSource, /projectImageQuery\.set\("projectId", studioProjectId\)/);
  assert.match(
    pageSource,
    /fetch\(`\$\{bridgeUrl\}\/api\/image-jobs\?\$\{projectImageQuery\.toString\(\)\}`/,
  );
  assert.match(
    pageSource,
    /fetch\(`\$\{bridgeUrl\}\/api\/image-jobs\?\$\{reusableImageQuery\.toString\(\)\}`/,
    "the media picker should keep a global fallback for historical and cross-project images",
  );
  assert.match(pageSource, />Immagini del progetto<\/strong>/);
  assert.match(pageSource, />Altre immagini generate<\/strong>/);
  assert.match(pageSource, /function addGeneratedImage\([\s\S]*?kind: "picture" as const/);
  assert.match(pageSource, /file: imageReferenceFile\(candidate\.output\)/);

  assert.deepEqual(
    IMAGE_COMPOSITION_PRESETS.map((preset) => preset.value),
    [
      "free",
      "character-turnaround",
      "close-up",
      "half-body",
      "full-body",
      "object-sheet",
      "landscape",
    ],
  );
  const userPrompt = "A silver-haired explorer in a weathered red coat";
  assert.equal(composeImagePrompt(userPrompt, "free"), userPrompt);
  const turnaroundPrompt = composeImagePrompt(userPrompt, "character-turnaround");
  assert.match(turnaroundPrompt, /^\[COMPOSITION LOCK — HIGHEST PRIORITY\]/);
  assert.match(turnaroundPrompt, /EXACTLY FOUR non-overlapping full-body depictions/);
  assert.match(
    turnaroundPrompt,
    /\(1\) straight FRONT[\s\S]*\(2\) FRONT THREE-QUARTER[\s\S]*\(3\) exact LEFT PROFILE[\s\S]*\(4\) straight BACK/,
  );
  assert.match(turnaroundPrompt, /\[IDENTITY LOCK\]/);
  assert.match(turnaroundPrompt, /\[POSE LOCK\]/);
  assert.match(turnaroundPrompt, /\[SCALE AND CAMERA LOCK\]/);
  assert.match(turnaroundPrompt, /\[BACKGROUND LOCK\]/);
  assert.match(turnaroundPrompt, /\[STRICT EXCLUSIONS\]/);
  assert.match(turnaroundPrompt, /No extra people or characters/);
  assert.match(turnaroundPrompt, /No fifth view/);
  assert.match(turnaroundPrompt, /close-up/);
  assert.match(turnaroundPrompt, /cropped feet/);
  assert.match(turnaroundPrompt, /text, captions, labels/);
  const subjectSection = turnaroundPrompt.indexOf("[SUBJECT AND STYLE BRIEF");
  const userBrief = turnaroundPrompt.indexOf(userPrompt);
  const exclusions = turnaroundPrompt.indexOf("[STRICT EXCLUSIONS]");
  assert.ok(subjectSection > 0 && userBrief > subjectSection && exclusions > userBrief);
  const normalizedComposition = normalizeImageRequest({
    projectId: "project-test",
    mode: "generate",
    prompt: userPrompt,
    effectivePrompt: `${userPrompt}\n\nLegacy square character sheet instructions.`,
    compositionPreset: "character-turnaround",
    candidateCount: 1,
    aspectFormat: "1:1",
    width: 1024,
    height: 1024,
    seedMode: "random",
    references: [],
    tag: "character",
  });
  assert.equal(normalizedComposition.prompt, userPrompt);
  assert.equal(normalizedComposition.effectivePrompt, turnaroundPrompt);
  assert.equal(normalizedComposition.compositionPreset, "character-turnaround");
  assert.equal(normalizedComposition.aspectFormat, CHARACTER_TURNAROUND_FORMAT.aspectFormat);
  assert.equal(normalizedComposition.width, CHARACTER_TURNAROUND_FORMAT.width);
  assert.equal(normalizedComposition.height, CHARACTER_TURNAROUND_FORMAT.height);
  const normalizedAnima = normalizeImageRequest({
    projectId: "project-test",
    mode: "anima",
    prompt: "A heroine flying above a neon city",
    compositionPreset: "free",
    candidateCount: 1,
    aspectFormat: "16:9",
    width: 1792,
    height: 1008,
    seedMode: "fixed",
    seed: 7,
    references: [],
    tag: "character",
  });
  assert.equal(normalizedAnima.mode, "generate");
  assert.equal(normalizedAnima.imageMode, "anima");
  assert.throws(
    () => normalizeImageRequest({
      ...normalizedComposition,
      candidateCount: 1,
      effectivePrompt: userPrompt,
      compositionPreset: "close-up",
    }),
    /prompt effettivo non corrisponde/i,
  );
  assert.throws(
    () => normalizeImageRequest({
      ...normalizedComposition,
      candidateCount: 1,
      compositionPreset: "unknown",
    }),
    /preset di composizione immagine non valido/i,
  );

  const jobs = new JobRepository(temporaryDir);
  const projects = new ProjectRepository(jobs.databasePath);
  const images = new ImageJobRepository(jobs.databasePath);
  const firstProject = projects.create("Immagini A");
  const secondProject = projects.create("Immagini B");
  assert(firstProject && secondProject);

  const prepareRuntime = new RuntimeSettingsStore(temporaryDir);
  let queuedImage = 0;
  const imageService = new ImageStudioService(
    {
      queuePrompt: async () => ({
        promptId: `regenerated-image-${++queuedImage}`,
        queueNumber: queuedImage,
      }),
    } as never,
    images,
    prepareRuntime,
    path.join(process.cwd(), "workflows", "studio-krea2.api.json"),
    path.join(process.cwd(), "workflows", "studio-flux2-klein-edit.api.json"),
    path.join(process.cwd(), "workflows", "studio-anima.api.json"),
  );
  const preparedComposition = await imageService.prepare({
    projectId: firstProject.id,
    mode: "generate",
    prompt: userPrompt,
    effectivePrompt: `${userPrompt}\n\nLegacy square character sheet instructions.`,
    compositionPreset: "character-turnaround",
    candidateCount: 1,
    aspectFormat: "1:1",
    width: 1024,
    height: 1024,
    seedMode: "fixed",
    seed: 99,
    references: [],
    tag: "character",
  });
  assert.equal(preparedComposition.prompt, userPrompt);
  assert.equal(preparedComposition.effectivePrompt, turnaroundPrompt);
  assert.equal(preparedComposition.compositionPreset, "character-turnaround");
  assert.equal(preparedComposition.aspectFormat, "16:9");
  assert.equal(preparedComposition.width, 1792);
  assert.equal(preparedComposition.height, 1008);
  assert.equal(preparedComposition.engine.compositionPreset, "character-turnaround");
  assert.equal(preparedComposition.engine.effectivePrompt, turnaroundPrompt);
  assert.equal(
    preparedComposition.candidates[0].apiPrompt["4"].inputs.text,
    turnaroundPrompt,
  );
  assert.equal(preparedComposition.candidates[0].apiPrompt["7"].inputs.width, 1792);
  assert.equal(preparedComposition.candidates[0].apiPrompt["7"].inputs.height, 1008);

  const preparedAnima = await imageService.prepare({
    projectId: firstProject.id,
    mode: "anima",
    prompt: "A heroine flying above a neon city",
    compositionPreset: "free",
    candidateCount: 1,
    aspectFormat: "16:9",
    width: 1792,
    height: 1008,
    seedMode: "fixed",
    seed: 7,
    references: [],
    tag: "character",
  });
  assert.equal(preparedAnima.mode, "generate");
  assert.equal(preparedAnima.engine.kind, "anima");
  assert.equal(preparedAnima.candidates[0].apiPrompt["1"].inputs.unet_name, DEFAULT_RUNTIME_SETTINGS.anima.model);
  assert.equal(preparedAnima.candidates[0].apiPrompt["2"].inputs.type, "stable_diffusion");
  assert.equal(preparedAnima.candidates[0].apiPrompt["40"].inputs.steps, 8);
  assert.equal(preparedAnima.candidates[0].apiPrompt["40"].inputs.cfg, 1);

  const storedComposition = images.createPrepared(preparedComposition);
  assert.equal(storedComposition.prompt, userPrompt);
  assert.equal(storedComposition.effectivePrompt, turnaroundPrompt);
  assert.equal(storedComposition.compositionPreset, "character-turnaround");
  assert.equal(storedComposition.aspectFormat, "16:9");
  assert.equal(storedComposition.width, 1792);
  assert.equal(storedComposition.height, 1008);
  const renamedComposition = images.renameCandidate(preparedComposition.id, 1, "Turnaround Elara");
  assert.equal(renamedComposition?.candidates[0].displayName, "Turnaround Elara");
  await prepareRuntime.update({
    ...DEFAULT_RUNTIME_SETTINGS,
    krea: {
      ...DEFAULT_RUNTIME_SETTINGS.krea,
      model: "different-krea-after-original.safetensors",
      steps: 12,
    },
  });
  const editedRegenerationPrompt = "A luminous explorer turnaround in a white studio";
  const regeneratedComposition = await imageService.regenerate(
    preparedComposition.id,
    1,
    editedRegenerationPrompt,
  );
  assert.equal(regeneratedComposition.candidateCount, 1);
  assert.equal(regeneratedComposition.mode, "generate");
  assert.notEqual(regeneratedComposition.candidates[0].seed, 99);
  assert.equal(regeneratedComposition.prompt, editedRegenerationPrompt);
  assert.match(regeneratedComposition.effectivePrompt, /luminous explorer turnaround/i);
  assert.equal(
    regeneratedComposition.engine.model,
    storedComposition.engine.model,
    "regeneration must preserve the original engine snapshot",
  );
  assert.equal(regeneratedComposition.engine.steps, storedComposition.engine.steps);
  assert.equal(
    regeneratedComposition.compositionPreset,
    storedComposition.compositionPreset,
  );
  const compositionCleanup = new DatabaseSync(jobs.databasePath);
  compositionCleanup.exec("PRAGMA foreign_keys = ON");
  compositionCleanup.prepare("DELETE FROM image_jobs WHERE id = ?").run(regeneratedComposition.id);
  compositionCleanup.prepare("DELETE FROM image_jobs WHERE id = ?").run(preparedComposition.id);
  compositionCleanup.close();
  assert.equal(images.get(preparedComposition.id), null);

  const schema = new DatabaseSync(jobs.databasePath);
  const migration = schema
    .prepare("SELECT version FROM schema_migrations WHERE version = 15")
    .get() as { version: number } | undefined;
  assert.equal(migration?.version, 15);
  const tables = new Set(
    (
      schema
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'image_%'
              OR name = 'project_image_links'`,
        )
        .all() as unknown as Array<{ name: string }>
    ).map((row) => row.name),
  );
  assert.deepEqual(
    [...tables].sort(),
    [
      "image_candidates",
      "image_job_references",
      "image_jobs",
      "project_image_links",
    ],
  );
  schema.close();

  const editSettings = {
    ...DEFAULT_RUNTIME_SETTINGS.imageEdit,
    kvCacheEnabled: false,
    attentionBackend: "auto" as const,
  };
  const animaGraph = buildAnimaGeneratePrompt({
    prompt: "Anime pilot in a bright mechanical hangar",
    seed: 3,
    width: 1344,
    height: 1344,
    filenamePrefix: "tests/anima",
    settings: {
      ...DEFAULT_RUNTIME_SETTINGS.anima,
      loras: [{ name: "anima-highres-aesthetic-boost.safetensors", strength: 0.8 }],
    },
  });
  assert.equal(animaGraph["1"].inputs.unet_name, "anima_turboV10.safetensors");
  assert.equal(animaGraph["2"].inputs.clip_name, "anima_baseV10_txt.safetensors");
  assert.deepEqual(animaGraph["40"].inputs.model, ["20", 0]);
  assert.equal(animaGraph["20"].inputs.strength_model, 0.8);
  assert.deepEqual(animaGraph["42"].inputs.images, ["41", 0]);
  const oneReferenceGraph = buildFlux2KleinEditPrompt({
    prompt: "Change the coat to blue",
    seed: 1,
    width: 1024,
    height: 1024,
    filenamePrefix: "tests/one",
    settings: editSettings,
    references: [reference(1)],
  });
  assert.equal(
    Object.values(oneReferenceGraph).filter((node) => node.class_type === "LoadImage").length,
    1,
  );
  assert.deepEqual(oneReferenceGraph["60"].inputs.positive, ["23", 0]);
  assert.deepEqual(oneReferenceGraph["60"].inputs.negative, ["24", 0]);
  assert.equal(oneReferenceGraph["20"].inputs.image, "uploads/reference-1.png [input]");
  assert.match(String(oneReferenceGraph["4"].inputs.text), /Image 1 = base image/);
  assert.equal(oneReferenceGraph["10"], undefined);
  assert.equal(oneReferenceGraph["11"], undefined);

  const outputReferenceGraph = buildFlux2KleinEditPrompt({
    prompt: "Reuse an H3 Studio output",
    seed: 11,
    width: 1024,
    height: 1024,
    filenamePrefix: "tests/output-reference",
    settings: editSettings,
    references: [{
      ...reference(1),
      file: "images/H3_STUDIO/generated.png [output]",
    }],
    template: {
      "99": {
        class_type: "PreviewImage",
        inputs: { images: ["62", 0] },
      },
    },
  });
  assert.equal(
    outputReferenceGraph["20"].inputs.image,
    "images/H3_STUDIO/generated.png [output]",
  );
  assert.equal(outputReferenceGraph["99"].class_type, "PreviewImage");

  const fourReferences = [1, 2, 3, 4].map(reference);
  const fourReferenceGraph = buildFlux2KleinEditPrompt({
    prompt: "Combine the references",
    seed: 2,
    width: 1344,
    height: 768,
    filenamePrefix: "tests/four",
    settings: {
      ...editSettings,
      kvCacheEnabled: true,
      attentionBackend: "comfy kitchen attention",
    },
    references: fourReferences,
  });
  assert.equal(
    Object.values(fourReferenceGraph).filter((node) => node.class_type === "LoadImage").length,
    4,
  );
  assert.deepEqual(fourReferenceGraph["60"].inputs.positive, ["38", 0]);
  assert.deepEqual(fourReferenceGraph["60"].inputs.negative, ["39", 0]);
  assert.deepEqual(fourReferenceGraph["11"].inputs.model, ["1", 0]);
  assert.deepEqual(fourReferenceGraph["10"].inputs.model, ["11", 0]);
  assert.deepEqual(fourReferenceGraph["60"].inputs.model, ["10", 0]);
  assert.equal(fourReferenceGraph["9"].inputs.steps, 4);
  assert.equal(fourReferenceGraph["60"].inputs.cfg, 1);

  assert.throws(
    () =>
      buildFlux2KleinEditPrompt({
        prompt: "Too many references",
        seed: 3,
        width: 1024,
        height: 1024,
        filenamePrefix: "tests/five",
        settings: editSettings,
        references: [1, 2, 3, 4, 5].map(reference),
      }),
    /1 a 4 reference/,
  );
  assert.throws(
    () =>
      buildKreaGeneratePrompt({
        prompt: "Invalid size",
        seed: 4,
        width: 4096,
        height: 4096,
        filenamePrefix: "tests/oversize",
        settings: DEFAULT_RUNTIME_SETTINGS.krea,
      }),
    /4 megapixel/,
  );

  const prepared: PreparedImageJob = {
    id: "image-job-test",
    originProjectId: firstProject.id,
    mode: "edit",
    prompt: "Combine the references",
    effectivePrompt: composeImagePrompt("Combine the references", "half-body"),
    compositionPreset: "half-body",
    candidateCount: 2,
    aspectFormat: "16:9",
    width: 1344,
    height: 768,
    seedMode: "fixed",
    requestedSeed: 42,
    tag: "background",
    engine: {
      kind: "flux2-klein-edit",
      model: editSettings.model,
      encoder: editSettings.encoder,
      vae: editSettings.vae,
      steps: editSettings.steps,
      cfg: editSettings.cfg,
      sampler: "euler",
      scheduler: "flux2",
      kvCacheEnabled: false,
      attentionBackend: "auto",
      compositionPreset: "half-body",
      effectivePrompt: composeImagePrompt("Combine the references", "half-body"),
    },
    references: fourReferences,
    candidates: [
      {
        index: 1,
        seed: 42,
        filenamePrefix: "tests/repository",
        apiPrompt: fourReferenceGraph,
      },
      {
        index: 2,
        seed: 43,
        filenamePrefix: "tests/repository-2",
        apiPrompt: fourReferenceGraph,
      },
    ],
  };
  let stored = images.createPrepared(prepared);
  assert.equal(stored.prompt, "Combine the references");
  assert.equal(stored.compositionPreset, "half-body");
  assert.equal(stored.effectivePrompt, prepared.effectivePrompt);
  assert.equal(stored.references.length, 4);
  assert.equal(stored.candidates[0].projectLinks[0].projectId, firstProject.id);
  assert.equal(stored.candidates[0].projectLinks[0].tag, "background");
  images.markCandidateStatus("image-job-test", 1, "ready", {
    filename: "result.png",
    subfolder: "images/H3_STUDIO",
    type: "output",
    format: "image/png",
  });
  images.markCandidateStatus("image-job-test", 2, "ready", {
    filename: "result-2.png",
    subfolder: "images/H3_STUDIO",
    type: "output",
    format: "image/png",
  });
  const firstProjectJobs = images.list(20, firstProject.id);
  assert.equal(firstProjectJobs.length, 1);
  assert.deepEqual(firstProjectJobs[0].candidates.map((candidate) => candidate.index), [1, 2]);
  assert.equal(
    firstProjectJobs[0].candidates[0].output?.file,
    "images/H3_STUDIO/result.png [output]",
  );
  assert.equal(
    firstProjectJobs[0].candidates[0].output?.mediaPath,
    "/api/media?filename=result.png&subfolder=images%2FH3_STUDIO&type=output",
  );

  // Simulate a historical candidate whose output predates (or lost) its project link.
  // It must remain discoverable through the unfiltered picker fallback without re-uploading.
  const legacyDatabase = new DatabaseSync(jobs.databasePath);
  legacyDatabase
    .prepare(
      `DELETE FROM project_image_links
       WHERE project_id = ? AND image_job_id = ? AND image_candidate_index = ?`,
    )
    .run(firstProject.id, "image-job-test", 2);
  legacyDatabase.close();
  assert.deepEqual(
    images.list(20, firstProject.id)[0].candidates.map((candidate) => candidate.index),
    [1],
  );
  const reusableJobs = images.list(20);
  assert.equal(reusableJobs[0].candidates[1].index, 2);
  assert.equal(
    reusableJobs[0].candidates[1].output?.file,
    "images/H3_STUDIO/result-2.png [output]",
  );
  stored = images.linkProject(
    "image-job-test",
    1,
    secondProject.id,
    "character",
  );
  assert.equal(stored.candidates[0].projectLinks.length, 2);
  const sharedProjectJobs = images.list(20, secondProject.id);
  assert.equal(sharedProjectJobs.length, 1);
  assert.deepEqual(sharedProjectJobs[0].candidates.map((candidate) => candidate.index), [1]);
  stored = images.linkProject("image-job-test", 1, secondProject.id, "object");
  assert.equal(
    stored.candidates[0].projectLinks.find(
      (link) => link.projectId === secondProject.id,
    )?.tag,
    "object",
  );
  stored = images.unlinkProject("image-job-test", 1, secondProject.id);
  assert.equal(stored.candidates[0].projectLinks.length, 1);
  assert.equal(images.list(20, secondProject.id).length, 0);
  assert.equal(images.select("image-job-test", 1).selectedCandidateIndex, 1);

  const oldSettings = {
    h3: DEFAULT_RUNTIME_SETTINGS.h3,
    fast: DEFAULT_RUNTIME_SETTINGS.fast,
    krea: DEFAULT_RUNTIME_SETTINGS.krea,
  };
  await writeFile(
    path.join(temporaryDir, "runtime-settings.json"),
    JSON.stringify(oldSettings),
    "utf8",
  );
  const runtime = new RuntimeSettingsStore(temporaryDir);
  const migrated = await runtime.get();
  assert.deepEqual(migrated.imageEdit, DEFAULT_RUNTIME_SETTINGS.imageEdit);
  assert.deepEqual(migrated.anima, DEFAULT_RUNTIME_SETTINGS.anima);
  const updated = await runtime.update({
    ...oldSettings,
    imageEdit: {
      ...DEFAULT_RUNTIME_SETTINGS.imageEdit,
      kvCacheEnabled: true,
      attentionBackend: "pytorch attention",
    },
  });
  assert.equal(updated.imageEdit.kvCacheEnabled, true);
  assert.equal(updated.imageEdit.attentionBackend, "pytorch attention");
  assert.deepEqual(updated.anima, DEFAULT_RUNTIME_SETTINGS.anima);
  assert.equal(
    updated.h3.model,
    DEFAULT_RUNTIME_SETTINGS.h3.model,
    "updating Flux Image Edit must not alter the H3 model",
  );
  assert.equal(isAnimaModelFilename("anima_turboV10.safetensors"), true);
  assert.equal(isAnimaModelFilename("novaAnimeAM_v20.safetensors"), true);
  assert.equal(isAnimaModelFilename("novaFurryAM_v10.safetensors"), true);
  assert.equal(isAnimaModelFilename("novaOrangeAM_v15.safetensors"), true);
  assert.equal(isAnimaModelFilename("novaCartoonXL_v50.safetensors"), false);
  const novaAnimaUpdated = await runtime.update({
    ...updated,
    anima: {
      ...updated.anima,
      model: "novaAnimeAM_v20.safetensors",
    },
  });
  assert.equal(novaAnimaUpdated.anima.model, "novaAnimeAM_v20.safetensors");
  const persistedNovaRuntime = new RuntimeSettingsStore(temporaryDir);
  assert.equal(
    (await persistedNovaRuntime.get()).anima.model,
    "novaAnimeAM_v20.safetensors",
    "the selected Nova AM model must survive a fresh settings-store instance",
  );
  await assert.rejects(
    runtime.update({
      ...novaAnimaUpdated,
      anima: {
        ...novaAnimaUpdated.anima,
        model: "novaCartoonXL_v50.safetensors",
      },
    }),
    /non sembra compatibile con Anima/,
  );
  const snofsUpdated = await runtime.update({
    ...updated,
    imageEdit: {
      ...updated.imageEdit,
      model: "snofsSexNudesAndOtherFunStuff_distilledV12Fp8.safetensors",
      encoder: "qwen3_8b_abliterated_v2-fp8mixed.safetensors",
    },
  });
  assert.equal(
    snofsUpdated.imageEdit.encoder,
    "qwen3_8b_abliterated_v2-fp8mixed.safetensors",
  );
  await assert.rejects(
    runtime.update({
      ...snofsUpdated,
      imageEdit: {
        ...snofsUpdated.imageEdit,
        encoder: "qwen_3_4b.safetensors",
      },
    }),
    /richiede un text encoder Qwen 3 8B/,
  );
  await assert.rejects(
    runtime.update({
      ...snofsUpdated,
      imageEdit: {
        ...snofsUpdated.imageEdit,
        model: "sulphur2Mxfp8_sulphurMxfp8Distil.safetensors",
      },
    }),
    /non è compatibile con Flux\.2 Klein Edit/,
  );

  images.close();
  projects.close();
  jobs.close();
  console.log("Image Studio repository, graph and config tests passed.");
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}
