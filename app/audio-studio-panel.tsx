"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type AudioKind = "tts" | "music" | "speech_music" | "voice_cover";
type AudioJob = {
  id: string;
  projectId: string;
  projectName?: string | null;
  kind: AudioKind;
  status: string;
  prompt: string;
  lyrics: string;
  voice: string;
  referenceFile?: string | null;
  durationSeconds?: number | null;
  seed: number;
  progress?: number | null;
  phaseLabel: string;
  output?: { mediaPath: string; filename: string; format: string } | null;
  error?: string | null;
  processingSeconds?: number | null;
  settings?: Record<string, unknown>;
  createdAt: string;
};

type Capabilities = {
  tts: { ready: boolean; root: string; voices: string[]; defaultVoice: string; unloadPolicy: string; plannerReady?: boolean; plannerModel?: string; transcriptionReady?: boolean; transcriptionModel?: string; transcriptionUnloadPolicy?: string };
  music: { ready: boolean; model: string; encoder: string; vae: string; steps: number; cfg: number; plannerReady?: boolean; plannerModel?: string };
  voiceConversion: { ready: boolean; root: string; backend: "cuda" | "cpu"; steps: number; unloadPolicy: string; separatorModel: string; seedVcModel: string };
};

type MusicPlan = { caption: string; lyrics: string; instrumental: boolean; summary: string };

type ExternalAudio = {
  id: string;
  kind: "picture" | "video" | "audio";
  file: string;
  name: string;
  originalName: string;
  mediaPath: string;
  originProjectName?: string | null;
};

type Props = {
  bridgeUrl: string;
  projectId: string;
  projectName?: string | null;
  initialJobId?: string | null;
};

const runningStates = new Set(["prepared", "queued", "loading", "running", "finalizing"]);

function fullUrl(bridgeUrl: string, mediaPath: string) {
  return /^https?:\/\//i.test(mediaPath) ? mediaPath : `${bridgeUrl}${mediaPath}`;
}

