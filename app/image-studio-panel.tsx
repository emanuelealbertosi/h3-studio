"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import RegenerateDialog from "./regenerate-dialog";
import {
  composeImagePrompt,
  IMAGE_EDIT_KEEP_ASPECT_FORMAT,
  IMAGE_COMPOSITION_PRESETS,
  imageEditKeepAspectDimensions,
  imageCompositionPreset,
  type ImageCompositionPreset,
} from "../lib/image-composition";

type SeedMode = "random" | "base" | "fixed";
type ImageMode = "generate" | "edit" | "anima";
type ImageEngineChoice = "default" | "minimax";
type H3ImageSteps = 8 | 12 | 20 | 30;
type H3ImageMegapixels = 0.5 | 0.7 | 0.98 | 2;
type ImageTag = "untagged" | "character" | "object" | "background";
type ReferenceRole = "base" | "subject" | "style" | "pose" | "background" | "other";
type ProjectOption = { id: string; name: string };

type ImageReference = {
  file: string;
  name?: string;
  width?: number | null;
  height?: number | null;
  mediaPath?: string;
  role: ReferenceRole;
  uid: string;
};

type ImageOutput = {
  mediaPath: string;
  filename?: string;
  file?: string;
  subfolder?: string;
  type?: "input" | "output" | "temp";
  width?: number | null;
  height?: number | null;
};

type ImageCandidate = {
  index: number;
  seed: number;
  status: string;
  promptId?: string | null;
  phaseLabel?: string | null;
  progress?: number | null;
  output: ImageOutput | null;
  error?: string | null;
  projectLinks?: ImageProjectLink[];
};

type ImageProjectLink = string | {
  projectId: string;
  projectName?: string | null;
  candidateIndex?: number | null;
  tag?: ImageTag | null;
};

type ImageJob = {
  id: string;
  originProjectId: string | null;
  originProjectName: string | null;
  mode: ImageMode;
  prompt: string;
  effectivePrompt?: string;
  compositionPreset?: ImageCompositionPreset;
  candidateCount: number;
  aspectFormat: string;
  width: number;
  height: number;
  seedMode: SeedMode;
  requestedSeed?: number | null;
  selectedCandidateIndex: number | null;
  status: string;
  engine: string | { kind?: string; model?: string; workflow?: string; steps?: number; megapixels?: number };
  references: Array<Omit<ImageReference, "uid">>;
  candidates: ImageCandidate[];
  projectLinks: ImageProjectLink[];
  tag?: ImageTag;
};

type Props = {
  bridgeUrl: string;
  projects: ProjectOption[];
  projectId: string;
  projectName?: string | null;
  incomingReferences?: ImageStudioIncomingReference[];
  initialJobId?: string | null;
  onUseAsVideoReference: (reference: ImageStudioIncomingReference) => void;
};

export type ImageStudioIncomingReference = {
  file: string;
  name?: string;
  width?: number | null;
  height?: number | null;
  mediaPath?: string;
  role?: ReferenceRole;
};

type ImageLibraryReference = {
  id: string;
  file: string;
  name?: string;
  label?: string;
  mediaPath: string;
  width?: number | null;
  height?: number | null;
};

type ImageLibraryAsset = {
  id: string;
  name: string;
  description?: string;
  references?: ImageLibraryReference[];
};

type ImageLibraryItem = {
  id: string;
  name: string;
  detail: string;
  file: string;
  mediaPath: string;
  width?: number | null;
  height?: number | null;
};

type ImageStudioStatus = {
  generate: { ready: boolean };
  edit: { ready: boolean };
  anima: { ready: boolean };
  minimax: { ready: boolean };
};

type PromptPlannerStatus = { ready: boolean; model: string; unloadPolicy: string };
type PromptPlan = { prompt: string; summary: string; language: string };

const formats = [
  { value: "1:1", label: "1:1 · Quadrato", width: 1344, height: 1344 },
  { value: "16:9", label: "16:9 · Orizzontale", width: 1792, height: 1008 },
  { value: "9:16", label: "9:16 · Verticale", width: 1008, height: 1792 },
  { value: "4:3", label: "4:3 · Orizzontale", width: 1536, height: 1152 },
  { value: "3:4", label: "3:4 · Verticale", width: 1152, height: 1536 },
] as const;

const h3ImageStepOptions: H3ImageSteps[] = [8, 12, 20, 30];
const h3ImageResolutionOptions: Array<{ value: H3ImageMegapixels; label: string; detail: string }> = [
  { value: 0.5, label: "MIN", detail: "0.5 MP" },
  { value: 0.7, label: "MID", detail: "0.7 MP" },
  { value: 0.98, label: "MAX", detail: "0.98 MP" },
  { value: 2, label: "2K", detail: "2.0 MP" },
];

const TURNAROUND_FORMAT = "16:9" as const;
type ImageFormatValue = (typeof formats)[number]["value"] | typeof IMAGE_EDIT_KEEP_ASPECT_FORMAT;

const tags: Array<{ value: ImageTag; label: string }> = [
  { value: "untagged", label: "Senza tag" },
  { value: "character", label: "Personaggio" },
  { value: "object", label: "Oggetto" },
  { value: "background", label: "Luogo" },
];

const roles: Array<{ value: ReferenceRole; label: string }> = [
  { value: "base", label: "Base" },
  { value: "subject", label: "Soggetto" },
  { value: "style", label: "Stile" },
  { value: "pose", label: "Posa" },
  { value: "background", label: "Sfondo" },
  { value: "other", label: "Altro" },
];

function mediaUrl(bridgeUrl: string, path: string) {
  return /^https?:\/\//i.test(path) ? path : `${bridgeUrl}${path}`;
}

