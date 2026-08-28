import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [rawCss, rawPage, rawImageStudio, rawRegenerateDialog] = await Promise.all([
  readFile("app/globals.css", "utf8"),
  readFile("app/page.tsx", "utf8"),
  readFile("app/image-studio-panel.tsx", "utf8"),
  readFile("app/regenerate-dialog.tsx", "utf8"),
]);
const normalizeNewlines = (value) => value.replace(/\r\n?/g, "\n");
const css = normalizeNewlines(rawCss);
const page = normalizeNewlines(rawPage);
const imageStudio = normalizeNewlines(rawImageStudio);
const regenerateDialog = normalizeNewlines(rawRegenerateDialog);

assert.match(css, /\.regenerate-dialog-backdrop\s*\{[^}]*position:\s*fixed/s);
assert.match(css, /\.regenerate-dialog\s*\{[^}]*max-height:/s);
assert.match(page, /<RegenerateDialog/);
assert.match(imageStudio, /<RegenerateDialog/);
assert.match(regenerateDialog, /Prompt della nuova generazione/);
assert.match(regenerateDialog, /l’originale resterà invariato/);
assert.match(page, /className=\{`content \$\{activeView === "chat" \? "chat-content" : ""\}`\}/);
assert.match(css, /\.content\.chat-content\s*\{[^}]*width:\s*100%[^}]*padding-left:\s*0/s);
assert.match(css, /\.chat-thread-sidebar\s*\{[^}]*position:\s*sticky[^}]*top:\s*88px/s);

