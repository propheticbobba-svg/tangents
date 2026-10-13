import { useEffect, useRef, useState } from "react";
import { transcribe } from "./api";
import { concatFloat32, encodeWav, hasSpeech, resample } from "./dictation";

export type DictationPhase = "idle" | "listening" | "transcribing";

type Session = {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  gain: GainNode;
  chunks: Float32Array[];
  timer: number;
  aborted: boolean;
};

function micError(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  if (name === "NotAllowedError") return "Microphone access was denied.";
  if (name === "NotFoundError") return "No microphone was found.";
  return "Could not open the microphone.";
}

export function MicButtonView({
  listening,
  busy,
  disabled,
  onClick,
}: {
  listening: boolean;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = busy ? "Transcribing" : listening ? "Stop dictating" : "Dictate";
  return (
    <button
      type="button"
      className={`grid h-8 w-8 place-items-center rounded-md disabled:opacity-40 ${
        listening ? "mic-live" : "mic-idle"
      }`}
      aria-label={label}
      title={label}
      aria-pressed={listening}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={onClick}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
        <path d="M19 11a7 7 0 0 1-14 0" />
        <path d="M12 18v3" />
      </svg>
    </button>
  );
}

export function MicButton({
  disabled,
  onText,
  onError,
  onPhase,
}: {
  disabled: boolean;
  onText: (spoken: string) => void;
  onError: (message: string) => void;
  onPhase: (phase: DictationPhase) => void;
}) {
  const sessionRef = useRef<Session | null>(null);
  const phaseRef = useRef<DictationPhase>("idle");
  const startingRef = useRef(false);
  const generationRef = useRef(0);
  const [phase, setPhaseState] = useState<DictationPhase>("idle");
  const onTextRef = useRef(onText);
  const onErrorRef = useRef(onError);
  const onPhaseRef = useRef(onPhase);
  onTextRef.current = onText;
  onErrorRef.current = onError;
  onPhaseRef.current = onPhase;

  function setPhase(next: DictationPhase) {
    phaseRef.current = next;
    setPhaseState(next);
    onPhaseRef.current(next);
  }

  async function release(session: Session) {
    window.clearTimeout(session.timer);
    session.processor.onaudioprocess = null;
    session.processor.disconnect();
    session.gain.disconnect();
    session.source.disconnect();
    for (const track of session.stream.getTracks()) track.stop();
    if (session.context.state !== "closed") await session.context.close();
  }

  async function finish() {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    const { chunks, context, aborted } = session;
    await release(session);
    if (aborted) {
      setPhase("idle");
      return;
    }
    const samples = resample(concatFloat32(chunks), context.sampleRate, 16000);
    if (!hasSpeech(samples)) {
      onErrorRef.current("No speech detected.");
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    try {
      const { text } = await transcribe(encodeWav(samples, 16000));
      if (!text) onErrorRef.current("No speech detected.");
      else onTextRef.current(text);
    } catch (err) {
      onErrorRef.current(err instanceof Error ? err.message : "Could not transcribe that recording");
    }
    setPhase("idle");
  }

  function abort() {
    generationRef.current += 1;
    startingRef.current = false;
    const session = sessionRef.current;
    if (!session) {
      if (phaseRef.current === "listening") setPhase("idle");
      return;
    }
    session.aborted = true;
    sessionRef.current = null;
    void release(session).then(() => setPhase("idle"));
  }

  async function start() {
    if (startingRef.current || phaseRef.current !== "idle") return;
    startingRef.current = true;
    const generation = generationRef.current;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      startingRef.current = false;
      onErrorRef.current(micError(err));
      setPhase("idle");
      return;
    }
    if (generation !== generationRef.current) {
      for (const track of stream.getTracks()) track.stop();
      startingRef.current = false;
      return;
    }
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const gain = context.createGain();
    gain.gain.value = 0;
    const chunks: Float32Array[] = [];
    processor.onaudioprocess = (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(gain);
    gain.connect(context.destination);
    const session: Session = {
      stream,
      context,
      source,
      processor,
      gain,
      chunks,
      timer: window.setTimeout(() => void finish(), 120000),
      aborted: false,
    };
    sessionRef.current = session;
    startingRef.current = false;
    setPhase("listening");
  }

  useEffect(() => {
    if (disabled && phaseRef.current === "listening") abort();
  }, [disabled]);

  useEffect(() => {
    return () => abort();
  }, []);

  return (
    <MicButtonView
      listening={phase === "listening"}
      busy={phase === "transcribing"}
      disabled={disabled}
      onClick={() => {
        if (startingRef.current) return;
        if (phaseRef.current === "listening") {
          void finish();
          return;
        }
        if (phaseRef.current !== "idle") return;
        void start();
      }}
    />
  );
}
