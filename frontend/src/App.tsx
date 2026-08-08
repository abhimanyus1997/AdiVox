import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  CircleDollarSign,
  ChevronDown,
  FileAudio,
  FolderOpen,
  Gauge,
  Eye,
  EyeOff,
  KeyRound,
  Mic,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Sparkles,
  Square,
  Trash2,
  UploadCloud,
  Volume2,
  X,
} from "lucide-react";

type Segment = {
  speaker: string;
  start_seconds: number;
  end_seconds: number;
  text: string;
};

type Transcript = {
  title: string;
  summary: string;
  language: string;
  duration_seconds: number;
  segments: Segment[];
  usage: {
    input_tokens: number;
    audio_input_tokens: number;
    text_input_tokens: number;
    output_tokens: number;
    thinking_tokens: number;
    total_tokens: number;
    estimated_cost_usd: number;
    model: string;
    pricing_basis: string;
  };
};

type SavedTranscriptSummary = {
  id: number;
  title: string;
  summary: string;
  language: string;
  duration_seconds: number;
  speaker_count: number;
  created_at: string;
};

const SPEAKER_COLORS = ["#6c4ee3", "#16a673", "#e37839", "#2d85c7", "#d34f82", "#7a8a2b"];
const PRODUCT_NAME = "AdiVox";
const API_BASE = import.meta.env.PROD ? "/adivox/api" : "/api";