assert.match(css, /\.candidate-footer\s*\{[^}]*flex-direction:\s*column/s);
assert.match(
  css,
  /\.postprocess-actions\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(76px,\s*1fr\)\)/s,
);
assert.match(css, /\.candidate-primary-actions\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
assert.match(css, /\.postprocess-source\s*\{[^}]*min-width:\s*0/s);
assert.match(css, /\.candidate-variant-actions\s*\{[^}]*min-width:\s*0/s);
assert.match(css, /\.variant-switch\s*\{[^}]*overflow-x:\s*auto/s);
assert.match(page, /className="candidate-primary-actions"/);
assert.match(page, /sourceVariantId:\s*activeVariant\.id/);
assert.match(page, /onClick=\{\(event\) => requestCandidateUpscale\(/);
assert.match(page, /onClick=\{confirmCandidateUpscale\}/);
const requestUpscalePattern =
  /function requestCandidateUpscale\([\s\S]*?\n  }\n\n  function confirmCandidateUpscale/;
const requestUpscaleBlock = page.match(requestUpscalePattern);
assert.ok(requestUpscaleBlock, "requestCandidateUpscale should be present");
assert.match(requestUpscaleBlock[0], /setPendingUpscaleRequest\(/);
assert.doesNotMatch(
  requestUpscaleBlock[0],
  /requireUpdatedPostprocessContract/,
  "the bridge guard must not prevent the confirmation modal from opening",
);
const runVariantPattern =
  /async function runCandidateVariant\([\s\S]*?\n  }\n\n  function applyCandidateDeletion/;
const runVariantBlock = page.match(runVariantPattern);
assert.ok(runVariantBlock, "runCandidateVariant should be present");
const normalizedCrlfPage = normalizeNewlines(page.replace(/\n/g, "\r\n"));
assert.ok(
  normalizedCrlfPage.match(requestUpscalePattern),
  "requestCandidateUpscale extraction should support CRLF checkouts",
);
assert.ok(
  normalizedCrlfPage.match(runVariantPattern),
  "runCandidateVariant extraction should support CRLF checkouts",
);
const guardIndex = runVariantBlock[0].indexOf(
  "requireUpdatedPostprocessContract()",
);
const postIndex = runVariantBlock[0].indexOf("await fetch(");
assert.ok(guardIndex >= 0, "the bridge guard should be present");
assert.ok(postIndex >= 0, "the post-process POST should be present");
assert.ok(
  guardIndex < postIndex,
  "the bridge guard must run before the post-process POST",
);
assert.match(runVariantBlock[0], /activeVariantId:\s*payload\.variant!\.id/);
assert.match(
  page,
  /const variantActive = \(job\.variants \?\? \[\]\)\.some\([\s\S]*?const active =[\s\S]*?\|\| variantActive/,
);
assert.match(page, /latestJobRestoreRef\.current/);
assert.match(page, /connection\.state !== "connected"/);
assert.match(page, /aria-modal="true"/);
assert.match(page, /role="dialog"/);
assert.match(page, /postprocessContract >= 2/);
assert.match(page, /Bridge non aggiornato: riavvia H3 Studio/);
assert.match(page, /className="upscale-confirm-bridge-alert"/);
assert.match(page, /role="alert"/);
assert.match(page, /disabled=\{postprocessContract < 2\}/);
assert.match(page, /Boolean\(control && !control\.disabled\)/);
assert.match(page, /function formatProcessingTime/);
assert.match(page, /function formatProcessingTimeLabel/);
assert.match(page, /return formatted \? `Tempo \${formatted}` : null/);
assert.match(page, /isReady \|\| isFailed\s*\? formatProcessingTime/s);
assert.match(page, /setCurrentJobMegapixels\(job\.request\.megapixels\)/);
assert.match(page, /candidateVersionMegapixels\(\s*currentJobMegapixels,/s);
assert.match(page, /\{\[5, 10, 15\]\.map/);
assert.match(page, /disabled=\{duration === 15 && item\.value > 0\.7\}/);
assert.match(page, /if \(nextDuration === 15 && megapixels > 0\.7\)/);
assert.match(page, /15 s supporta al massimo 0\.7 MP/);
assert.match(css, /\.segmented-control button:disabled\s*\{[^}]*cursor:\s*not-allowed/s);
const prepareVideoOperationPattern =
  /function prepareVideoOperation\([\s\S]*?\n  }\n\n  function prepareClipOperation/;
const prepareVideoOperationBlock = page.match(prepareVideoOperationPattern);
assert.ok(prepareVideoOperationBlock, "prepareVideoOperation should be present");
assert.match(prepareVideoOperationBlock[0], /setPrompt\(""\)/);
assert.match(prepareVideoOperationBlock[0], /il vecchio prompt non viene riutilizzato/);
assert.match(page, /const isFailed = candidate\.status === "failed"/);
assert.match(page, /\{!isFailed && \(\s*<div className=\{`progress-track/s);
assert.match(page, /\{\(isReady \|\| isFailed\) && \(\s*<button/s);
assert.match(page, /aria-label="Clip del progetto"/);
assert.match(page, /projectId: id/);
assert.match(page, /variantId: variant\?\.id \?\? null/);
assert.match(css, /\.montage-source-strip\s*\{[^}]*grid-auto-flow:\s*column[^}]*overflow-x:\s*auto/s);
assert.match(css, /\.upscale-confirm-backdrop\s*\{[^}]*position:\s*fixed/s);
assert.match(css, /\.upscale-confirm-dialog\s*\{[^}]*max-height:\s*calc\(100dvh - 40px\)/s);
assert.match(css, /\.upscale-confirm-bridge-alert\s*\{[^}]*border:/s);
assert.match(css, /\.upscale-confirm-actions button:disabled\s*\{[^}]*cursor:\s*not-allowed/s);
assert.match(css, /@media\s*\(max-width:\s*480px\)[^{]*\{[^}]*\.upscale-confirm-backdrop/s);

assert.match(imageStudio, /const TURNAROUND_FORMAT = "16:9" as const/);
const selectCompositionPattern =
  /function selectCompositionPreset\([\s\S]*?\n  }\n\n  async function run/;
const selectCompositionBlock = imageStudio.match(selectCompositionPattern);
assert.ok(selectCompositionBlock, "turnaround preset selection should be present");
assert.match(selectCompositionBlock[0], /preset === "character-turnaround"/);
assert.match(selectCompositionBlock[0], /setFormat\(TURNAROUND_FORMAT\)/);
assert.match(imageStudio, />1 foglio = 4 viste complete<\/strong>/);
assert.match(imageStudio, /Formato impostato su 16:9 per il turnaround\./);
assert.match(imageStudio, /className="image-turnaround-warning"[\s\S]*?role="alert"/);
assert.match(imageStudio, /Mantieni proporzioni · Reference 1/);
assert.match(page, /Mantieni proporzioni · Picture 1/);
assert.match(page, /Mantieni proporzioni · Video 1/);
assert.match(page, /Mantieni proporzioni · Picture\/Video 1/);
assert.match(page, /nextMode === "t2v" && aspectFormat === KEEP_SOURCE_ASPECT_FORMAT/);
assert.match(imageStudio, />\s*Ripristina 16:9\s*<\/button>/);
assert.match(imageStudio, /aria-invalid=\{turnaroundFormatMismatch \|\| undefined\}/);
assert.match(
  imageStudio,
  /disabled=\{[^}]*!selectedEngineReady \|\| turnaroundFormatMismatch \|\| keepAspectUnavailable \|\| \(plannerEnabled/,
);
const imageRunPattern = /async function run\(\)[\s\S]*?\n  }\n\n  async function refresh/;
const imageRunBlock = imageStudio.match(imageRunPattern);
assert.ok(imageRunBlock, "image submit handler should be present");
const turnaroundGuardIndex = imageRunBlock[0].indexOf("if (turnaroundFormatMismatch)");
const imagePostIndex = imageRunBlock[0].indexOf("await fetch(");
assert.ok(turnaroundGuardIndex >= 0, "turnaround format guard should be present");
assert.ok(imagePostIndex >= 0, "image POST should be present");
assert.ok(
  turnaroundGuardIndex < imagePostIndex,
  "the incompatible turnaround format must be blocked before the POST",
);
assert.doesNotMatch(
  imageRunBlock[0],
  /setFormat\(TURNAROUND_FORMAT\)/,
  "submit must not hide a format override",
);
assert.match(
  imageRunBlock[0],
  /aspectFormat: selectedFormat\.value, width: selectedFormat\.width, height: selectedFormat\.height/,
);
assert.match(css, /\.image-turnaround-guidance[\s\S]*?grid-column:\s*1 \/ -1/);
assert.match(css, /\.image-turnaround-warning\s*\{[^}]*border:/s);

assert.match(css, /\.asset-library-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,/s);
assert.match(css, /\.asset-studio-dropzone\s*\{[^}]*border-left:/s);
assert.match(css, /\.send-assets-to-studio\s*\{[^}]*display:\s*flex/s);
assert.match(page, /className="asset-library-grid"/);
assert.match(page, /className=\{`asset-studio-dropzone/);
assert.match(page, /Manda a Studio/);
assert.match(page, /function openImagePreview\(/);
assert.match(page, /async function deleteAssetImage\(/);
assert.match(page, /\/api\/image-jobs\/\$\{image\.jobId\}\/candidates\/\$\{image\.candidateIndex\}\/delete/);
assert.match(page, /\/api\/library-references\/\$\{image\.referenceId\}\/delete/);
assert.match(page, /className="reference-lightbox asset-image-lightbox"/);
assert.match(page, /className=\{`asset-image-lightbox-canvas/);
assert.match(css, /\.asset-library-card-actions\s*\{[^}]*position:\s*absolute/s);
assert.match(css, /\.asset-image-lightbox-canvas\.zoomed img\s*\{[^}]*min-width:\s*150%/s);
assert.match(css, /\.media-picker-backdrop\s*\{[^}]*position:\s*fixed/s);
assert.match(css, /\.media-library-modal\s*\{[^}]*width:\s*min\(1320px,/s);
assert.match(css, /\.media-asset-actions\s*\{[^}]*display:\s*flex/s);
assert.match(css, /\.image-reference-order\s*\{[^}]*grid-template-columns:\s*1\.7fr 1fr 1fr 1fr/s);
assert.match(page, /className="media-asset-actions"/);
assert.match(imageStudio, /className="media-library-picker media-library-modal image-library-modal"/);
assert.match(page, /className="mention-thumbnail"/);
assert.match(page, /item\.previewKind === "picture"/);
assert.match(page, /item\.previewKind === "video"/);
assert.match(page, /item\.previewPath\}#t=0\.1/);
assert.match(page, /aria-selected="false"/);
assert.match(page, /fetch\(`\$\{bridgeUrl\}\/api\/external-media`/);
assert.match(page, /<strong>Esterni<\/strong>/);
assert.match(page, /asset caricati e salvati in Libreria come Esterni/);
assert.match(page, /renameTimeline/);
assert.match(page, /renameCreativeAsset/);
assert.match(page, /renameExternalMedia/);
assert.match(page, /renameVideo/);
assert.match(page, /renameAssetImage/);
assert.match(page, /media-rename-button/);
assert.match(page, /libraryBulkSelected/);
assert.match(page, /deleteLibrarySelection/);
assert.match(page, /assetBulkSelected/);
assert.match(page, /deleteAssetSelection/);
assert.match(page, /Elimina selezionati/);
assert.match(page, /Elimina selezionate/);
assert.match(css, /\.bulk-select-button/);
assert.match(css, /\.bulk-selection-actions/);
assert.match(page, /item\.kind === "external"/);
assert.match(page, /onUseExternal=\{addExternalMedia\}/);
assert.match(page, /onUseImage=\{\(image\) => sendAssetImagesToStudio\(\[image\]\)\}/);
assert.match(page, /Personaggi, oggetti e luoghi/);
assert.match(page, /label: "Luoghi"/);
assert.match(imageStudio, /fetch\(`\$\{bridgeUrl\}\/api\/external-media`/);
assert.match(imageStudio, /detail: "Esterno"/);
assert.match(imageStudio, /salvate in Libreria come Esterni/);
assert.match(css, /\.mention-thumbnail\s*\{[^}]*width:\s*54px[^}]*height:\s*46px/s);
assert.match(css, /\.mention-thumbnail img,[\s\S]*?object-fit:\s*cover/s);

const h3ModelSelect = page.match(/<span>Modello H3<\/span>[\s\S]*?<\/select>/);
assert.ok(h3ModelSelect, "H3 model select should be present");
assert.match(h3ModelSelect[0], /h3Models\.map/);
assert.doesNotMatch(h3ModelSelect[0], /settings\.imageEdit/);
const kreaModelSelect = page.match(/<span>Modello Krea<\/span>[\s\S]*?<\/select>/);
assert.ok(kreaModelSelect, "Krea model select should be present");
assert.match(kreaModelSelect[0], /kreaModels\.map/);
const fluxModelSelect = page.match(/<span>Modello Flux\.2 Klein<\/span>[\s\S]*?<\/select>/);
assert.ok(fluxModelSelect, "Flux model select should be present");
assert.match(fluxModelSelect[0], /imageEditModels\.map/);
assert.match(page, /data\.settings\.krea\.encoder,[\s\S]*?qwen\.\*\(\?:vl\|vision\)/);
assert.match(page, /data\.settings\.krea\.vae,[\s\S]*?qwen\.\*image\.\*vae/);
assert.match(page, /data\.settings\.imageEdit\.encoder,[\s\S]*?qwen\[_-\]\?3/);
assert.match(page, /data\.settings\.imageEdit\.vae,[\s\S]*?flux\.\*2\.\*vae/);
assert.match(page, /hidden=\{activeView !== "studio" \|\| studioMediaMode !== "image"\}/);
assert.match(page, /hidden=\{activeView !== "studio" \|\| studioMediaMode !== "audio"\}/);

console.log("Preview layout, image turnaround and Assets handoff UI: OK");
