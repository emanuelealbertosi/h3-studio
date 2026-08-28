"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type AudioKind = "tts" | "music";
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
  createdAt: string;
};

type Capabilities = {
  tts: { ready: boolean; root: string; voices: string[]; defaultVoice: string; unloadPolicy: string; plannerReady?: boolean; plannerModel?: string; transcriptionReady?: boolean; transcriptionModel?: string; transcriptionUnloadPolicy?: string };
  music: { ready: boolean; model: string; encoder: string; vae: string; steps: number; cfg: number; plannerReady?: boolean; plannerModel?: string };
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

export default function AudioStudioPanel({ bridgeUrl, projectId, projectName }: Props) {
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
  const selectedReady = kind === "tts" ? capabilities?.tts.ready : capabilities?.music.ready;

  async function load() {
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
    setJobs(jobsPayload.jobs ?? []);
    if (libraryResponse.ok) setLibrary((libraryPayload.assets ?? []).filter((asset) => asset.kind === "audio"));
  }

  useEffect(() => {
    if (!projectId) return;
    // This effect synchronizes the panel with the remote bridge state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((error) => setMessage(error instanceof Error ? error.message : "Audio non disponibile"));
  }, [bridgeUrl, projectId]);

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
      setCloneEnabled(true);
      await transcribeReference(payload.asset, false);
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
    setMessage("Gemma sta preparando testo, lingua e prosodia per Higgs...");
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
      setMessage(`${payload.plan.summary} Gemma e stata scaricata; il testo resta modificabile.`);
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
    setMessage("Gemma sta trasformando la tua idea in un piano musicale...");
    try {
      const response = await fetch(`${bridgeUrl}/api/audio-jobs/music-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea: musicIdea, instrumental, durationSeconds: duration, lyrics }),
      });
      const payload = await response.json() as { plan?: MusicPlan; error?: string };
      if (!response.ok || !payload.plan) throw new Error(payload.error ?? "Music Planner non disponibile");
      setCaption(payload.plan.caption);
      setLyrics(payload.plan.lyrics);
      setMusicPlanSummary(payload.plan.summary);
      setMusicPlanReady(true);
      setMessage(`${payload.plan.summary} Gemma e stata scaricata; puoi modificare il piano o generare.`);
      return payload.plan;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Music Planner fallito");
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
      let effectiveLyrics = instrumental ? "" : lyrics;
      if (kind === "tts" && ttsPlanner && !ttsPlanReady) {
        effectiveTtsText = (await prepareTtsPlan(false)).prompt;
      }
      if (kind === "music" && musicPlanner && !musicPlanReady) {
        const plan = await prepareMusicPlan(false);
        effectiveCaption = plan.caption;
        effectiveLyrics = plan.lyrics;
      }
      const body = kind === "tts"
        ? {
            kind, projectId, text: effectiveTtsText, voice,
            seed: fixedSeed ? seed : undefined,
            referenceFile: cloneEnabled ? reference?.file : undefined,
            referenceText: cloneEnabled ? referenceText : undefined,
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
      setMessage(kind === "tts" ? "Higgs in caricamento; verrà scaricato automaticamente a fine job." : "MiniMax Music inviato a ComfyUI.");
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
                <span className="fast-badge">{job.kind === "tts" ? "HIGGS TTS" : "H3 MUSIC"}</span>
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
        </div>

        {(busy || activeJob || latestJob) && (() => {
          const localLabels: Record<string, string> = {
            upload: "Caricamento del campione audio",
            transcribe: "Trascrizione del campione con Whisper",
            "tts-planner": "Gemma sta preparando il TTS",
            planner: "Gemma sta preparando la musica",
            run: kind === "tts" ? "Avvio della generazione TTS" : "Avvio della generazione musicale",
          };
          const displayJob = activeJob ?? latestJob;
          const isWorking = Boolean(busy || activeJob);
          const isFailed = !isWorking && Boolean(displayJob && ["failed", "cancelled"].includes(displayJob.status));
          const title = busy ? (localLabels[busy] ?? "Operazione audio in corso") : activeJob ? `${activeJob.kind === "tts" ? "Voce TTS" : "Musica H3"} in generazione` : isFailed ? "Ultima generazione non riuscita" : "Audio pronto";
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
              <div><label><input checked={ttsPlanner} onChange={(event) => { setTtsPlanner(event.target.checked); setTtsPlanReady(false); }} type="checkbox" /> TTS Planner AI</label><span>{capabilities?.tts.plannerReady ? "Scrivi naturalmente in qualunque lingua: Gemma separa testo e regia vocale, poi viene scaricata." : "Planner non disponibile: configura Gemma in Admin oppure usa l'input manuale."}</span></div>
            </div>
            {ttsPlanner && <>
              <label className="audio-main-field planner-request-field"><span>Cosa deve dire e come?</span><textarea onChange={(event) => { setTtsIdea(event.target.value); setTtsPlanReady(false); }} placeholder="Esempio: in italiano, con tono rassicurante e una breve pausa dopo il saluto, di': Buongiorno e benvenuti..." rows={5} value={ttsIdea} /></label>
              <button className="prompt-plan-button" disabled={busy === "tts-planner" || !ttsIdea.trim() || !capabilities?.tts.plannerReady} onClick={() => void prepareTtsPlan().catch(() => undefined)} type="button">{busy === "tts-planner" ? "Gemma sta preparando..." : "Prepara con Gemma"}</button>
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
        ) : (
          <div className="audio-form">
            <div className={`music-planner ${musicPlanner ? "enabled" : ""}`}>
              <div><label><input checked={musicPlanner} onChange={(event) => { setMusicPlanner(event.target.checked); setMusicPlanReady(false); }} type="checkbox" /> Music Planner AI</label><span>{capabilities?.music.plannerReady ? "Scrivi in linguaggio naturale: Gemma prepara la sintassi e poi viene scaricata." : "Planner non disponibile: configura Gemma in Admin oppure disattivalo per l'input manuale."}</span></div>
            </div>
            {musicPlanner && <>
              <label className="audio-main-field"><span>Cosa vuoi ascoltare?</span><textarea onChange={(event) => { setMusicIdea(event.target.value); setMusicPlanReady(false); }} placeholder="Esempio: canzone synth-pop energica in italiano, voce femminile, ritornello orecchiabile, atmosfera estiva." rows={5} value={musicIdea} /></label>
              <button className="music-plan-button" disabled={busy === "planner" || !musicIdea.trim() || !capabilities?.music.plannerReady} onClick={() => void prepareMusicPlan().catch(() => undefined)} type="button">{busy === "planner" ? "Gemma sta preparando..." : "Prepara con Gemma"}</button>
              {musicPlanReady && <div className="music-plan-preview"><strong>Piano modificabile</strong><span>{musicPlanSummary}</span><label><span>Descrizione tecnica MiniMax</span><textarea onChange={(event) => setCaption(event.target.value)} rows={5} value={caption} /></label>{!instrumental && <label><span>Lyrics strutturate</span><textarea onChange={(event) => setLyrics(event.target.value)} rows={8} value={lyrics} /></label>}</div>}
            </>}
            <div hidden={musicPlanner}>
            <label className="audio-main-field"><span>Descrivi il brano</span><textarea onChange={(event) => setCaption(event.target.value)} placeholder="Genere, atmosfera, strumenti, voce, BPM, struttura e produzione…" rows={5} value={caption} /></label>
            </div>
            <div className="audio-grid three">
              <label><span>Durata</span><select onChange={(event) => setDuration(Number(event.target.value))} value={duration}><option value="15">15 secondi</option><option value="30">30 secondi</option><option value="60">60 secondi</option><option value="120">2 minuti</option><option value="180">3 minuti</option></select></label>
              <label className="instrumental-toggle"><span>Voce</span><button className={instrumental ? "selected" : ""} onClick={() => setInstrumental(true)} type="button">Strumentale</button><button className={!instrumental ? "selected" : ""} onClick={() => setInstrumental(false)} type="button">Con testo</button></label>
              <fieldset className="audio-seed"><legend>Seed</legend><button className={!fixedSeed ? "selected" : ""} onClick={() => setFixedSeed(false)} type="button">Random</button><button className={fixedSeed ? "selected" : ""} onClick={() => setFixedSeed(true)} type="button">Fisso</button><input disabled={!fixedSeed} min="0" onChange={(event) => setSeed(Number(event.target.value))} type="number" value={seed} /></fieldset>
            </div>
            <div hidden={musicPlanner}>
            {!instrumental && <label><span>Lyrics strutturate</span><textarea onChange={(event) => setLyrics(event.target.value)} placeholder={'[Verse]\nTesto della strofa…\n\n[Chorus]\nTesto del ritornello…'} rows={8} value={lyrics} /></label>}
            </div>
          </div>
        )}

        {message && <div className="audio-message">{message}</div>}
        <div className="generation-footer audio-footer">
          <div className="preset-note"><span className="fast-badge">{kind === "tts" ? "HIGGS 8-BIT" : "MINIMAX MUSIC 3"}</span>{kind === "tts" ? "Processo isolato · unload automatico" : `${duration}s · tiled decode · ${capabilities?.music.steps ?? 30} step`}</div>
          <div hidden={(kind === "music" && musicPlanner) || (kind === "tts" && ttsPlanner)}>
          <div className="generation-cta"><div><span>Stato motore</span><strong>{selectedReady ? "Pronto" : "Configura in Admin"}</strong></div><button disabled={busy === "run" || !selectedReady || (kind === "tts" ? !ttsText.trim() || (cloneEnabled && !reference) : !caption.trim())} onClick={() => void run()} type="button">{busy === "run" ? "Avvio…" : kind === "tts" ? "Genera voce" : "Genera musica"}</button></div>
          </div>
          {kind === "tts" && ttsPlanner && <div className="generation-cta"><div><span>Stato motore</span><strong>{capabilities?.tts.plannerReady ? "Planner e Higgs pronti" : "Configura Gemma in Admin"}</strong></div><button disabled={busy === "run" || busy === "tts-planner" || !selectedReady || !capabilities?.tts.plannerReady || !ttsIdea.trim() || (cloneEnabled && !reference)} onClick={() => void run()} type="button">{busy === "run" ? "Gemma prepara e avvia..." : busy === "tts-planner" ? "Gemma prepara..." : "Genera voce"}</button></div>}
          {kind === "music" && musicPlanner && <div className="generation-cta"><div><span>Stato motore</span><strong>{capabilities?.music.plannerReady ? "Planner e motore pronti" : "Configura Gemma in Admin"}</strong></div><button disabled={busy === "run" || busy === "planner" || !selectedReady || !capabilities?.music.plannerReady || !musicIdea.trim()} onClick={() => void run()} type="button">{busy === "run" ? "Gemma prepara e avvia..." : busy === "planner" ? "Gemma prepara..." : "Genera musica"}</button></div>}
        </div>
      </section>

      {libraryOpen && typeof document !== "undefined" && createPortal(<div className="media-picker-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setLibraryOpen(false); }} role="presentation"><section aria-modal="true" className="media-library-picker media-library-modal audio-picker" role="dialog"><div className="media-picker-heading"><div><strong>Reference vocali</strong><span>Scegli un audio gia salvato senza ricaricarlo dal disco</span></div><button onClick={() => setLibraryOpen(false)} type="button">×</button></div>{(busy === "upload" || busy === "transcribe") && <div className="audio-picker-notice">La trascrizione corrente e ancora in corso. Puoi consultare la Libreria; attendi il termine prima di scegliere un altro campione.</div>}<div className="audio-library-grid">{libraryBusy ? <p>Caricamento Libreria...</p> : <>{library.map((asset) => <button disabled={busy === "upload" || busy === "transcribe"} key={asset.id} onClick={() => { setReference(asset); setReferenceText(""); setCloneEnabled(true); setLibraryOpen(false); void transcribeReference(asset); }} type="button"><audio controls onClick={(event) => event.stopPropagation()} src={fullUrl(bridgeUrl, asset.mediaPath)} /><strong>{asset.originalName ?? asset.name}</strong><span>{asset.originProjectName ?? "Media esterno"}</span></button>)}{library.length === 0 && <p>Nessun audio in Libreria. Caricane uno dal pannello TTS.</p>}</>}</div></section></div>, document.body)}
    </div>
  );
}