function formatTime(value: number) {
  if (!Number.isFinite(value)) return "00:00";
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function formatSrtTime(value: number) {
  const milliseconds = Math.max(0, Math.round(value * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(remainder).padStart(3, "0")}`;
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [inputMode, setInputMode] = useState<"upload" | "record">("upload");
  const [recordingState, setRecordingState] = useState<"idle" | "recording" | "paused">("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState("");
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [savedTranscripts, setSavedTranscripts] = useState<SavedTranscriptSummary[]>([]);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [workspaceTab, setWorkspaceTab] = useState<"transcript" | "usage">("transcript");
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [activeApiKey, setActiveApiKey] = useState("");
  const [maxUploadMb, setMaxUploadMb] = useState(200);
  const [showApiKey, setShowApiKey] = useState(false);
  const [configuringKey, setConfiguringKey] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(
    () => () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    },
    [audioUrl],
  );

  useEffect(() => {
    void refreshSavedTranscripts();
    void checkConfiguration();
  }, []);

  useEffect(() => {
    if (recordingState !== "recording") return;
    const timer = window.setInterval(() => setRecordingSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recordingState]);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const speakers = useMemo(
    () => [...new Set(transcript?.segments.map((segment) => segment.speaker) ?? [])],
    [transcript],
  );
  const colorFor = (speaker: string) => SPEAKER_COLORS[speakers.indexOf(speaker) % SPEAKER_COLORS.length];
  const totalDuration = duration || transcript?.duration_seconds || 1;
  const visibleSegments = transcript?.segments.filter(
    (segment) =>
      !query ||
      segment.text.toLowerCase().includes(query.toLowerCase()) ||
      segment.speaker.toLowerCase().includes(query.toLowerCase()),
  );

  function chooseFile(selected?: File) {
    if (!selected) return;
    if (!selected.type.startsWith("audio/") && !/\.(mp3|wav|m4a|aac|ogg|flac|aiff?)$/i.test(selected.name)) {
      setError("Choose an MP3, WAV, M4A, AAC, OGG, FLAC, or AIFF audio file.");
      return;
    }
    if (selected.size > maxUploadMb * 1024 * 1024) {
      setError(`That file is over the ${maxUploadMb} MB limit.`);
      return;
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setFile(selected);
    setAudioUrl(URL.createObjectURL(selected));
    setTranscript(null);
    setSavedId(null);
    setSaveStatus("idle");
    setError("");
    setCurrentTime(0);
  }

  async function startRecording() {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Microphone recording is not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const preferredTypes = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
      const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) || "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      setFile(null);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl("");
      setRecordingSeconds(0);
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const actualType = recorder.mimeType || "audio/webm";
        const extension = actualType.includes("mp4") ? "m4a" : "webm";
        const blob = new Blob(chunksRef.current, { type: actualType });
        const recordedFile = new File([blob], `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`, { type: actualType });
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecordingState("idle");
        chooseFile(recordedFile);
      };
      recorder.start(500);
      setRecordingState("recording");
    } catch (reason) {
      setRecordingState("idle");
      setError(
        reason instanceof DOMException && reason.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow microphone access and try again."
          : "Could not start the microphone. Check that it is connected and available.",
      );
    }
  }

  function pauseOrResumeRecording() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      setRecordingState("paused");
    } else if (recorder.state === "paused") {
      recorder.resume();
      setRecordingState("recording");
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  function discardRecording() {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl("");
    setFile(null);
    setRecordingSeconds(0);
    setError("");
  }

  async function generateTranscript() {
    if (!file) return;
    setLoading(true);
    setError("");
    const form = new FormData();
    form.append("audio", file);
    try {
      const response = await fetch(`${API_BASE}/transcribe`, {
        method: "POST",
        headers: activeApiKey ? { "X-Gemini-API-Key": activeApiKey } : undefined,
        body: form,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "Unable to transcribe this recording.");
      setTranscript(payload);
      setWorkspaceTab("transcript");
      setSavedId(null);
      setSaveStatus("idle");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function seek(value: number) {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(0, Math.min(value, totalDuration));
    setCurrentTime(audioRef.current.currentTime);
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }

  function changeSpeed(event: ChangeEvent<HTMLSelectElement>) {
    const value = Number(event.target.value);
    setSpeed(value);
    if (audioRef.current) audioRef.current.playbackRate = value;
  }

  function exportTranscript(format: "txt" | "srt" | "json") {
    if (!transcript) return;
    const body = format === "json"
      ? JSON.stringify(transcript, null, 2)
      : format === "srt"
        ? transcript.segments.map((segment, index) => [
            index + 1,
            `${formatSrtTime(segment.start_seconds)} --> ${formatSrtTime(segment.end_seconds)}`,
            `${segment.speaker}: ${segment.text}`,
          ].join("\n")).join("\n\n")
        : [
            transcript.title,
            transcript.summary,
            "",
            ...transcript.segments.map((segment) => `[${formatTime(segment.start_seconds)}] ${segment.speaker}: ${segment.text}`),
          ].join("\n");
    const mimeType = format === "json" ? "application/json" : format === "srt" ? "application/x-subrip" : "text/plain";
    const url = URL.createObjectURL(new Blob([body], { type: mimeType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${transcript.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "transcript"}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function refreshSavedTranscripts() {
    try {
      const response = await fetch(`${API_BASE}/transcripts`);
      if (response.ok) setSavedTranscripts(await response.json());
    } catch {
      // Saving remains available even if the library cannot be loaded initially.
    }
  }

  async function checkConfiguration() {
    try {
      const response = await fetch(`${API_BASE}/health`);
      const payload = await response.json();
      setApiConfigured(Boolean(payload.configured));
      if (Number.isFinite(payload.max_upload_mb)) setMaxUploadMb(payload.max_upload_mb);
    } catch {
      setApiConfigured(false);
    }
  }

  async function configureApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiKey.trim()) return;
    setConfiguringKey(true);
    setError("");
    try {
      const candidate = apiKey.trim();
      const response = await fetch(`${API_BASE}/configure-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: candidate }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "Could not validate this API key.");
      setActiveApiKey(candidate);
      setApiConfigured(true);
      setApiKey("");
      setShowApiKey(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not validate this API key.");
    } finally {
      setConfiguringKey(false);
    }
  }

  async function saveCurrentTranscript() {
    if (!transcript || saveStatus === "saving" || savedId) return;
    setSaveStatus("saving");
    setError("");
    try {
      const response = await fetch(`${API_BASE}/transcripts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(transcript),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "Could not save this transcript.");
      setSavedId(payload.id);
      setSaveStatus("saved");
      await refreshSavedTranscripts();
    } catch (reason) {
      setSaveStatus("idle");
      setError(reason instanceof Error ? reason.message : "Could not save this transcript.");
    }
  }

  async function openSavedTranscript(id: number) {
    setError("");
    try {
      const response = await fetch(`${API_BASE}/transcripts/${id}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "Could not open this transcript.");
      setTranscript(payload);
      setWorkspaceTab("transcript");
      setSavedId(id);
      setSaveStatus("saved");
      setFile(null);
      setAudioUrl("");
      setDuration(payload.duration_seconds);
      setCurrentTime(0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open this transcript.");
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="AdiVox home">
          <span className="brand-mark"><Sparkles size={18} /></span>
          {PRODUCT_NAME}
        </a>
        <span className="model-pill"><span /> Gemini 2.5 Flash</span>
      </header>

      <main id="top">
        {!transcript ? (
          <section className="hero">
            <div className="eyebrow"><Sparkles size={15} /> AI-powered speaker diarization</div>
            <h1>Every voice, <em>made clear.</em></h1>
            <p className="hero-copy">Turn any recording into a precise, speaker-aware transcript in minutes.</p>

            {apiConfigured === false && (
              <form className="api-setup" onSubmit={configureApiKey}>
                <span className="api-setup-icon"><KeyRound size={21} /></span>
                <div className="api-setup-copy">
                  <strong>Connect Gemini to continue</strong>
                  <small>
                    Your key stays in this browser tab's memory and is never saved by AdiVox.{" "}
                    <a href="https://aistudio.google.com/api-keys" target="_blank" rel="noreferrer">Get a Gemini API key ↗</a>
                  </small>
                </div>
                <label className="api-key-input">
                  <input
                    aria-label="Gemini API key"
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="Paste Gemini API key"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button type="button" aria-label={showApiKey ? "Hide API key" : "Show API key"} onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? <EyeOff size={17} /> : <Eye size={17} />}</button>
                </label>
                <button className="connect-key-button" disabled={configuringKey || apiKey.trim().length < 10}>{configuringKey ? "Checking…" : "Connect"}</button>
              </form>
            )}

            <div className="input-tabs" role="tablist" aria-label="Audio source">
              <button role="tab" aria-selected={inputMode === "upload"} className={inputMode === "upload" ? "active" : ""} onClick={() => setInputMode("upload")}><UploadCloud size={16} /> Upload file</button>
              <button role="tab" aria-selected={inputMode === "record"} className={inputMode === "record" ? "active" : ""} onClick={() => setInputMode("record")}><Mic size={16} /> Record audio</button>
            </div>

            <div
              className={`upload-card ${dragging ? "is-dragging" : ""}`}
              onDragOver={(event: DragEvent) => { if (inputMode === "upload") { event.preventDefault(); setDragging(true); } }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event: DragEvent) => { if (inputMode === "upload") { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); } }}
            >
              {inputMode === "record" && recordingState !== "idle" ? (
                <div className="recording-live">
                  <div className={`recording-orb ${recordingState}`}><Mic size={27} /></div>
                  <span className="recording-status"><i /> {recordingState === "paused" ? "Recording paused" : "Recording now"}</span>
                  <strong>{formatTime(recordingSeconds)}</strong>
                  <div className="recording-bars" aria-hidden="true">{Array.from({ length: 28 }, (_, index) => <span key={index} style={{ height: `${18 + ((index * 13) % 36)}px` }} />)}</div>
                  <div className="recording-actions">
                    <button className="secondary-button" onClick={pauseOrResumeRecording}>{recordingState === "paused" ? <Play size={17} /> : <Pause size={17} />}{recordingState === "paused" ? "Resume" : "Pause"}</button>
                    <button className="stop-button" onClick={stopRecording}><Square size={16} fill="currentColor" /> Stop recording</button>
                  </div>
                </div>
              ) : inputMode === "record" && file ? (
                <div className="recording-ready">
                  <span className="file-icon"><FileAudio size={26} /></span>
                  <div className="recording-ready-copy"><strong>Recording ready</strong><span>{formatTime(recordingSeconds)} · listen before transcribing</span></div>
                  <button className="icon-button" aria-label="Discard recording" onClick={discardRecording}><Trash2 size={18} /></button>
                  <audio className="recording-preview" controls src={audioUrl} />
                </div>
              ) : inputMode === "record" ? (
                <>
                  <span className="upload-icon record-icon"><Mic size={29} /></span>
                  <h2>Record from your microphone</h2>
                  <p>Capture a conversation directly in your browser</p>
                  <button className="record-button" onClick={startRecording}><span /> Start recording</button>
                  <small>Your audio is only sent when you generate the transcript</small>
                </>
              ) : !file ? (
                <>
                  <span className="upload-icon"><UploadCloud size={30} /></span>
                  <h2>Drop your recording here</h2>
                  <p>or choose a file from your computer</p>
                  <button className="primary-button" onClick={() => inputRef.current?.click()}>Choose audio</button>
                  <small>MP3, WAV, M4A, AAC, OGG, FLAC or AIFF · up to {maxUploadMb} MB</small>
                </>
              ) : (
                <div className="selected-file">
                  <span className="file-icon"><FileAudio size={26} /></span>
                  <div><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(1)} MB · ready to transcribe</span></div>
                  <button className="icon-button" aria-label="Remove audio" onClick={() => { setFile(null); setAudioUrl(""); }}><X size={19} /></button>
                </div>
              )}
              <input ref={inputRef} hidden type="file" accept="audio/*,.m4a,.aiff" onChange={(event) => chooseFile(event.target.files?.[0])} />
            </div>

            {file && recordingState === "idle" && <button className="generate-button" disabled={loading || apiConfigured === false} onClick={generateTranscript}>
              {loading ? <><span className="spinner" /> Listening and identifying speakers…</> : <><Sparkles size={18} /> Generate transcript</>}
            </button>}
            {error && <div className="error-message" role="alert">{error}</div>}

            {savedTranscripts.length > 0 && (
              <section className="saved-library" aria-labelledby="saved-heading">
                <div className="saved-library-heading">
                  <div><span>Transcript library</span><h2 id="saved-heading">Saved transcripts</h2></div>
                  <small>{savedTranscripts.length} saved</small>
                </div>
                <div className="saved-grid">
                  {savedTranscripts.slice(0, 6).map((saved) => (
                    <button key={saved.id} className="saved-card" onClick={() => openSavedTranscript(saved.id)}>
                      <span className="saved-card-icon"><FolderOpen size={18} /></span>
                      <span className="saved-card-copy"><strong>{saved.title}</strong><small>{saved.speaker_count} {saved.speaker_count === 1 ? "speaker" : "speakers"} · {formatTime(saved.duration_seconds)} · {new Date(saved.created_at).toLocaleDateString()}</small></span>
                      <span aria-hidden="true">→</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <div className="feature-row">
              <span><b>01</b> Unlimited speakers</span>
              <span><b>02</b> Precise timestamps</span>
              <span><b>03</b> Searchable output</span>
            </div>
          </section>
        ) : (
          <section className="workspace">
            <div className="workspace-heading">
              <div>
                <button className="back-button" onClick={() => { setTranscript(null); setFile(null); setAudioUrl(""); setSavedId(null); setSaveStatus("idle"); void refreshSavedTranscripts(); }}>← New transcript</button>
                <h1>{transcript.title}</h1>
                <p>{speakers.length} {speakers.length === 1 ? "speaker" : "speakers"} · {transcript.language} · {formatTime(totalDuration)}</p>
              </div>
              <div className="workspace-actions">
              <button className={`save-button ${saveStatus === "saved" ? "saved" : ""}`} disabled={saveStatus !== "idle"} onClick={saveCurrentTranscript}>
                <Save size={17} /> {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved" : "Save transcript"}
              </button>
              <label className="export-button">
                <ArrowDownToLine size={17} />
                <span>Export transcript</span>
                <ChevronDown size={15} />
                <select
                  aria-label="Export transcript format"
                  value=""
                  onChange={(event) => {
                    const format = event.target.value as "txt" | "srt" | "json";
                    if (format) exportTranscript(format);
                  }}
                >
                  <option value="" disabled>Choose format</option>
                  <option value="txt">Plain text (.txt)</option>
                  <option value="srt">Subtitles (.srt)</option>
                  <option value="json">Structured data (.json)</option>
                </select>
              </label>
              </div>
            </div>

            <div className="workspace-tabs" role="tablist" aria-label="Transcript details">
              <button role="tab" aria-selected={workspaceTab === "transcript"} className={workspaceTab === "transcript" ? "active" : ""} onClick={() => setWorkspaceTab("transcript")}>Transcript</button>
              <button role="tab" aria-selected={workspaceTab === "usage"} className={workspaceTab === "usage" ? "active" : ""} onClick={() => setWorkspaceTab("usage")}><Gauge size={16} /> Usage & cost</button>
            </div>

            {workspaceTab === "transcript" ? <>
            <div className="recording-card">
              <div className="player-toolbar">
                <div className="transport">
                  <button className="play-button" disabled={!audioUrl} aria-label={playing ? "Pause" : "Play"} onClick={togglePlayback}>{playing ? <Pause /> : <Play />}</button>
                  <button className="icon-button" disabled={!audioUrl} aria-label="Back 15 seconds" onClick={() => seek(currentTime - 15)}><RotateCcw size={19} /></button>
                  <button className="icon-button" disabled={!audioUrl} aria-label="Forward 15 seconds" onClick={() => seek(currentTime + 15)}><RotateCw size={19} /></button>
                  <Volume2 className="volume-icon" size={20} />
                  <label className="speed-select">{speed}× <ChevronDown size={15} />
                    <select aria-label="Playback speed" value={speed} onChange={changeSpeed}>
                      {[0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value}x</option>)}
                    </select>
                  </label>
                </div>
                <strong className="clock"><span>{formatTime(currentTime)}</span> / {formatTime(totalDuration)}</strong>
                <label className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversation" /></label>
              </div>

              <div className="timeline">
                <input aria-label="Audio position" type="range" min="0" max={totalDuration} step="0.1" value={Math.min(currentTime, totalDuration)} onChange={(event) => seek(Number(event.target.value))} />
                <div className="playhead-label" style={{ left: `${Math.min(100, (currentTime / totalDuration) * 100)}%` }}>{formatTime(currentTime)}</div>
                {speakers.map((speaker) => (
                  <div className="speaker-track" key={speaker}>
                    <strong style={{ color: colorFor(speaker) }}>{speaker}</strong>
                    <div className="track-line">
                      {transcript.segments.filter((segment) => segment.speaker === speaker).map((segment, index) => (
                        <button
                          key={`${speaker}-${index}`}
                          aria-label={`Play ${speaker} at ${formatTime(segment.start_seconds)}`}
                          title={`${formatTime(segment.start_seconds)} · ${segment.text}`}
                          onClick={() => seek(segment.start_seconds)}
                          style={{
                            left: `${(segment.start_seconds / totalDuration) * 100}%`,
                            width: `${Math.max(0.7, ((segment.end_seconds - segment.start_seconds) / totalDuration) * 100)}%`,
                            background: colorFor(speaker),
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="summary-card"><span><Sparkles size={17} /></span><div><strong>Conversation brief</strong><p>{transcript.summary}</p></div></div>

            <div className="transcript-list">
              {visibleSegments?.map((segment, index) => {
                const active = currentTime >= segment.start_seconds && currentTime < segment.end_seconds;
                return <button className={`segment-card ${active ? "active" : ""}`} key={`${segment.start_seconds}-${index}`} onClick={() => seek(segment.start_seconds)}>
                  <span className="speaker-name" style={{ color: colorFor(segment.speaker) }}><i style={{ background: colorFor(segment.speaker) }} />{segment.speaker}</span>
                  <time>{formatTime(segment.start_seconds)}</time>
                  <p>{segment.text}</p>
                </button>;
              })}
              {visibleSegments?.length === 0 && <div className="empty-search">No transcript lines match “{query}”.</div>}
            </div>
            </> : (
              <section className="usage-panel">
                <div className="usage-hero">
                  <span><CircleDollarSign size={22} /></span>
                  <div><small>Estimated standard-tier cost</small><strong>${transcript.usage.estimated_cost_usd.toFixed(6)}</strong></div>
                  <p>This is an estimate based on reported Gemini token usage. Free-tier requests may cost $0.</p>
                </div>
                <div className="usage-grid">
                  <article><span>All tokens</span><strong>{transcript.usage.total_tokens.toLocaleString()}</strong><small>Input + output</small></article>
                  <article><span>Input tokens</span><strong>{transcript.usage.input_tokens.toLocaleString()}</strong><small>{transcript.usage.audio_input_tokens.toLocaleString()} audio · {transcript.usage.text_input_tokens.toLocaleString()} text</small></article>
                  <article><span>Output tokens</span><strong>{transcript.usage.output_tokens.toLocaleString()}</strong><small>Includes {transcript.usage.thinking_tokens.toLocaleString()} thinking</small></article>
                  <article><span>Audio utilization</span><strong>{transcript.usage.input_tokens ? Math.round((transcript.usage.audio_input_tokens / transcript.usage.input_tokens) * 100) : 0}%</strong><small>Share of input tokens</small></article>
                </div>
                <div className="cost-breakdown">
                  <div><span>Audio input</span><b>{transcript.usage.audio_input_tokens.toLocaleString()} × $1.00 / 1M</b></div>
                  <div><span>Text input</span><b>{transcript.usage.text_input_tokens.toLocaleString()} × $0.30 / 1M</b></div>
                  <div><span>Model output</span><b>{transcript.usage.output_tokens.toLocaleString()} × $2.50 / 1M</b></div>
                  <footer><span>Model</span><b>{transcript.usage.model}</b></footer>
                </div>
                <p className="pricing-note">{transcript.usage.pricing_basis}. Pricing can change; this estimate excludes free-tier allowances, caching, taxes, and other services.</p>
              </section>
            )}
          </section>
        )}
        <audio
          ref={audioRef}
          src={audioUrl}
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      </main>
    </div>
  );
}

export default App;