function downloadUrl(bridgeUrl: string, path: string) {
  const url = mediaUrl(bridgeUrl, path);
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

function ready(candidate: ImageCandidate) {
  return candidate.status === "ready" || candidate.status === "completed";
}

function failed(candidate: ImageCandidate) {
  return candidate.status === "failed" || candidate.status === "cancelled";
}

function active(job: ImageJob | null) {
  if (!job) return false;
  const activeStates = ["prepared", "submitted", "queued", "running", "processing"];
  return activeStates.includes(job.status) || job.candidates.some((candidate) => activeStates.includes(candidate.status));
}

function engineLabel(engine: ImageJob["engine"]) {
  return typeof engine === "string" ? engine : engine.model ?? engine.workflow ?? "Motore immagini";
}

function h3StepsFromEngine(engine: ImageJob["engine"]): H3ImageSteps {
  if (typeof engine !== "object") return 20;
  return h3ImageStepOptions.includes(engine.steps as H3ImageSteps)
    ? engine.steps as H3ImageSteps
    : 20;
}

function h3MegapixelsFromJob(job: ImageJob): H3ImageMegapixels {
  const snapshot = typeof job.engine === "object" ? Number(job.engine.megapixels) : Number.NaN;
  const actual = Number.isFinite(snapshot)
    ? snapshot
    : (job.width * job.height) / (1024 * 1024);
  return h3ImageResolutionOptions.reduce(
    (best, option) => Math.abs(option.value - actual) < Math.abs(best - actual) ? option.value : best,
    0.98 as H3ImageMegapixels,
  );
}

function statusLabel(candidate: ImageCandidate) {
  if (candidate.phaseLabel) return candidate.phaseLabel;
  if (candidate.status === "idle") return "Pronto a generare";
  if (["prepared", "submitted"].includes(candidate.status)) return "Invio a ComfyUI";
  if (candidate.status === "queued") return "In coda";
  if (["running", "processing"].includes(candidate.status)) return "Generazione immagine";
  if (candidate.status === "cancelled") return "Interrotta";
  if (candidate.status === "failed") return "Generazione fallita";
  if (ready(candidate)) return "Pronta";
  return candidate.status;
}

function linksFor(job: ImageJob, candidateIndex: number) {
  return (job.projectLinks ?? []).flatMap((link) => {
    if (typeof link === "string") return [{ projectId: link, projectName: null, tag: "untagged" as ImageTag }];
    if (link.candidateIndex != null && link.candidateIndex !== candidateIndex) return [];
    return [{ projectId: link.projectId, projectName: link.projectName ?? null, tag: link.tag ?? "untagged" }];
  });
}

function referenceFile(output: ImageOutput) {
  if (output.file) return output.file;
  const relative = [output.subfolder, output.filename].filter(Boolean).join("/");
  return relative ? `${relative} [${output.type ?? "output"}]` : output.mediaPath;
}

function referenceMediaPath(file: string) {
  const normalized = file.trim().replaceAll("\\", "/");
  const match = normalized.match(/^(.*?)(?: \[(input|output|temp)\])$/i);
  if (!match) return undefined;
  const relative = match[1];
  const slash = relative.lastIndexOf("/");
  const query = new URLSearchParams({
    filename: slash >= 0 ? relative.slice(slash + 1) : relative,
    subfolder: slash >= 0 ? relative.slice(0, slash) : "",
    type: match[2].toLowerCase(),
  });
  return "/api/media?" + query.toString();
}

function fitH3ImageArea(width: number, height: number, megapixels: H3ImageMegapixels) {
  const ratio = Math.max(1 / 32, Math.min(32, width / height));
  const area = megapixels * 1024 * 1024;
  return {
    width: Math.max(64, Math.round(Math.sqrt(area * ratio) / 32) * 32),
    height: Math.max(64, Math.round(Math.sqrt(area / ratio) / 32) * 32),
  };
}

export default function ImageStudioPanel({
  bridgeUrl,
  projects,
  projectId,
  projectName,
  incomingReferences = [],
  initialJobId = null,
  onUseAsVideoReference,
}: Props) {
  const [mode, setMode] = useState<ImageMode>(
    incomingReferences.length ? "edit" : "generate",
  );
  const [engineChoice, setEngineChoice] = useState<ImageEngineChoice>("default");
  const [h3Steps, setH3Steps] = useState<H3ImageSteps>(20);
  const [h3Megapixels, setH3Megapixels] = useState<H3ImageMegapixels>(0.98);
  const [prompt, setPrompt] = useState("");
  const [plannerEnabled, setPlannerEnabled] = useState(true);
  const [plannerIdea, setPlannerIdea] = useState("");
  const [plannerReady, setPlannerReady] = useState(false);
  const [plannerSummary, setPlannerSummary] = useState("");
  const [plannerStatus, setPlannerStatus] = useState<PromptPlannerStatus | null>(null);
  const [compositionPreset, setCompositionPreset] =
    useState<ImageCompositionPreset>("free");
  const [candidateCount, setCandidateCount] = useState(4);
  const [format, setFormat] = useState<ImageFormatValue>("1:1");
  const [seedMode, setSeedMode] = useState<SeedMode>("random");
  const [seedValue, setSeedValue] = useState("1024");
  const [tag, setTag] = useState<ImageTag>("untagged");
  const [references, setReferences] = useState<ImageReference[]>(() =>
    incomingReferences.slice(0, 4).map((reference, index) => ({
      ...reference,
      mediaPath: reference.mediaPath ?? referenceMediaPath(reference.file),
      role: reference.role ?? (index === 0 ? "base" : "other"),
      uid: crypto.randomUUID(),
    })),
  );
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryImages, setLibraryImages] = useState<ImageLibraryItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [jobs, setJobs] = useState<ImageJob[]>([]);
  const [job, setJob] = useState<ImageJob | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [regenerateTarget, setRegenerateTarget] = useState<{
    candidateIndex?: number;
  } | null>(null);
  const [shareTargets, setShareTargets] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(
    incomingReferences.length
      ? `${Math.min(incomingReferences.length, 4)} asset ricevuti dalla libreria`
      : null,
  );
  const [engineStatus, setEngineStatus] = useState<ImageStudioStatus | null>(null);
  const [engineStatusError, setEngineStatusError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const composerRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const loadGenerationRef = useRef(0);
  const usingMiniMax = engineChoice === "minimax" && mode !== "anima";
  const keepAspectDimensions = imageEditKeepAspectDimensions(
    references[0]?.width,
    references[0]?.height,
  );
  const keepAspectUnavailable =
    mode === "edit" && format === IMAGE_EDIT_KEEP_ASPECT_FORMAT && !keepAspectDimensions;
  const baseSelectedFormat = format === IMAGE_EDIT_KEEP_ASPECT_FORMAT && keepAspectDimensions
    ? {
        value: IMAGE_EDIT_KEEP_ASPECT_FORMAT,
        label: "Mantieni proporzioni",
        width: keepAspectDimensions.width,
        height: keepAspectDimensions.height,
      }
    : formats.find((item) => item.value === format) ?? formats[0];
  const h3Dimensions = fitH3ImageArea(
    baseSelectedFormat.width,
    baseSelectedFormat.height,
    h3Megapixels,
  );
  const selectedFormat = usingMiniMax
    ? { ...baseSelectedFormat, ...h3Dimensions }
    : baseSelectedFormat;
  const selectedComposition = imageCompositionPreset(compositionPreset);
  const turnaroundFormatMismatch =
    compositionPreset === "character-turnaround" && format !== TURNAROUND_FORMAT;
  const effectivePrompt = useMemo(
    () => composeImagePrompt(prompt, compositionPreset),
    [compositionPreset, prompt],
  );
  const orderedProjects = useMemo(() => [...projects].sort((a, b) => a.name.localeCompare(b.name)), [projects]);
  const visibleCandidates = job
    ? job.candidates.filter((candidate) => {
        const candidateLinks = candidate.projectLinks === undefined
          ? linksFor(job, candidate.index)
          : candidate.projectLinks.flatMap((link) =>
              typeof link === "string"
                ? [{ projectId: link }]
                : [{ projectId: link.projectId }],
            );
        return candidateLinks.some((link) => link.projectId === projectId);
      })
    : Array.from({ length: candidateCount }, (_, index): ImageCandidate => ({ index: index + 1, seed: 0, status: "idle", output: null }));
  const referenceLimit = usingMiniMax ? 9 : 4;
  const miniMaxReferenceCount = mode === "edit" ? references.length : 0;
  const miniMaxImageMode = miniMaxReferenceCount === 0 ? "T2I" : miniMaxReferenceCount === 1 ? "I2I" : "REFERENCE";
  const selectedEngineReady = usingMiniMax
    ? engineStatus?.minimax.ready === true
    : mode === "edit"
      ? engineStatus?.edit.ready === true
    : mode === "anima"
      ? engineStatus?.anima.ready === true
      : engineStatus?.generate.ready === true;

  useEffect(() => {
    if (!libraryOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLibraryOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [libraryOpen]);

  async function openImageLibrary() {
    setLibraryOpen(true);
    setLibraryBusy(true);
    try {
      const [jobsResponse, assetsResponse, externalResponse] = await Promise.all([
        fetch(`${bridgeUrl}/api/image-jobs?limit=200`, { cache: "no-store" }),
        fetch(`${bridgeUrl}/api/library`, { cache: "no-store" }),
        fetch(`${bridgeUrl}/api/external-media`, { cache: "no-store" }),
      ]);
      const jobsPayload = (await jobsResponse.json()) as { jobs?: ImageJob[]; error?: string };
      const assetsPayload = (await assetsResponse.json()) as { assets?: ImageLibraryAsset[]; error?: string };
      const externalPayload = (await externalResponse.json()) as {
        assets?: Array<{
          id: string;
          kind: "picture" | "video" | "audio";
          file: string;
          originalName: string;
          mediaPath: string;
          width: number | null;
          height: number | null;
        }>;
        error?: string;
      };
      if (!jobsResponse.ok) throw new Error(jobsPayload.error ?? `Bridge HTTP ${jobsResponse.status}`);
      if (!assetsResponse.ok) throw new Error(assetsPayload.error ?? `Bridge HTTP ${assetsResponse.status}`);
      if (!externalResponse.ok) throw new Error(externalPayload.error ?? `Bridge HTTP ${externalResponse.status}`);
      const assets = await Promise.all(
        (assetsPayload.assets ?? []).map(async (asset) => {
          const response = await fetch(`${bridgeUrl}/api/library/${asset.id}`, { cache: "no-store" });
          if (!response.ok) return asset;
          const payload = (await response.json()) as { asset?: ImageLibraryAsset };
          return payload.asset ?? asset;
        }),
      );
      const collected: ImageLibraryItem[] = [];
      const seen = new Set<string>();
      for (const imageJob of jobsPayload.jobs ?? []) {
        for (const candidate of imageJob.candidates) {
          if (!ready(candidate) || !candidate.output) continue;
          const file = referenceFile(candidate.output);
          const key = file.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push({
            id: `generated:${imageJob.id}:${candidate.index}`,
            name: `Immagine ${imageJob.id.slice(0, 8)} · candidato ${candidate.index}`,
            detail: imageJob.prompt,
            file,
            mediaPath: candidate.output.mediaPath,
            width: candidate.output.width ?? imageJob.width,
            height: candidate.output.height ?? imageJob.height,
          });
        }
      }
      for (const external of externalPayload.assets ?? []) {
        if (external.kind !== "picture") continue;
        const key = external.file.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push({
          id: `external:${external.id}`,
          name: external.originalName,
          detail: "Esterno",
          file: external.file,
          mediaPath: external.mediaPath,
          width: external.width,
          height: external.height,
        });
      }
      for (const asset of assets) {
        for (const reference of asset.references ?? []) {
          const key = reference.file.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push({
            id: `asset:${reference.id}`,
            name: `${asset.name} · ${reference.label ?? reference.name ?? "reference"}`,
            detail: asset.description ?? "Asset della libreria",
            file: reference.file,
            mediaPath: reference.mediaPath,
            width: reference.width,
            height: reference.height,
          });
        }
      }
      setLibraryImages(collected);
      setMessage(collected.length ? `${collected.length} immagini disponibili in libreria` : "La libreria immagini è vuota");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Libreria immagini non disponibile");
    } finally {
      setLibraryBusy(false);
    }
  }

  function addLibraryReference(image: ImageLibraryItem) {
    setReferences((current) => {
      if (current.some((reference) => reference.file.toLowerCase() === image.file.toLowerCase())) {
        setMessage("Questa immagine è già allegata");
        return current;
      }
      if (current.length >= referenceLimit) {
        setMessage(`${usingMiniMax ? "Image H3" : "Flux Klein"} accetta al massimo ${referenceLimit} reference`);
        return current;
      }
      const next = [...current, {
        file: image.file,
        name: image.name,
        width: image.width,
        height: image.height,
        mediaPath: image.mediaPath,
        role: (current.length === 0 ? "base" : "other") as ReferenceRole,
        uid: crypto.randomUUID(),
      }];
      setMessage(`${image.name} allegata a ${usingMiniMax ? "Image H3" : "Flux Klein Edit"}`);
      return next;
    });
    setMode("edit");
  }

  function insertReferenceInPrompt(index: number) {
    const token = usingMiniMax ? `<Picture ${index + 1}>` : `reference image ${index + 1}`;
    const textarea = promptRef.current;
    const start = textarea?.selectionStart ?? prompt.length;
    const end = textarea?.selectionEnd ?? start;
    let caret = start + token.length;
    setPrompt((current) => {
      const before = current.slice(0, start);
      const after = current.slice(end);
      const prefix = before && !/\s$/.test(before) ? " " : "";
      const suffix = after && !/^\s/.test(after) ? " " : "";
      caret = before.length + prefix.length + token.length;
      return `${before}${prefix}${token}${suffix}${after}`;
    });
    window.requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(caret, caret);
    });
  }

  async function loadJobs(preferId?: string | null) {
    const loadGeneration = ++loadGenerationRef.current;
    if (!projectId) { setJobs([]); setJob(null); setActiveJobId(null); return; }
    const query = new URLSearchParams({ projectId, limit: "40" });
    const response = await fetch(`${bridgeUrl}/api/image-jobs?${query}`, { cache: "no-store" });
    const payload = (await response.json()) as { jobs?: ImageJob[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
    if (loadGeneration !== loadGenerationRef.current) return;
    const loaded = payload.jobs ?? [];
    const selected = loaded.find((item) => item.id === preferId) ?? loaded[0] ?? null;
    setJobs(loaded);
    setJob(selected);
    setActiveJobId(selected && active(selected) ? selected.id : null);
    if (selected) {
      setMode(selected.mode);
      setEngineChoice(typeof selected.engine === "object" && selected.engine.kind === "minimax-h3-image" ? "minimax" : "default");
      setPrompt(selected.prompt);
      setPlannerIdea(selected.prompt);
      setPlannerReady(true);
      setCompositionPreset(selected.compositionPreset ?? "free");
      setCandidateCount(selected.candidateCount);
      setFormat((selected.aspectFormat === IMAGE_EDIT_KEEP_ASPECT_FORMAT || formats.some((item) => item.value === selected.aspectFormat) ? selected.aspectFormat : "1:1") as ImageFormatValue);
      if (typeof selected.engine === "object" && selected.engine.kind === "minimax-h3-image") {
        setH3Steps(h3StepsFromEngine(selected.engine));
        setH3Megapixels(h3MegapixelsFromJob(selected));
      }
      setReferences(selected.mode === "edit" ? selected.references.map((reference) => ({ ...reference, mediaPath: referenceMediaPath(reference.file), uid: crypto.randomUUID() })) : []);
    }
  }

  useEffect(() => {
    let disposed = false;
    loadGenerationRef.current += 1;
    const timer = window.setTimeout(() => {
      setActiveJobId(null);
      setJob(null);
      void loadJobs(initialJobId).then(() => {
        if (!disposed && initialJobId) setMessage(`Job ${initialJobId.slice(0, 8)} aperto dalla Chat`);
      }).catch((error) => { if (!disposed) setMessage(error instanceof Error ? error.message : "Immagini non disponibili"); });
    }, 0);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [initialJobId, projectId]);

  useEffect(() => {
    let disposed = false;
    void fetch(bridgeUrl + "/api/image-jobs/capabilities", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as { imageStudio?: ImageStudioStatus; error?: string };
        if (!response.ok || !payload.imageStudio) {
          throw new Error(payload.error ?? "Bridge HTTP " + response.status);
        }
        if (!disposed) {
          setEngineStatus(payload.imageStudio);
          setEngineStatusError(null);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setEngineStatus(null);
          setEngineStatusError(error instanceof Error ? error.message : "Motore immagini non disponibile");
        }
      });
    return () => { disposed = true; };
  }, [bridgeUrl]);

  useEffect(() => {
    let disposed = false;
    void fetch(bridgeUrl + "/api/prompt-planner/capabilities", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { planner?: PromptPlannerStatus; error?: string };
        if (!response.ok || !payload.planner) throw new Error(payload.error ?? "Prompt Compiler non disponibile");
        if (!disposed) setPlannerStatus(payload.planner);
      })
      .catch(() => { if (!disposed) setPlannerStatus(null); });
    return () => { disposed = true; };
  }, [bridgeUrl]);

  useEffect(() => {
    if (!activeJobId) return;
    let disposed = false;
    const poll = async () => {
      try {
        const response = await fetch(`${bridgeUrl}/api/image-jobs/${activeJobId}`, { cache: "no-store" });
        const payload = (await response.json()) as { job?: ImageJob; error?: string };
        if (!response.ok || !payload.job) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
        if (disposed) return;
        setJob(payload.job);
        setJobs((current) => [payload.job!, ...current.filter((item) => item.id !== payload.job!.id)]);
        if (!active(payload.job)) {
          setActiveJobId(null);
          setMessage(payload.job.status === "failed" ? "Generazione immagini fallita" : payload.job.status === "cancelled" ? "Generazione immagini interrotta" : "Generazione immagini completata");
        }
      } catch (error) {
        if (!disposed) setMessage(error instanceof Error ? error.message : "Monitoraggio immagini fallito");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [activeJobId, bridgeUrl]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const selected = Array.from(files).slice(0, Math.max(0, referenceLimit - references.length));
    if (!selected.length) { setMessage(`Puoi usare al massimo ${referenceLimit} reference.`); return; }
    setUploading(true);
    try {
      const added: ImageReference[] = [];
      for (const file of selected) {
        const body = new FormData(); body.append("file", file, file.name);
        const query = `?${new URLSearchParams({ projectId }).toString()}`;
        const response = await fetch(`${bridgeUrl}/api/assets/upload${query}`, { method: "POST", body });
        const payload = (await response.json()) as { asset?: { kind?: string; file: string; name?: string; mediaPath?: string; width?: number | null; height?: number | null }; error?: string };
        if (!response.ok || !payload.asset) throw new Error(payload.error ?? `Upload HTTP ${response.status}`);
        if (payload.asset.kind && payload.asset.kind !== "picture") throw new Error(`${file.name} non è un'immagine`);
        added.push({
          ...payload.asset,
          mediaPath: payload.asset.mediaPath ?? referenceMediaPath(payload.asset.file),
          role: references.length + added.length === 0 ? "base" : "subject",
          uid: crypto.randomUUID(),
        });
      }
      setReferences((current) => [...current, ...added].slice(0, referenceLimit)); setMode("edit");
      setMessage(`${added.length} reference caricate e salvate in Libreria come Esterni`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Upload fallito"); }
    finally { setUploading(false); }
  }

  function moveReference(index: number, delta: -1 | 1) {
    setReferences((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next;
    });
  }

  function selectCompositionPreset(preset: ImageCompositionPreset) {
    setCompositionPreset(preset);
    if (preset === "character-turnaround") {
      setFormat(TURNAROUND_FORMAT);
      setMessage("Character turnaround: formato impostato su 16:9.");
    }
  }

  async function preparePromptPlan(manageBusy = true) {
    if (manageBusy) setBusy("planner");
    setMessage("LLM sta preparando il prompt per il motore selezionato...");
    try {
      const plannerMode = mode === "edit" ? "image_edit" : mode === "anima" ? "image_anima" : "image_generate";
      const response = await fetch(`${bridgeUrl}/api/prompt-planner`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: plannerMode,
          request: plannerIdea,
          composition: compositionPreset,
          references: mode === "edit" ? references.map((reference) => ({ name: reference.name, role: reference.role })) : [],
        }),
      });
      const payload = await response.json() as { plan?: PromptPlan; error?: string };
      if (!response.ok || !payload.plan) throw new Error(payload.error ?? "Prompt Compiler non disponibile");
      setPrompt(payload.plan.prompt);
      setPlannerSummary(payload.plan.summary);
      setPlannerReady(true);
      setMessage(`${payload.plan.summary} Il modello LLM è stato scaricato; il prompt resta modificabile.`);
      return payload.plan;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Prompt Compiler fallito");
      throw error;
    } finally {
      if (manageBusy) setBusy(null);
    }
  }

  async function run() {
    const sourceRequest = plannerEnabled ? plannerIdea.trim() : prompt.trim();
    if (!projectId || !sourceRequest) { setMessage(!projectId ? "Seleziona un progetto." : "Descrivi l'immagine."); return; }
    if (plannerEnabled && !plannerStatus?.ready) { setMessage("Prompt Compiler non disponibile: configura il modello LLM oppure usa Manuale."); return; }
    if (turnaroundFormatMismatch) {
      setMessage("Character turnaround richiede il formato 16:9. Ripristinalo prima di generare.");
      return;
    }
    if (!selectedEngineReady) { setMessage(engineStatusError ?? "Il motore immagini selezionato non è pronto: controlla Admin → Dipendenze."); return; }
    if (mode === "edit" && !references.length) { setMessage("Edit richiede almeno una reference."); return; }
    if (keepAspectUnavailable) { setMessage("Mantieni proporzioni richiede che la prima reference abbia dimensioni leggibili."); return; }
    const numericSeed = Number(seedValue);
    if (seedMode !== "random" && (!Number.isSafeInteger(numericSeed) || numericSeed < 0)) { setMessage("Seed non valido."); return; }
    setBusy("run"); setMessage("Invio al motore immagini…");
    try {
      let enginePrompt = prompt.trim();
      if (plannerEnabled && !plannerReady) enginePrompt = (await preparePromptPlan(false)).prompt;
      const engineEffectivePrompt = composeImagePrompt(enginePrompt, compositionPreset);
      const response = await fetch(`${bridgeUrl}/api/image-jobs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, mode, engine: engineChoice, prompt: enginePrompt, effectivePrompt: engineEffectivePrompt, compositionPreset, candidateCount, aspectFormat: selectedFormat.value, width: selectedFormat.width, height: selectedFormat.height, h3Steps, h3Megapixels, seedMode, seed: seedMode === "random" ? undefined : numericSeed, references: mode === "edit" ? references.map((reference) => ({ file: reference.file, name: reference.name, width: reference.width, height: reference.height, role: reference.role })) : [], tag }),
      });
      const payload = (await response.json()) as { job?: ImageJob; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setJob(payload.job); setJobs((current) => [payload.job!, ...current.filter((item) => item.id !== payload.job!.id)]);
      setActiveJobId(active(payload.job) ? payload.job.id : null); setMessage(`Batch ${payload.job.id.slice(0, 8)} avviato`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Generazione non avviata"); }
    finally { setBusy(null); }
  }

  async function refresh(jobId: string) {
    const response = await fetch(`${bridgeUrl}/api/image-jobs/${jobId}`, { cache: "no-store" });
    const payload = (await response.json()) as { job?: ImageJob; error?: string };
    if (!response.ok || !payload.job) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
    setJob(payload.job); setJobs((current) => [payload.job!, ...current.filter((item) => item.id !== payload.job!.id)]);
  }

  async function regenerate(promptOverride: string) {
    if (!job || active(job)) return;
    const candidateIndex = regenerateTarget?.candidateIndex;
    const key = candidateIndex === undefined ? "regenerate-batch" : `regenerate-${candidateIndex}`;
    setBusy(key);
    setMessage(candidateIndex === undefined ? "Rigenerazione batch con nuovi seed…" : `Rigenerazione candidato ${candidateIndex} con un nuovo seed…`);
    try {
      const response = await fetch(`${bridgeUrl}/api/image-jobs/${job.id}/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(candidateIndex === undefined ? {} : { candidateIndex }),
          prompt: promptOverride,
        }),
      });
      const payload = (await response.json()) as { job?: ImageJob; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      setJob(payload.job);
      setJobs((current) => [payload.job!, ...current.filter((item) => item.id !== payload.job!.id)]);
      setCandidateCount(payload.job.candidateCount);
      setActiveJobId(payload.job.id);
      setPrompt(payload.job.prompt);
      setRegenerateTarget(null);
      setMessage(candidateIndex === undefined
        ? `Nuovo batch ${payload.job.id.slice(0, 8)} avviato`
        : `Nuova variante ${payload.job.id.slice(0, 8)} avviata`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rigenerazione non avviata");
    } finally {
      setBusy(null);
    }
  }

  async function select(index: number) {
    if (!job) return; setBusy(`select-${index}`);
    try {
      const response = await fetch(`${bridgeUrl}/api/image-jobs/${job.id}/select`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidateIndex: index }) });
      const payload = (await response.json()) as { job?: ImageJob; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      if (payload.job) { setJob(payload.job); setJobs((current) => [payload.job!, ...current.filter((item) => item.id !== payload.job!.id)]); }
      else setJob({ ...job, selectedCandidateIndex: index });
      setMessage(`Candidato ${index} selezionato`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Selezione fallita"); }
    finally { setBusy(null); }
  }

  async function cancel() {
    if (!job) return; setBusy("cancel");
    try {
      const response = await fetch(`${bridgeUrl}/api/image-jobs/${job.id}/cancel`, { method: "POST" });
      const payload = (await response.json()) as { job?: ImageJob; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      if (payload.job) setJob(payload.job); setActiveJobId(null); setMessage("Interruzione richiesta");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Interruzione fallita"); }
    finally { setBusy(null); }
  }

  async function removeCandidate(index: number) {
    if (!job || !window.confirm("Eliminare definitivamente questa immagine anche dai progetti condivisi?")) return;
    setBusy(`delete-${index}`);
    try {
      const response = await fetch(`${bridgeUrl}/api/image-jobs/${job.id}/candidates/${index}/delete`, { method: "POST" });
      const payload = (await response.json()) as { job?: ImageJob | null; jobDeleted?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      if (payload.jobDeleted || !payload.job) { setJob(null); setActiveJobId(null); await loadJobs(); }
      else { setJob(payload.job); setJobs((current) => [payload.job!, ...current.filter((item) => item.id !== payload.job!.id)]); }
      setMessage("Immagine eliminata");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Eliminazione fallita"); }
    finally { setBusy(null); }
  }

  async function setProjectLink(index: number, targetId: string, targetTag: ImageTag) {
    if (!job || !targetId) return; setBusy(`link-${index}-${targetId}`);
    try {
      const response = await fetch(`${bridgeUrl}/api/image-jobs/${job.id}/candidates/${index}/projects/${targetId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tag: targetTag }) });
      const payload = (await response.json()) as { job?: ImageJob; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Bridge HTTP ${response.status}`);
      if (payload.job) { setJob(payload.job); setJobs((current) => [payload.job!, ...current.filter((item) => item.id !== payload.job!.id)]); } else await refresh(job.id);
      setMessage("Progetto e tag aggiornati");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Condivisione fallita"); }
    finally { setBusy(null); }
  }

  async function unsetProjectLink(index: number, targetId: string) {
    if (!job) return; setBusy(`unlink-${index}-${targetId}`);
    try {
      const response = await fetch(`${bridgeUrl}/api/image-jobs/${job.id}/candidates/${index}/projects/${targetId}`, { method: "DELETE" });
      const payload = (await response.json()) as { job?: ImageJob; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Bridge HTTP " + response.status);
      if (targetId === projectId) await loadJobs();
      else if (payload.job) {
        setJob(payload.job);
        setJobs((current) => [payload.job!, ...current.filter((item) => item.id !== payload.job!.id)]);
      } else await refresh(job.id);
      setMessage("Condivisione rimossa");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Rimozione fallita"); }
    finally { setBusy(null); }
  }

  function editCandidate(candidate: ImageCandidate) {
    if (!candidate.output) return;
    setMode("edit"); setEngineChoice("default"); setReferences([{ file: referenceFile(candidate.output), name: candidate.output.filename ?? `candidate_${candidate.index}.png`, width: candidate.output.width, height: candidate.output.height, mediaPath: candidate.output.mediaPath, role: "base", uid: crypto.randomUUID() }]);
    setExpanded(true); setMessage(`Candidato ${candidate.index} impostato come base`);
    window.requestAnimationFrame(() => composerRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }));
  }

  function addCandidateReference(candidate: ImageCandidate) {
    if (!candidate.output) return;
    if (references.length >= referenceLimit) { setMessage(`Hai già raggiunto il limite di ${referenceLimit} reference.`); return; }
    setMode("edit");
    setReferences((current) => [...current, {
      file: referenceFile(candidate.output!),
      name: candidate.output!.filename ?? `candidate_${candidate.index}.png`,
      width: candidate.output!.width,
      height: candidate.output!.height,
      mediaPath: candidate.output!.mediaPath,
      role: (current.length === 0 ? "base" : "other") as ReferenceRole,
      uid: crypto.randomUUID(),
    }].slice(0, referenceLimit));
    setExpanded(true);
    setMessage(`Candidato ${candidate.index} aggiunto alle reference`);
  }

  return (
    <>
      {jobs.length > 0 && (
        <section className="project-batches image-project-batches" aria-label="Batch immagini del progetto">
          <div>
            <span className="section-index">IMMAGINI DEL PROGETTO</span>
            <strong>{projectName ?? "Progetto"}</strong>
            <small>Generazioni ed edit restano insieme e possono essere condivisi.</small>
          </div>
          <div className="project-batch-strip image-batch-strip">
            {jobs.map((item) => {
              const preview = item.candidates.find((candidate) => candidate.index === item.selectedCandidateIndex)?.output ?? item.candidates.find((candidate) => candidate.output)?.output;
              return (
                <button
                  className={item.id === job?.id ? "active" : ""}
                  key={item.id}
                  onClick={() => {
                    setJob(item); setActiveJobId(active(item) ? item.id : null); setMode(item.mode); setEngineChoice(typeof item.engine === "object" && item.engine.kind === "minimax-h3-image" ? "minimax" : "default"); setPrompt(item.prompt); setPlannerIdea(item.prompt); setPlannerReady(true); setPlannerSummary("Prompt gia preparato per questo batch."); setCompositionPreset(item.compositionPreset ?? "free"); setCandidateCount(item.candidateCount); if (typeof item.engine === "object" && item.engine.kind === "minimax-h3-image") { setH3Steps(h3StepsFromEngine(item.engine)); setH3Megapixels(h3MegapixelsFromJob(item)); }
                    setFormat((item.aspectFormat === IMAGE_EDIT_KEEP_ASPECT_FORMAT || formats.some((candidate) => candidate.value === item.aspectFormat) ? item.aspectFormat : "1:1") as ImageFormatValue);
                    setSeedMode(item.seedMode);
                    setSeedValue(item.requestedSeed === null || item.requestedSeed === undefined ? "1024" : String(item.requestedSeed));
                    setReferences(item.mode === "edit"
                      ? item.references.map((reference) => ({
                          ...reference,
                          mediaPath: referenceMediaPath(reference.file),
                          uid: crypto.randomUUID(),
                        }))
                      : []);
                    const ownLink = item.projectLinks
                      .flatMap((link) => typeof link === "string" ? [] : [link])
                      .find((link) => link.projectId === projectId);
                    setTag(ownLink?.tag ?? "untagged");
                  }}
                  type="button"
                >
                  {preview ? <img alt="" src={mediaUrl(bridgeUrl, preview.mediaPath)} /> : <span>{item.status}</span>}
                  <i>{item.mode === "edit" ? "EDIT · " : item.mode === "anima" ? "ANIMA · " : ""}{item.id.slice(0, 8)}</i>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="results image-results" aria-labelledby="image-results-title">
        <div className="results-heading">
          <div><span className="section-index">01</span><h2 id="image-results-title">Candidati immagine</h2><span className="result-count">{visibleCandidates.length}</span></div>
          <div className="results-tools">
            {job && !active(job) && <button className="regenerate-button" disabled={busy === "regenerate-batch"} onClick={() => setRegenerateTarget({})} type="button">{busy === "regenerate-batch" ? "Rigenerazione…" : `↻ Rigenera batch (${job.candidateCount})`}</button>}
            <div className="queue-status"><span className={active(job) ? "pulse" : ""} />{active(job) ? "Coda attiva" : "Coda pronta"}</div>
            {active(job) && job && <button className="stop-run-button" disabled={busy === "cancel"} onClick={() => void cancel()} type="button">{busy === "cancel" ? "Interruzione…" : "■ Interrompi"}</button>}
          </div>
        </div>

        <div className={`candidate-grid image-candidate-grid count-${Math.max(1, visibleCandidates.length)}`}>
          {visibleCandidates.map((candidate) => {
            const isReady = ready(candidate) && Boolean(candidate.output);
            const isFailed = failed(candidate);
            const chosen = job?.selectedCandidateIndex === candidate.index;
            const links = job ? linksFor(job, candidate.index) : [];
            const ownLink = links.find((link) => link.projectId === projectId);
            const shareKey = `${job?.id ?? "new"}-${candidate.index}`;
            const shareTarget = shareTargets[shareKey] ?? orderedProjects.find((project) => project.id !== projectId)?.id ?? projectId;
            return (
              <article className={`candidate-card image-candidate-card ${isReady ? "ready" : isFailed ? "failed" : "processing"} ${chosen ? "chosen" : ""}`} key={candidate.index}>
                <div className={`video-surface image-surface visual-${candidate.index}`} style={{ aspectRatio: `${job?.width ?? selectedFormat.width} / ${job?.height ?? selectedFormat.height}` }}>
                  {!isReady && <><div className="video-noise" /><div className="video-blur" /></>}
                  {isReady && candidate.output ? (
                    <>
                      <img alt={`Candidato ${candidate.index}`} src={mediaUrl(bridgeUrl, candidate.output.mediaPath)} />
                      {chosen && <div className="selected-label">Scelta</div>}
                      <div className="image-open-actions">
                        <a href={mediaUrl(bridgeUrl, candidate.output.mediaPath)} rel="noreferrer" target="_blank">Apri</a>
                        <a download={candidate.output.filename ?? true} href={downloadUrl(bridgeUrl, candidate.output.mediaPath)}>Scarica</a>
                      </div>
                    </>
                  ) : (
                    <div className="progress-overlay" role="status">
                      <span className="candidate-label">Candidato {candidate.index}</span>
                      <strong className={isFailed ? "failure-mark" : undefined}>{isFailed ? "!" : typeof candidate.progress === "number" ? `${candidate.progress}%` : "—"}</strong>
                      <span>{statusLabel(candidate)}</span>
                      {typeof candidate.progress === "number" && !isFailed && <div className="progress-track"><i style={{ width: `${Math.max(0, Math.min(100, candidate.progress))}%` }} /></div>}
                      {candidate.error && <small className="image-candidate-error">{candidate.error}</small>}
                    </div>
                  )}
                  {job && (isReady || isFailed) && <button aria-label={`Elimina candidato ${candidate.index}`} className="video-trash-button" disabled={busy === `delete-${candidate.index}`} onClick={() => void removeCandidate(candidate.index)} type="button">🗑</button>}
                </div>

                <footer className="candidate-footer image-candidate-footer">
                  <div className="image-candidate-meta"><div><strong>Candidato {candidate.index}</strong><span>{candidate.seed ? `Seed ${candidate.seed}` : "Seed al lancio"}</span></div>{job && <small>{engineLabel(job.engine)}</small>}</div>
                  {isReady && job && candidate.output ? (
                    <div className="image-card-actions">
                      <div className="image-tag-chips" aria-label="Tag nel progetto">
                        {tags.map((item) => <button className={(ownLink?.tag ?? job.tag ?? "untagged") === item.value ? "active" : ""} disabled={busy === `link-${candidate.index}-${projectId}`} key={item.value} onClick={() => void setProjectLink(candidate.index, projectId, item.value)} type="button">{item.label}</button>)}
                      </div>
                      <div className="image-primary-actions">
                        <button className="primary-action" onClick={() => onUseAsVideoReference({
                          file: referenceFile(candidate.output!),
                          name: candidate.output?.filename ?? `candidate_${candidate.index}.png`,
                          width: candidate.output?.width ?? job.width,
                          height: candidate.output?.height ?? job.height,
                          mediaPath: candidate.output!.mediaPath,
                          role: "base",
                        })} title="Invia al tab Video come reference" type="button">▶ Video</button>
                        <button onClick={() => editCandidate(candidate)} type="button">Edita questa</button>
                        <button disabled={references.length >= referenceLimit} onClick={() => addCandidateReference(candidate)} type="button">+ Reference</button>
                        <button className="regenerate-action" disabled={busy === `regenerate-${candidate.index}`} onClick={() => setRegenerateTarget({ candidateIndex: candidate.index })} type="button">{busy === `regenerate-${candidate.index}` ? "Rigenerazione…" : "↻ Rigenera"}</button>
                      </div>
                      <div className="image-share-row">
                        <select aria-label="Progetto di destinazione" onChange={(event) => setShareTargets((current) => ({ ...current, [shareKey]: event.target.value }))} value={shareTarget}>{orderedProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
                        <button disabled={!shareTarget || busy === `link-${candidate.index}-${shareTarget}`} onClick={() => void setProjectLink(candidate.index, shareTarget, ownLink?.tag ?? tag)} type="button">Condividi</button>
                        {links.some((link) => link.projectId === shareTarget) && shareTarget !== job.originProjectId && <button className="unlink" disabled={busy === `unlink-${candidate.index}-${shareTarget}`} onClick={() => void unsetProjectLink(candidate.index, shareTarget)} type="button">Rimuovi</button>}
                      </div>
                      {links.length > 0 && <small className="image-shared-projects">In: {links.map((link) => link.projectName ?? projects.find((project) => project.id === link.projectId)?.name ?? link.projectId.slice(0, 8)).join(" · ")}</small>}
                    </div>
                  ) : <span className="waiting-label">{statusLabel(candidate)}</span>}
                </footer>
              </article>
            );
          })}
        </div>
      </section>

      <section ref={composerRef} className={`composer image-composer ${expanded ? "expanded" : "collapsed"}`} aria-labelledby="image-composer-title">
        <div className="composer-heading">
          <div><span className="section-index">02</span><h2 id="image-composer-title">Crea immagini</h2></div>
          <div className="composer-heading-actions"><span className="autosave">Nel progetto {projectName ?? "corrente"}</span><button aria-expanded={expanded} className="composer-toggle" onClick={() => setExpanded((current) => !current)} type="button">{expanded ? "Riduci" : "Impostazioni"}<span aria-hidden="true">{expanded ? "⌄" : "⌃"}</span></button></div>
        </div>
        <div className="composer-body">
          <div className={`prompt-planner ${plannerEnabled ? "enabled" : ""}`}>
            <div><label><input checked={plannerEnabled} onChange={(event) => { setPlannerEnabled(event.target.checked); setPlannerReady(false); }} type="checkbox" /> Prompt Compiler AI</label><span>{plannerStatus?.ready ? "Scrivi in qualunque lingua: il modello LLM prepara il formato corretto e poi viene scaricato." : "Configura il modello LLM in Admin oppure usa la modalita manuale."}</span></div>
          </div>
          {plannerEnabled && <>
            <label className="prompt-field planner-request-field">
              <span>{mode === "edit" ? "Cosa vuoi modificare?" : mode === "anima" ? "Quale illustrazione vuoi creare?" : "Quale immagine vuoi creare?"}</span>
              <textarea onChange={(event) => { setPlannerIdea(event.target.value); setPlannerReady(false); }} placeholder="Scrivi liberamente in italiano o in un'altra lingua…" rows={4} value={plannerIdea} />
            </label>
            <button className="prompt-plan-button" disabled={busy === "planner" || !plannerIdea.trim() || !plannerStatus?.ready} onClick={() => void preparePromptPlan().catch(() => undefined)} type="button">{busy === "planner" ? "LLM sta preparando..." : "Prepara con LLM"}</button>
            {plannerReady && <div className="prompt-plan-summary"><strong>Prompt pronto e modificabile</strong><span>{plannerSummary}</span></div>}
          </>}
          {(!plannerEnabled || plannerReady) && <label className="prompt-field">
            <span>{plannerEnabled ? "Prompt tecnico inviato al motore" : mode === "edit" ? "Descrivi la modifica" : mode === "anima" ? "Descrivi l'illustrazione anime" : "Descrivi l'immagine"}</span>
            <textarea ref={promptRef} onChange={(event) => setPrompt(event.target.value)} placeholder={mode === "edit" ? "Mantieni il soggetto e cambia sfondo, luce, abito…" : mode === "anima" ? "Personaggio, posa, abiti, ambiente, inquadratura, luce e stile anime…" : "Soggetto, ambiente, inquadratura, luce e stile…"} rows={plannerEnabled ? 4 : 2} value={prompt} />
            <span className="prompt-hint">{mode === "edit" ? "Le reference vengono inviate a Flux Klein nell'ordine mostrato." : mode === "anima" ? "Usa il profilo Anima configurato in Admin e genera fino a quattro variazioni." : "Genera fino a quattro variazioni nello stesso batch."}</span>
          </label>}

          <fieldset className="image-composition-presets">
            <legend>Composizione</legend>
            <div className="image-composition-options">
              {IMAGE_COMPOSITION_PRESETS.map((preset) => (
                <button
                  aria-pressed={compositionPreset === preset.value}
                  className={compositionPreset === preset.value ? "selected" : ""}
                  key={preset.value}
                  onClick={() => selectCompositionPreset(preset.value)}
                  type="button"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <p><strong>{selectedComposition.label}</strong><span>{selectedComposition.description}</span></p>
            {compositionPreset === "character-turnaround" && (
              <div className="image-turnaround-guidance" id="image-turnaround-guidance" role="status">
                <strong>1 foglio = 4 viste complete</strong>
                <span>
                  {turnaroundFormatMismatch
                    ? "Il formato era stato impostato su 16:9 per il turnaround, ma è stato cambiato."
                    : "Formato impostato su 16:9 per il turnaround."}
                </span>
              </div>
            )}
            {turnaroundFormatMismatch && (
              <div className="image-turnaround-warning" id="image-turnaround-warning" role="alert">
                <div>
                  <strong>Formato incompatibile con il turnaround</strong>
                  <span>Per ottenere quattro viste complete, ripristina il foglio orizzontale 16:9.</span>
                </div>
                <button
                  onClick={() => {
                    setFormat(TURNAROUND_FORMAT);
                    setMessage("Formato 16:9 ripristinato per il character turnaround.");
                  }}
                  type="button"
                >
                  Ripristina 16:9
                </button>
              </div>
            )}
          </fieldset>

          <details className="image-effective-prompt">
            <summary>Prompt effettivo inviato al motore</summary>
            <p>{effectivePrompt || "Scrivi il prompt per vedere il testo effettivo."}</p>
          </details>

          <div className="image-control-grid">
            <fieldset className="segmented-control"><legend>Modalità</legend><div><button className={mode === "generate" ? "selected" : ""} onClick={() => { setMode("generate"); setEngineChoice("default"); setPlannerReady(false); if (format === IMAGE_EDIT_KEEP_ASPECT_FORMAT) setFormat("1:1"); }} type="button">Genera</button><button className={mode === "edit" ? "selected" : ""} onClick={() => { setMode("edit"); setEngineChoice("default"); setPlannerReady(false); if (!references.length) void openImageLibrary(); }} type="button">Edit</button><button className={mode === "anima" ? "selected" : ""} onClick={() => { setMode("anima"); setEngineChoice("default"); setPlannerReady(false); if (format === IMAGE_EDIT_KEEP_ASPECT_FORMAT) setFormat("1:1"); }} type="button">Anima</button></div></fieldset>
            {mode !== "anima" && <fieldset className="segmented-control image-engine-switch"><legend>Motore</legend><div><button className={engineChoice === "default" ? "selected" : ""} onClick={() => { setEngineChoice("default"); setReferences((current) => current.slice(0, 4)); setMessage(mode === "edit" ? "Flux Klein selezionato per Edit" : "Krea selezionato per la generazione"); }} type="button">{mode === "edit" ? "Flux Klein" : "Krea"}</button><button className={engineChoice === "minimax" ? "selected" : ""} onClick={() => { setEngineChoice("minimax"); setMessage(`Image H3 selezionato · ${mode === "edit" ? references.length === 1 ? "I2I" : references.length > 1 ? "Reference" : "allega almeno una immagine" : "T2I"}`); }} type="button">Image H3</button></div></fieldset>}
            <label className="select-control">
              <span>Formato</span>
              <select
                aria-describedby={compositionPreset === "character-turnaround" ? turnaroundFormatMismatch ? "image-turnaround-warning" : "image-turnaround-guidance" : undefined}
                aria-invalid={turnaroundFormatMismatch || undefined}
                onChange={(event) => setFormat(event.target.value as ImageFormatValue)}
                value={format}
              >
                {mode === "edit" && <option value={IMAGE_EDIT_KEEP_ASPECT_FORMAT}>Mantieni proporzioni · Reference 1</option>}
                {formats.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            {usingMiniMax && <fieldset className="segmented-control"><legend>Step Image H3</legend><div>{h3ImageStepOptions.map((value) => <button className={h3Steps === value ? "selected" : ""} key={value} onClick={() => setH3Steps(value)} type="button">{value}</button>)}</div></fieldset>}
            {usingMiniMax && <fieldset className="segmented-control"><legend>Risoluzione Image H3</legend><div>{h3ImageResolutionOptions.map((item) => <button className={h3Megapixels === item.value ? "selected" : ""} key={item.value} onClick={() => setH3Megapixels(item.value)} title={item.detail} type="button">{item.label}</button>)}</div></fieldset>}
            <fieldset className="segmented-control"><legend>Generazioni</legend><div>{[1, 2, 3, 4].map((value) => <button className={candidateCount === value ? "selected" : ""} key={value} onClick={() => setCandidateCount(value)} type="button">{value}</button>)}</div></fieldset>
            <fieldset className="segmented-control"><legend>Seed</legend><div>{(["random", "base", "fixed"] as SeedMode[]).map((value) => <button className={seedMode === value ? "selected" : ""} key={value} onClick={() => setSeedMode(value)} type="button">{value === "random" ? "Random" : value === "base" ? "Base +1" : "Bloccato"}</button>)}</div></fieldset>
            <label className="seed-input"><span>Valore seed</span><input disabled={seedMode === "random"} min="0" onChange={(event) => setSeedValue(event.target.value)} type="number" value={seedValue} /></label>
          </div>

          <fieldset className="image-initial-tags"><legend>Tag nel progetto</legend><div>{tags.map((item) => <button className={tag === item.value ? "selected" : ""} key={item.value} onClick={() => setTag(item.value)} type="button">{item.label}</button>)}</div><p>Il tag indica come riusare l’asset; non cambia il prompt.</p></fieldset>

          {mode === "edit" && (
            <div className="asset-panel image-reference-panel">
              <div className="asset-panel-heading"><div><strong>{usingMiniMax ? "Reference Image H3" : "Reference Flux Klein"}</strong><span>{usingMiniMax ? "1 immagine = I2I · 2–9 immagini = Reference" : "Da 1 a 4 immagini · ordine e ruolo modificabili"}</span></div><div className="asset-source-actions"><button onClick={() => void openImageLibrary()} type="button">▧ Scegli dalla libreria</button><label className="asset-upload">{uploading ? "Caricamento…" : `+ Carica (${references.length}/${referenceLimit})`}<input accept="image/*" disabled={uploading || references.length >= referenceLimit} multiple onChange={(event) => { void upload(event.currentTarget.files); event.currentTarget.value = ""; }} type="file" /></label></div></div>
              <div className="image-reference-list">
                {!references.length ? <span className="asset-empty">Carica una base e, se servono, soggetto, stile, posa o sfondo.</span> : references.map((reference, index) => (
                  <article key={reference.uid}>
                    <div className="image-reference-preview">{reference.mediaPath ? <img alt={reference.name ?? "Reference"} src={mediaUrl(bridgeUrl, reference.mediaPath)} /> : <span>{index + 1}</span>}<i>{index + 1}</i></div>
                    <div><strong>{reference.name ?? reference.file}</strong><small>{reference.width && reference.height ? `${reference.width} × ${reference.height}` : "Reference"}</small></div>
                    <label><span>Ruolo</span><select onChange={(event) => setReferences((current) => current.map((item) => item.uid === reference.uid ? { ...item, role: event.target.value as ReferenceRole } : item))} value={reference.role}>{roles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
                    <div className="image-reference-order"><button className="video-reference" onClick={() => onUseAsVideoReference({
                      file: reference.file,
                      name: reference.name,
                      width: reference.width,
                      height: reference.height,
                      mediaPath: reference.mediaPath,
                      role: "base",
                    })} title="Invia al tab Video come reference" type="button">▶ Video</button><button className="insert" onClick={() => insertReferenceInPrompt(index)} title={`Inserisci reference image ${index + 1} nel prompt`} type="button">Inserisci</button><button disabled={index === 0} onClick={() => moveReference(index, -1)} title="Sposta prima" type="button">←</button><button disabled={index === references.length - 1} onClick={() => moveReference(index, 1)} title="Sposta dopo" type="button">→</button><button className="remove" onClick={() => setReferences((current) => current.filter((item) => item.uid !== reference.uid))} title="Rimuovi" type="button">×</button></div>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>

        {libraryOpen && typeof document !== "undefined" && createPortal((
          <div
            className="media-picker-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setLibraryOpen(false);
            }}
            role="presentation"
          >
            <div aria-modal="true" className="media-library-picker media-library-modal image-library-modal" role="dialog">
              <div className="media-picker-heading">
                <div><strong>Scegli immagini dalla libreria</strong><span>Tutte le immagini generate e gli asset storici · massimo {referenceLimit} reference</span></div>
                <button aria-label="Chiudi libreria" onClick={() => setLibraryOpen(false)} type="button">×</button>
              </div>
              {libraryBusy && !libraryImages.length ? (
                <span className="media-picker-empty">Caricamento…</span>
              ) : (
                <div className="media-picker-section">
                  <div className="media-picker-grid image-edit-library-grid">
                    {libraryImages.map((image) => {
                      const selected = references.some((reference) => reference.file.toLowerCase() === image.file.toLowerCase());
                      return (
                        <button
                          className={selected ? "selected" : ""}
                          disabled={!selected && references.length >= referenceLimit}
                          key={image.id}
                          onClick={() => addLibraryReference(image)}
                          title={image.detail}
                          type="button"
                        >
                          <div><img alt="" src={mediaUrl(bridgeUrl, image.mediaPath)} /></div>
                          <strong>{image.name}</strong>
                          <small>{selected ? "✓ Allegata" : image.width && image.height ? `${image.width} × ${image.height}` : "Immagine"}</small>
                        </button>
                      );
                    })}
                    {!libraryImages.length && <span className="media-picker-empty">Nessuna immagine disponibile</span>}
                  </div>
                </div>
              )}
              <div className="media-picker-footer">
                <span>{references.length}/{referenceLimit} reference allegate</span>
                <button onClick={() => setLibraryOpen(false)} type="button">Fine</button>
              </div>
            </div>
          </div>
        ), document.body)}

        <div className="composer-footer">
          <div className={selectedEngineReady ? "image-engine-state ready" : "image-engine-state blocked"}>
            {selectedEngineReady ? "Motore immagini pronto" : engineStatusError ?? "Dipendenze motore mancanti"}
          </div>
          <div className="preset-note"><span className="fast-badge">{usingMiniMax ? `IMAGE H3 · ${miniMaxImageMode} · ${h3Steps} STEP` : mode === "edit" ? "FLUX KLEIN EDIT" : mode === "anima" ? "ANIMA" : "KREA"}</span>{keepAspectUnavailable ? "Reference 1 senza dimensioni" : `${selectedFormat.width} × ${selectedFormat.height} · ${(selectedFormat.width * selectedFormat.height / (1024 * 1024)).toFixed(2)} MP`} · {selectedComposition.shortLabel}</div>
          <div className="generation-cta"><div><span>Output</span><strong>{candidateCount} immagin{candidateCount === 1 ? "e" : "i"} · {tag === "untagged" ? "senza tag" : tags.find((item) => item.value === tag)?.label}</strong></div><button disabled={busy === "run" || busy === "planner" || active(job) || !projectId || !selectedEngineReady || turnaroundFormatMismatch || keepAspectUnavailable || (plannerEnabled && (!plannerStatus?.ready || !plannerIdea.trim()))} onClick={() => void run()} type="button">{busy === "planner" ? "LLM prepara..." : busy === "run" || active(job) ? "Generazione in corso" : turnaroundFormatMismatch ? "Formato 16:9 richiesto" : keepAspectUnavailable ? "Dimensioni reference mancanti" : !selectedEngineReady ? "Motore non pronto" : mode === "edit" ? "Crea " + candidateCount + " edit" : mode === "anima" ? "Genera " + candidateCount + " anime" : "Genera " + candidateCount + " immagini"}</button></div>
        </div>
        {message && <div className="run-message">{message}</div>}
      </section>
      {job && regenerateTarget && <RegenerateDialog
        busy={busy?.startsWith("regenerate-") === true}
        initialPrompt={job.prompt}
        key={`${job.id}:${regenerateTarget.candidateIndex ?? "batch"}`}
        mediaLabel={regenerateTarget.candidateIndex === undefined ? "batch immagini" : `immagine ${regenerateTarget.candidateIndex}`}
        onCancel={() => { if (!busy?.startsWith("regenerate-")) setRegenerateTarget(null); }}
        onConfirm={regenerate}
        scopeLabel={regenerateTarget.candidateIndex === undefined ? `${job.candidateCount} candidati` : `Candidato ${regenerateTarget.candidateIndex}`}
      />}
    </>
  );
}
