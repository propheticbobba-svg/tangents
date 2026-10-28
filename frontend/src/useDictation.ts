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

const MAX_RECORDING_MS = 120000;

function micError(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  if (name === "NotAllowedError") return "Microphone access was denied.";
  if (name === "NotFoundError") return "No microphone was found.";
  return "Could not open the microphone.";
}

/**
 * Records from the mic, transcribes locally, then runs `process` on the text.
 * The phase stays "transcribing" until `process` settles. Turning `disabled` on
 * while listening discards the recording. Nothing is delivered after unmount.
 */
export function useDictation<T>({
  disabled,
  process,
  onResult,
  onError,
  onPhase,
}: {
  disabled: boolean;
  process: (spoken: string) => Promise<T>;
  onResult: (result: T) => void;
  onError: (message: string) => void;
  onPhase?: (phase: DictationPhase) => void;
}): { phase: DictationPhase; toggle: () => void; abort: () => void } {
  const sessionRef = useRef<Session | null>(null);
  const phaseRef = useRef<DictationPhase>("idle");
  const startingRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const [phase, setPhaseState] = useState<DictationPhase>("idle");
  const processRef = useRef(process);
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  const onPhaseRef = useRef(onPhase);
  processRef.current = process;
  onResultRef.current = onResult;
  onErrorRef.current = onError;
  onPhaseRef.current = onPhase;

  function setPhase(next: DictationPhase) {
    phaseRef.current = next;
    if (mountedRef.current) setPhaseState(next);
    // Still reported after unmount, so an owner's "listening" state is released.
    onPhaseRef.current?.(next);
  }

  function reportError(message: string) {
    if (mountedRef.current) onErrorRef.current(message);
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
      reportError("No speech detected.");
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    try {
      const { text } = await transcribe(encodeWav(samples, 16000));
      if (!text) {
        reportError("No speech detected.");
      } else {
        const result = await processRef.current(text);
        if (mountedRef.current) onResultRef.current(result);
      }
    } catch (err) {
      reportError(err instanceof Error ? err.message : "Could not transcribe that recording");
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
      reportError(micError(err));
      setPhase("idle");
      return;
    }
    if (generation !== generationRef.current || !mountedRef.current) {
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
      timer: window.setTimeout(() => void finish(), MAX_RECORDING_MS),
      aborted: false,
    };
    sessionRef.current = session;
    startingRef.current = false;
    setPhase("listening");
  }

  function toggle() {
    if (startingRef.current) return;
    if (phaseRef.current === "listening") {
      void finish();
      return;
    }
    if (phaseRef.current !== "idle") return;
    void start();
  }

  useEffect(() => {
    if (disabled && phaseRef.current === "listening") abort();
  }, [disabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      abort();
      mountedRef.current = false;
    };
  }, []);

  return { phase, toggle, abort };
}