function elapsed(seconds?: number | null) {
  if (seconds == null) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export default function AudioStudioPanel({ bridgeUrl, projectId, projectName, initialJobId = null }: Props) {
  const [kind, setKind] = useState<AudioKind>("tts");
  const [ttsText, setTtsText] = useState("");
  const [ttsIdea, setTtsIdea] = useState("");
  const [ttsPlanner, setTtsPlanner] = useState(true);
  const [ttsPlanReady, setTtsPlanReady] = useState(false);
  const [ttsPlanSummary, setTtsPlanSummary] = useState("");
  const [voice, setVoice] = useState("");
  const [cloneEnabled, setCloneEnabled] = useState(false);
  const [reference, setReference] = useState<ExternalAudio | null>(null);
  const [referenceText, setReferenceText] = useState("");
  const [caption, setCaption] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [musicIdea, setMusicIdea] = useState("");
  const [musicPlanner, setMusicPlanner] = useState(true);
  const [musicPlanReady, setMusicPlanReady] = useState(false);
  const [musicPlanSummary, setMusicPlanSummary] = useState("");
  const [instrumental, setInstrumental] = useState(true);
  const [speechIdea, setSpeechIdea] = useState("");
  const [speechPlanner, setSpeechPlanner] = useState(true);
  const [speechPlanReady, setSpeechPlanReady] = useState(false);
  const [speechPlanSummary, setSpeechPlanSummary] = useState("");
  const [voiceGain, setVoiceGain] = useState(1);
  const [musicGain, setMusicGain] = useState(0.55);
  const [ducking, setDucking] = useState(0.7);
  const [duration, setDuration] = useState(30);
  const [fixedSeed, setFixedSeed] = useState(false);
  const [seed, setSeed] = useState(1024);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [jobs, setJobs] = useState<AudioJob[]>([]);
  const [library, setLibrary] = useState<ExternalAudio[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const hasActiveJob = useMemo(() => jobs.some((job) => runningStates.has(job.status)), [jobs]);
  const activeJob = useMemo(() => jobs.find((job) => runningStates.has(job.status)) ?? null, [jobs]);
  const latestJob = jobs[0] ?? null;
  const selectedReady = kind === "tts"
    ? capabilities?.tts.ready
    : kind === "voice_cover"
      ? capabilities?.music.ready && capabilities?.voiceConversion.ready
      : capabilities?.music.ready;

  function displayedKind(job: AudioJob): AudioKind {
    return job.settings?.mode === "speech_music"
      ? "speech_music"
      : job.settings?.mode === "voice_cover"
        ? "voice_cover"
        : job.kind;
  }

  async function load(preferId?: string | null) {
    const [capResponse, jobsResponse, libraryResponse] = await Promise.all([
      fetch(`${bridgeUrl}/api/audio-jobs/capabilities`, { cache: "no-store" }),
      fetch(`${bridgeUrl}/api/audio-jobs?${new URLSearchParams({ projectId, limit: "100" })}`, { cache: "no-store" }),
      fetch(`${bridgeUrl}/api/external-media`, { cache: "no-store" }),
    ]);
    const capPayload = await capResponse.json() as { audioStudio?: Capabilities; error?: string };
    const jobsPayload = await jobsResponse.json() as { jobs?: AudioJob[]; error?: string };
    const libraryPayload = await libraryResponse.json() as { assets?: ExternalAudio[]; error?: string };
    if (!capResponse.ok || !capPayload.audioStudio) throw new Error(capPayload.error ?? "Motori audio non disponibili");
    if (!jobsResponse.ok) throw new Error(jobsPayload.error ?? "Job audio non disponibili");
    setCapabilities(capPayload.audioStudio);
    setVoice((current) => current || capPayload.audioStudio!.tts.defaultVoice || capPayload.audioStudio!.tts.voices[0] || "default");
    const loaded = jobsPayload.jobs ?? [];
    const preferred = preferId ? loaded.find((job) => job.id === preferId) : null;
    setJobs(preferred ? [preferred, ...loaded.filter((job) => job.id !== preferred.id)] : loaded);
    if (preferred) {
      setKind(displayedKind(preferred));
      if (displayedKind(preferred) === "voice_cover") setInstrumental(false);
      setMessage(`Job ${preferred.id.slice(0, 8)} aperto dalla Chat`);
    }
    if (libraryResponse.ok) setLibrary((libraryPayload.assets ?? []).filter((asset) => asset.kind === "audio"));
  }

  useEffect(() => {
    if (!projectId) return;
    // This effect synchronizes the panel with the remote bridge state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(initialJobId).catch((error) => setMessage(error instanceof Error ? error.message : "Audio non disponibile"));
  }, [bridgeUrl, initialJobId, projectId]);

  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = window.setInterval(() => void load().catch(() => undefined), 2_000);
    return () => window.clearInterval(timer);
  }, [bridgeUrl, hasActiveJob, projectId]);

  async function openLibrary() {
    setLibraryOpen(true);
    setLibraryBusy(true);
    try {
      const response = await fetch(`${bridgeUrl}/api/external-media`, { cache: "no-store" });
      const payload = await response.json() as { assets?: ExternalAudio[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Libreria non disponibile");
      setLibrary((payload.assets ?? []).filter((asset) => asset.kind === "audio"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Libreria non disponibile");
    } finally {
      setLibraryBusy(false);
    }
  }

  async function uploadReference(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy("upload");
    try {
      const body = new FormData();
      body.append("file", file, file.name);
      const response = await fetch(`${bridgeUrl}/api/assets/upload?${new URLSearchParams({ projectId })}`, { method: "POST", body });
      const payload = await response.json() as { asset?: ExternalAudio; error?: string };
      if (!response.ok || !payload.asset) throw new Error(payload.error ?? "Upload audio fallito");
      if (payload.asset.kind !== "audio") throw new Error("Il file scelto non è audio");
      setReference(payload.asset);
      setReferenceText("");
      if (kind === "tts") setCloneEnabled(true);
      if (kind === "voice_cover") {
        setMessage("Reference timbrica pronta. Per il canto Seed-VC non richiede la trascrizione.");
      } else await transcribeReference(payload.asset, false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload audio fallito");
    } finally {
      setBusy(null);
    }
  }
  async function transcribeReference(asset: ExternalAudio, manageBusy = true) {
    if (manageBusy) setBusy("transcribe");
    setMessage("Whisper sta trascrivendo automaticamente il campione; il processo verra scaricato prima di Higgs...");
    try {
      const response = await fetch(`${bridgeUrl}/api/audio-jobs/transcribe-reference`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: asset.file }),
      });
      const payload = await response.json() as { transcription?: { text: string; model: string; unloadPolicy: string }; error?: string };
      if (!response.ok || !payload.transcription) throw new Error(payload.error ?? "Trascrizione automatica non disponibile");
      setReferenceText(payload.transcription.text);
      setMessage(`Campione trascritto con ${payload.transcription.model}; modello ASR scaricato dalla VRAM. Puoi correggere il testo.`);
    } catch (error) {
      setMessage(`${error instanceof Error ? error.message : "Trascrizione automatica fallita"}. Puoi inserire il testo manualmente o usare comunque il campione.`);
    } finally {
      if (manageBusy) setBusy(null);
    }
  }


  async function prepareTtsPlan(manageBusy = true) {
    if (manageBusy) setBusy("tts-planner");
    setMessage("LLM sta preparando testo, lingua e prosodia per Higgs...");
    try {
      const response = await fetch(`${bridgeUrl}/api/prompt-planner`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "tts", request: ttsIdea }),
      });
      const payload = await response.json() as { plan?: { prompt: string; summary: string; language: string }; error?: string };
      if (!response.ok || !payload.plan) throw new Error(payload.error ?? "Planner TTS non disponibile");
      setTtsText(payload.plan.prompt);
      setTtsPlanSummary(`${payload.plan.summary} Lingua: ${payload.plan.language}.`);
      setTtsPlanReady(true);
      setMessage(`${payload.plan.summary} Il modello LLM è stato scaricato; il testo resta modificabile.`);
      return payload.plan;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Planner TTS fallito");
      throw error;
    } finally {
      if (manageBusy) setBusy(null);
    }
  }

  async function prepareMusicPlan(manageBusy = true) {
    if (manageBusy) setBusy("planner");
    setMessage("LLM sta trasformando la tua idea in un piano musicale...");
    try {
      const response = await fetch(`${bridgeUrl}/api/audio-jobs/music-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea: musicIdea, instrumental: kind === "voice_cover" ? false : instrumental, durationSeconds: duration, lyrics }),
      });
      const payload = await response.json() as { plan?: MusicPlan; error?: string };
      if (!response.ok || !payload.plan) throw new Error(payload.error ?? "Music Planner non disponibile");
      setCaption(payload.plan.caption);
      setLyrics(payload.plan.lyrics);
      setMusicPlanSummary(payload.plan.summary);
      setMusicPlanReady(true);
      setMessage(`${payload.plan.summary} Il modello LLM è stato scaricato; puoi modificare il piano o generare.`);
      return payload.plan;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Music Planner fallito");
      throw error;
    } finally {
      if (manageBusy) setBusy(null);
    }
  }

  async function prepareSpeechPlan(manageBusy = true) {
    if (!reference) throw new Error("Scegli o carica prima il parlato sorgente");
    if (manageBusy) setBusy("speech-planner");
    setMessage("LLM sta progettando una base strumentale intorno al parlato…");
    try {
      const response = await fetch(`${bridgeUrl}/api/audio-jobs/speech-track-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idea: speechIdea,
          referenceFile: reference.file,
          referenceText,
          durationSeconds: duration,
        }),
      });
      const payload = await response.json() as { plan?: MusicPlan; error?: string };
      if (!response.ok || !payload.plan) {
        throw new Error(payload.error ?? "Planner Parlato → brano non disponibile");
      }
      setCaption(payload.plan.caption);
      setSpeechPlanSummary(payload.plan.summary);
      setSpeechPlanReady(true);
      setMessage(`${payload.plan.summary} La base resta modificabile prima del mix.`);
      return payload.plan;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Planner Parlato → brano fallito");
      throw error;
    } finally {
      if (manageBusy) setBusy(null);
    }
  }

  async function run() {
    setBusy("run");
    setMessage(null);
    try {
      let effectiveTtsText = ttsText;
      let effectiveCaption = caption;
      let effectiveLyrics = kind === "voice_cover" ? lyrics : instrumental ? "" : lyrics;
      if (kind === "tts" && ttsPlanner && !ttsPlanReady) {
        effectiveTtsText = (await prepareTtsPlan(false)).prompt;
      }
      if ((kind === "music" || kind === "voice_cover") && musicPlanner && !musicPlanReady) {
        const plan = await prepareMusicPlan(false);
        effectiveCaption = plan.caption;
        effectiveLyrics = plan.lyrics;
      }
      if (kind === "speech_music" && speechPlanner && !speechPlanReady) {
        effectiveCaption = (await prepareSpeechPlan(false)).caption;
      }
      const body = kind === "tts"
        ? {
            kind, projectId, text: effectiveTtsText, voice,
            seed: fixedSeed ? seed : undefined,
            referenceFile: cloneEnabled ? reference?.file : undefined,
            referenceText: cloneEnabled ? referenceText : undefined,
          }
        : kind === "speech_music"
          ? {
              kind,
              projectId,
              caption: effectiveCaption,
              referenceFile: reference?.file,
              referenceText,
              voiceGain,
              musicGain,
              ducking,
              seed: fixedSeed ? seed : undefined,
            }
          : kind === "voice_cover"
            ? {
                kind,
                projectId,
                caption: effectiveCaption,
                lyrics: effectiveLyrics,
                durationSeconds: duration,
                referenceFile: reference?.file,
                referenceText,
                seed: fixedSeed ? seed : undefined,
              }
          : {
            kind, projectId, caption: effectiveCaption, lyrics: effectiveLyrics,
            durationSeconds: duration, seed: fixedSeed ? seed : undefined,
          };
      const response = await fetch(`${bridgeUrl}/api/audio-jobs`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const payload = await response.json() as { job?: AudioJob; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error ?? "Job audio non avviato");
      setJobs((current) => [payload.job!, ...current.filter((job) => job.id !== payload.job!.id)]);
      setMessage(
        kind === "tts"
          ? "Higgs in caricamento; verrà scaricato automaticamente a fine job."
          : kind === "speech_music"
            ? "Base inviata a MiniMax Music; al termine verrà mixata col parlato originale."
            : kind === "voice_cover"
              ? "MiniMax sta creando il canto sorgente; seguiranno separazione, Seed-VC e remix automatici."
            : "MiniMax Music inviato a ComfyUI.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Job audio fallito");
    } finally {
      setBusy(null);
    }
  }

  async function stop(job: AudioJob) {
    setBusy(`stop-${job.id}`);
    try {
      const response = await fetch(`${bridgeUrl}/api/audio-jobs/${job.id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = await response.json() as { job?: AudioJob; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error ?? "Stop fallito");
      setJobs((current) => current.map((item) => item.id === job.id ? payload.job! : item));
      setMessage(job.kind === "tts" ? "TTS interrotto e processo Higgs scaricato." : "Generazione musica interrotta.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Stop fallito");
    } finally {
      setBusy(null);
    }
  }

  async function remove(job: AudioJob) {
    if (!window.confirm("Eliminare questo job audio anche dalla Libreria?")) return;
    const response = await fetch(`${bridgeUrl}/api/audio-jobs/${job.id}`, { method: "DELETE" });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { setMessage(payload.error ?? "Eliminazione fallita"); return; }
    setJobs((current) => current.filter((item) => item.id !== job.id));
  }

  return (
    <div className="audio-studio">
      <section className="audio-candidates" aria-label="Output audio del progetto">
        <div className="audio-section-heading">
          <div><span className="section-index">01</span><h2>Audio del progetto</h2><b>{jobs.length}</b></div>
          <span>{hasActiveJob ? "Generazione in corso" : "Coda pronta"}</span>
        </div>
        <div className="audio-job-row">
          {jobs.length === 0 && <div className="audio-empty">Le voci e le musiche generate appariranno qui e nella Libreria.</div>}
          {jobs.map((job) => (
            <article className={`audio-job-card ${job.status}`} key={job.id}>
              <div className="audio-card-top">
                <span className="fast-badge">{job.kind === "tts" ? "HIGGS TTS" : displayedKind(job) === "speech_music" ? "PARLATO + MUSICA" : displayedKind(job) === "voice_cover" ? "H3 + SEED-VC" : "H3 MUSIC"}</span>
                <span>{job.phaseLabel}</span>
                <button aria-label="Elimina audio" disabled={runningStates.has(job.status)} onClick={() => void remove(job)} type="button">⌫</button>
              </div>
              {runningStates.has(job.status) && (
                <div className="audio-progress"><i style={{ width: `${job.progress ?? 22}%` }} /><span>{job.progress == null ? "…" : `${Math.round(job.progress)}%`}</span></div>
              )}
              {job.output ? (
                <audio controls preload="metadata" src={fullUrl(bridgeUrl, job.output.mediaPath)} />
              ) : (
                <div className="audio-wave-placeholder"><i /><i /><i /><i /><i /><i /><i /></div>
              )}
              <p>{job.prompt}</p>
              <footer>
                <span>seed {job.seed}{job.processingSeconds != null ? ` · ${elapsed(job.processingSeconds)}` : ""}</span>
                <div>
                  {runningStates.has(job.status) && <button className="danger" disabled={busy === `stop-${job.id}`} onClick={() => void stop(job)} type="button">■ Interrompi</button>}
                  {job.output && <a download href={`${fullUrl(bridgeUrl, job.output.mediaPath)}&download=1`}>Scarica</a>}
                </div>
              </footer>
              {job.error && <strong className="audio-error">{job.error}</strong>}
            </article>
          ))}
        </div>
      </section>

      <section className="composer audio-composer">
        <div className="composer-heading">
          <div><span className="section-index">02</span><h2>Crea audio</h2></div>
          <span className="autosave">Nel progetto {projectName ?? "corrente"}</span>
        </div>
        <div className="audio-kind-tabs">
          <button className={kind === "tts" ? "selected" : ""} onClick={() => setKind("tts")} type="button">Voce / TTS</button>
          <button className={kind === "music" ? "selected" : ""} onClick={() => setKind("music")} type="button">Musica H3</button>
          <button className={kind === "speech_music" ? "selected" : ""} onClick={() => setKind("speech_music")} type="button">Parlato → brano</button>
          <button className={kind === "voice_cover" ? "selected" : ""} onClick={() => { setKind("voice_cover"); setInstrumental(false); setMusicPlanReady(false); }} type="button">Canzone col mio timbro</button>
        </div>

        {(busy || activeJob || latestJob) && (() => {
          const localLabels: Record<string, string> = {
            upload: "Caricamento del campione audio",
            transcribe: "Trascrizione del campione con Whisper",
            "tts-planner": "LLM sta preparando il TTS",
            planner: "LLM sta preparando la musica",
            "speech-planner": "LLM sta preparando la base per il parlato",
            run: kind === "tts" ? "Avvio della generazione TTS" : kind === "speech_music" ? "Avvio di Parlato → brano" : kind === "voice_cover" ? "Avvio canto e conversione timbrica" : "Avvio della generazione musicale",
          };
          const displayJob = activeJob ?? latestJob;
          const isWorking = Boolean(busy || activeJob);
          const isFailed = !isWorking && Boolean(displayJob && ["failed", "cancelled"].includes(displayJob.status));
          const title = busy ? (localLabels[busy] ?? "Operazione audio in corso") : activeJob ? `${activeJob.kind === "tts" ? "Voce TTS" : displayedKind(activeJob) === "speech_music" ? "Parlato → brano" : displayedKind(activeJob) === "voice_cover" ? "Canzone col mio timbro" : "Musica H3"} in generazione` : isFailed ? "Ultima generazione non riuscita" : "Audio pronto";
          const detail = busy ? (message ?? "Preparazione in corso...") : activeJob ? activeJob.phaseLabel : isFailed ? (displayJob?.error ?? "Il job e stato interrotto o non e riuscito.") : "L'asset e disponibile qui e nella Libreria del progetto.";
          return (
            <div aria-live="polite" className={`audio-live-status ${isWorking ? "running" : isFailed ? "failed" : "ready"}`} role="status">
              <div className="audio-live-copy">
                <span className={isWorking ? "audio-live-spinner" : "audio-live-icon"}>{isWorking ? "" : isFailed ? "!" : "OK"}</span>
                <div><strong>{title}</strong><span>{detail}</span></div>
              </div>
              {activeJob && <div className="audio-live-progress"><i style={{ width: `${activeJob.progress ?? 8}%` }} /><span>{activeJob.progress == null ? "..." : `${Math.round(activeJob.progress)}%`}</span></div>}
              {!isWorking && displayJob?.output && <audio controls preload="metadata" src={fullUrl(bridgeUrl, displayJob.output.mediaPath)} />}
              {activeJob && <button className="danger" disabled={busy === `stop-${activeJob.id}`} onClick={() => void stop(activeJob)} type="button">■ Interrompi</button>}
            </div>
          );
        })()}

        {kind === "tts" ? (
          <div className="audio-form">
            <div className={`prompt-planner ${ttsPlanner ? "enabled" : ""}`}>
              <div><label><input checked={ttsPlanner} onChange={(event) => { setTtsPlanner(event.target.checked); setTtsPlanReady(false); }} type="checkbox" /> TTS Planner AI</label><span>{capabilities?.tts.plannerReady ? "Scrivi naturalmente in qualunque lingua: il modello LLM separa testo e regia vocale, poi viene scaricato." : "Planner non disponibile: configura il modello LLM in Admin oppure usa l'input manuale."}</span></div>
            </div>
            {ttsPlanner && <>
              <label className="audio-main-field planner-request-field"><span>Cosa deve dire e come?</span><textarea onChange={(event) => { setTtsIdea(event.target.value); setTtsPlanReady(false); }} placeholder="Esempio: in italiano, con tono rassicurante e una breve pausa dopo il saluto, di': Buongiorno e benvenuti..." rows={5} value={ttsIdea} /></label>
              <button className="prompt-plan-button" disabled={busy === "tts-planner" || !ttsIdea.trim() || !capabilities?.tts.plannerReady} onClick={() => void prepareTtsPlan().catch(() => undefined)} type="button">{busy === "tts-planner" ? "LLM sta preparando..." : "Prepara con LLM"}</button>
              {ttsPlanReady && <div className="prompt-plan-summary"><strong>Copione Higgs modificabile</strong><span>{ttsPlanSummary}</span><label className="audio-main-field"><span>Testo finale da pronunciare</span><textarea onChange={(event) => setTtsText(event.target.value)} rows={6} value={ttsText} /></label></div>}
            </>}
            {!ttsPlanner && <label className="audio-main-field"><span>Testo da pronunciare</span><textarea onChange={(event) => setTtsText(event.target.value)} placeholder="Scrivi il testo. Puoi includere indicazioni espressive naturali…" rows={6} value={ttsText} /></label>}
            <div className="audio-grid">
              <label><span>Voce predefinita</span><select disabled={cloneEnabled} onChange={(event) => setVoice(event.target.value)} value={voice}>{(capabilities?.tts.voices ?? [voice]).map((item) => <option key={item} value={item}>{item.replace(/\.(wav|mp3|ogg|flac)$/i, "")}</option>)}</select></label>
              <fieldset className="audio-seed"><legend>Seed</legend><button className={!fixedSeed ? "selected" : ""} onClick={() => setFixedSeed(false)} type="button">Random</button><button className={fixedSeed ? "selected" : ""} onClick={() => setFixedSeed(true)} type="button">Fisso</button><input disabled={!fixedSeed} min="0" onChange={(event) => setSeed(Number(event.target.value))} type="number" value={seed} /></fieldset>
            </div>
            <div className={`voice-clone ${cloneEnabled ? "enabled" : ""}`}>
              <div><label><input checked={cloneEnabled} onChange={(event) => setCloneEnabled(event.target.checked)} type="checkbox" /> Cloning vocale one-shot</label><span>Usa un breve campione pulito; il modello viene sempre scaricato dalla VRAM al termine.</span></div>
              {cloneEnabled && <><div className="voice-reference-actions"><button onClick={() => void openLibrary()} type="button">Scegli dalla Libreria</button><label className="asset-upload">{busy === "upload" ? "Caricamento…" : busy === "transcribe" ? "Trascrizione…" : "Carica audio"}<input accept="audio/*" disabled={busy === "upload" || busy === "transcribe"} onChange={(event) => { void uploadReference(event.currentTarget.files); event.currentTarget.value = ""; }} type="file" /></label></div>{reference && <div className="voice-reference-chip"><audio controls src={fullUrl(bridgeUrl, reference.mediaPath)} /><strong>{reference.originalName ?? reference.name}</strong><button onClick={() => { setReference(null); setReferenceText(""); }} type="button">×</button></div>}<label><span>Trascrizione automatica del campione (modificabile)</span><textarea onChange={(event) => setReferenceText(event.target.value)} placeholder={busy === "transcribe" ? "Riconoscimento multilingua in corso…" : "Il testo riconosciuto appare qui; puoi correggerlo manualmente…"} rows={2} value={referenceText} /></label></>}
            </div>
          </div>
        ) : kind === "speech_music" ? (
          <div className="audio-form">
            <div className={`music-planner ${speechPlanner ? "enabled" : ""}`}>
              <div><label><input checked={speechPlanner} onChange={(event) => { setSpeechPlanner(event.target.checked); setSpeechPlanReady(false); }} type="checkbox" /> Planner Parlato → brano</label><span>Il modello LLM usa trascrizione, durata e direzione creativa per progettare una base senza voce; poi viene scaricato.</span></div>
            </div>
            <div className="voice-clone enabled">
              <div><label>Parlato sorgente</label><span>La voce originale viene preservata, convertita in stereo e mixata con ducking automatico.</span></div>
              <div className="voice-reference-actions"><button onClick={() => void openLibrary()} type="button">Scegli dalla Libreria</button><label className="asset-upload">{busy === "upload" ? "Caricamento…" : busy === "transcribe" ? "Trascrizione…" : "Carica parlato"}<input accept="audio/*" disabled={busy === "upload" || busy === "transcribe"} onChange={(event) => { void uploadReference(event.currentTarget.files); event.currentTarget.value = ""; }} type="file" /></label></div>
              {reference && <div className="voice-reference-chip"><audio controls src={fullUrl(bridgeUrl, reference.mediaPath)} /><strong>{reference.originalName ?? reference.name}</strong><button onClick={() => { setReference(null); setReferenceText(""); setSpeechPlanReady(false); }} type="button">×</button></div>}
              <label><span>Trascrizione per guidare la base (modificabile)</span><textarea onChange={(event) => { setReferenceText(event.target.value); setSpeechPlanReady(false); }} placeholder={busy === "transcribe" ? "Trascrizione in corso…" : "Il testo riconosciuto aiuta il planner a seguire tono e ritmo del parlato."} rows={3} value={referenceText} /></label>
            </div>
            {speechPlanner ? <>
              <label className="audio-main-field"><span>Direzione musicale</span><textarea onChange={(event) => { setSpeechIdea(event.target.value); setSpeechPlanReady(false); }} placeholder="Facoltativo: base jazz elegante, cinematica, elettronica discreta, podcast energico…" rows={4} value={speechIdea} /></label>
              <button className="music-plan-button" disabled={busy === "speech-planner" || !reference || !capabilities?.music.plannerReady} onClick={() => void prepareSpeechPlan().catch(() => undefined)} type="button">{busy === "speech-planner" ? "LLM sta preparando…" : "Prepara base con LLM"}</button>
              {speechPlanReady && <div className="music-plan-preview"><strong>Piano strumentale modificabile</strong><span>{speechPlanSummary}</span><label><span>Descrizione tecnica MiniMax</span><textarea onChange={(event) => setCaption(event.target.value)} rows={5} value={caption} /></label></div>}
            </> : <label className="audio-main-field"><span>Descrivi la base strumentale</span><textarea onChange={(event) => setCaption(event.target.value)} placeholder="Instrumental only, no vocals, lascia spazio alla voce…" rows={5} value={caption} /></label>}
            <div className="speech-mix-controls">
              <label><span>Voce · {voiceGain.toFixed(2)}</span><input min="0" max="2" step="0.05" type="range" value={voiceGain} onChange={(event) => setVoiceGain(Number(event.target.value))} /></label>
              <label><span>Musica · {musicGain.toFixed(2)}</span><input min="0" max="2" step="0.05" type="range" value={musicGain} onChange={(event) => setMusicGain(Number(event.target.value))} /></label>
              <label><span>Ducking · {ducking.toFixed(2)}</span><input min="0" max="1" step="0.05" type="range" value={ducking} onChange={(event) => setDucking(Number(event.target.value))} /></label>
            </div>
            <fieldset className="audio-seed"><legend>Seed base musicale</legend><button className={!fixedSeed ? "selected" : ""} onClick={() => setFixedSeed(false)} type="button">Random</button><button className={fixedSeed ? "selected" : ""} onClick={() => setFixedSeed(true)} type="button">Fisso</button><input disabled={!fixedSeed} min="0" onChange={(event) => setSeed(Number(event.target.value))} type="number" value={seed} /></fieldset>
          </div>
        ) : (
          <div className="audio-form">
            <div className={`music-planner ${musicPlanner ? "enabled" : ""}`}>
              <div><label><input checked={musicPlanner} onChange={(event) => { setMusicPlanner(event.target.checked); setMusicPlanReady(false); }} type="checkbox" /> Music Planner AI</label><span>{capabilities?.music.plannerReady ? "Scrivi in linguaggio naturale: il modello LLM prepara la sintassi e poi viene scaricato." : "Planner non disponibile: configura il modello LLM in Admin oppure disattivalo per l'input manuale."}</span></div>
            </div>
            {kind === "voice_cover" && <div className="voice-clone enabled">
              <div><label>Reference del timbro</label><span>Usa 5–20 secondi di voce pulita. MiniMax crea il canto; BS-RoFormer isola la voce e Seed-VC trasferisce soltanto il timbro.</span></div>
              <div className="voice-reference-actions"><button onClick={() => void openLibrary()} type="button">Scegli dalla Libreria</button><label className="asset-upload">{busy === "upload" ? "Caricamento…" : "Carica voce"}<input accept="audio/*" disabled={busy === "upload"} onChange={(event) => { void uploadReference(event.currentTarget.files); event.currentTarget.value = ""; }} type="file" /></label></div>
              {reference && <div className="voice-reference-chip"><audio controls src={fullUrl(bridgeUrl, reference.mediaPath)} /><strong>{reference.originalName ?? reference.name}</strong><button onClick={() => setReference(null)} type="button">×</button></div>}
              <small>{capabilities?.voiceConversion.ready ? `Seed-VC pronto · ${capabilities.voiceConversion.backend.toUpperCase()} · unload a fine processo` : "Runtime audio.cpp o modelli mancanti: completa il setup in Admin."}</small>
            </div>}
            {musicPlanner && <>
              <label className="audio-main-field"><span>{kind === "voice_cover" ? "Che canzone deve cantare con questo timbro?" : "Cosa vuoi ascoltare?"}</span><textarea onChange={(event) => { setMusicIdea(event.target.value); setMusicPlanReady(false); }} placeholder="Esempio: canzone synth-pop energica in italiano, voce femminile, ritornello orecchiabile, atmosfera estiva." rows={5} value={musicIdea} /></label>
              <button className="music-plan-button" disabled={busy === "planner" || !musicIdea.trim() || !capabilities?.music.plannerReady} onClick={() => void prepareMusicPlan().catch(() => undefined)} type="button">{busy === "planner" ? "LLM sta preparando..." : "Prepara con LLM"}</button>
              {musicPlanReady && <div className="music-plan-preview"><strong>Piano modificabile</strong><span>{musicPlanSummary}</span><label><span>Descrizione tecnica MiniMax</span><textarea onChange={(event) => setCaption(event.target.value)} rows={5} value={caption} /></label>{!instrumental && <label><span>Lyrics strutturate</span><textarea onChange={(event) => setLyrics(event.target.value)} rows={8} value={lyrics} /></label>}</div>}
            </>}
            <div hidden={musicPlanner}>
            <label className="audio-main-field"><span>Descrivi il brano</span><textarea onChange={(event) => setCaption(event.target.value)} placeholder="Genere, atmosfera, strumenti, voce, BPM, struttura e produzione…" rows={5} value={caption} /></label>
            </div>
            <div className="audio-grid three">
              <label><span>Durata</span><select onChange={(event) => setDuration(Number(event.target.value))} value={duration}><option value="15">15 secondi</option><option value="30">30 secondi</option><option value="60">60 secondi</option><option value="120">2 minuti</option><option value="180">3 minuti</option></select></label>
              {kind === "music" ? <label className="instrumental-toggle"><span>Voce</span><button className={instrumental ? "selected" : ""} onClick={() => setInstrumental(true)} type="button">Strumentale</button><button className={!instrumental ? "selected" : ""} onClick={() => setInstrumental(false)} type="button">Con testo</button></label> : <label><span>Voce</span><strong>Con testo · timbro dalla reference</strong></label>}
              <fieldset className="audio-seed"><legend>Seed</legend><button className={!fixedSeed ? "selected" : ""} onClick={() => setFixedSeed(false)} type="button">Random</button><button className={fixedSeed ? "selected" : ""} onClick={() => setFixedSeed(true)} type="button">Fisso</button><input disabled={!fixedSeed} min="0" onChange={(event) => setSeed(Number(event.target.value))} type="number" value={seed} /></fieldset>
            </div>
            <div hidden={musicPlanner}>
            {(!instrumental || kind === "voice_cover") && <label><span>Lyrics strutturate</span><textarea onChange={(event) => setLyrics(event.target.value)} placeholder={'[Verse]\nTesto della strofa…\n\n[Chorus]\nTesto del ritornello…'} rows={8} value={lyrics} /></label>}
            </div>
          </div>
        )}

        {message && <div className="audio-message">{message}</div>}
        <div className="generation-footer audio-footer">
          <div className="preset-note"><span className="fast-badge">{kind === "tts" ? "HIGGS 8-BIT" : kind === "voice_cover" ? "H3 + SEED-VC" : "MINIMAX MUSIC 3"}</span>{kind === "tts" ? "Processo isolato · unload automatico" : kind === "voice_cover" ? `${duration}s · separazione + SVC · unload automatico` : `${duration}s · tiled decode · ${capabilities?.music.steps ?? 30} step`}</div>
          <div hidden={((kind === "music" || kind === "voice_cover") && musicPlanner) || (kind === "tts" && ttsPlanner) || kind === "speech_music"}>
          <div className="generation-cta"><div><span>Stato motore</span><strong>{selectedReady ? "Pronto" : "Configura in Admin"}</strong></div><button disabled={busy === "run" || !selectedReady || (kind === "tts" ? !ttsText.trim() || (cloneEnabled && !reference) : !caption.trim() || (kind === "voice_cover" && !reference))} onClick={() => void run()} type="button">{busy === "run" ? "Avvio…" : kind === "tts" ? "Genera voce" : kind === "voice_cover" ? "Crea col mio timbro" : "Genera musica"}</button></div>
          </div>
          {kind === "tts" && ttsPlanner && <div className="generation-cta"><div><span>Stato motore</span><strong>{capabilities?.tts.plannerReady ? "Planner e Higgs pronti" : "Configura il modello LLM in Admin"}</strong></div><button disabled={busy === "run" || busy === "tts-planner" || !selectedReady || !capabilities?.tts.plannerReady || !ttsIdea.trim() || (cloneEnabled && !reference)} onClick={() => void run()} type="button">{busy === "run" ? "LLM prepara e avvia..." : busy === "tts-planner" ? "LLM prepara..." : "Genera voce"}</button></div>}
          {kind === "music" && musicPlanner && <div className="generation-cta"><div><span>Stato motore</span><strong>{capabilities?.music.plannerReady ? "Planner e motore pronti" : "Configura il modello LLM in Admin"}</strong></div><button disabled={busy === "run" || busy === "planner" || !selectedReady || !capabilities?.music.plannerReady || !musicIdea.trim()} onClick={() => void run()} type="button">{busy === "run" ? "LLM prepara e avvia..." : busy === "planner" ? "LLM prepara..." : "Genera musica"}</button></div>}
          {kind === "voice_cover" && musicPlanner && <div className="generation-cta"><div><span>Stato motore</span><strong>{selectedReady && capabilities?.music.plannerReady ? "MiniMax, separazione e Seed-VC pronti" : "Completa Music/Seed-VC in Admin"}</strong></div><button disabled={busy === "run" || busy === "planner" || !selectedReady || !capabilities?.music.plannerReady || !musicIdea.trim() || !reference} onClick={() => void run()} type="button">{busy === "run" ? "Prepara canto e timbro…" : busy === "planner" ? "LLM prepara..." : "Crea col mio timbro"}</button></div>}
          {kind === "speech_music" && <div className="generation-cta"><div><span>Stato motore</span><strong>{selectedReady && (!speechPlanner || capabilities?.music.plannerReady) ? "Mix e motore pronti" : "Configura Music/LLM in Admin"}</strong></div><button disabled={busy === "run" || busy === "speech-planner" || !selectedReady || !reference || (speechPlanner ? !capabilities?.music.plannerReady : !caption.trim())} onClick={() => void run()} type="button">{busy === "run" ? "Prepara base e mix…" : busy === "speech-planner" ? "LLM prepara…" : "Crea brano dal parlato"}</button></div>}
        </div>
      </section>

      {libraryOpen && typeof document !== "undefined" && createPortal(<div className="media-picker-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setLibraryOpen(false); }} role="presentation"><section aria-modal="true" className="media-library-picker media-library-modal audio-picker" role="dialog"><div className="media-picker-heading"><div><strong>{kind === "speech_music" ? "Parlato sorgente" : kind === "voice_cover" ? "Reference del timbro" : "Reference vocali"}</strong><span>Scegli un audio già salvato senza ricaricarlo dal disco</span></div><button onClick={() => setLibraryOpen(false)} type="button">×</button></div>{(busy === "upload" || busy === "transcribe") && <div className="audio-picker-notice">La trascrizione corrente è ancora in corso. Puoi consultare la Libreria; attendi il termine prima di scegliere un altro campione.</div>}<div className="audio-library-grid">{libraryBusy ? <p>Caricamento Libreria...</p> : <>{library.map((asset) => <button disabled={busy === "upload" || busy === "transcribe"} key={asset.id} onClick={() => { setReference(asset); setReferenceText(""); if (kind === "tts") setCloneEnabled(true); if (kind === "speech_music") setSpeechPlanReady(false); setLibraryOpen(false); if (kind === "voice_cover") setMessage("Reference timbrica pronta; Seed-VC userà direttamente il campione."); else void transcribeReference(asset); }} type="button"><audio controls onClick={(event) => event.stopPropagation()} src={fullUrl(bridgeUrl, asset.mediaPath)} /><strong>{asset.originalName ?? asset.name}</strong><span>{asset.originProjectName ?? "Media esterno"}</span></button>)}{library.length === 0 && <p>Nessun audio in Libreria. Caricane uno dal pannello Audio.</p>}</>}</div></section></div>, document.body)}
    </div>
  );
}
