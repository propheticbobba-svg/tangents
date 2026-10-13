"""Local Parakeet transcription. The model is loaded on first use."""

from __future__ import annotations

import logging
import threading
import wave
from concurrent.futures import ThreadPoolExecutor

import numpy as np

logger = logging.getLogger("tangents")

MODEL_ID = "mlx-community/parakeet-tdt-0.6b-v3"
TRANSCRIBE_MAX_BYTES = 8 * 1024 * 1024

_executor: ThreadPoolExecutor | None = None
_executor_lock = threading.Lock()
_model = None


class UnsupportedAudio(Exception):
    pass


class SpeechError(Exception):
    pass


def speech_executor() -> ThreadPoolExecutor:
    global _executor
    with _executor_lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="parakeet")
        return _executor


def validate_wav(data: bytes) -> None:
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise UnsupportedAudio("Send a WAV recording.")


def read_wav_mono(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise UnsupportedAudio("Send a WAV recording.")
        rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, rate


def _resample(samples: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    if from_rate == to_rate:
        return samples
    ratio = from_rate / to_rate
    length = int(round(len(samples) / ratio))
    src = np.arange(length) * ratio
    i0 = np.floor(src).astype(np.int64)
    i1 = np.minimum(i0 + 1, len(samples) - 1)
    frac = (src - i0).astype(np.float32)
    return samples[i0] * (1.0 - frac) + samples[i1] * frac


def transcribe_wav(path: str) -> str:
    global _model
    try:
        if _model is None:
            from parakeet_mlx import from_pretrained

            _model = from_pretrained(MODEL_ID)
        import mlx.core as mx
        from parakeet_mlx.audio import get_logmel

        samples, rate = read_wav_mono(path)
        target_rate = _model.preprocessor_config.sample_rate
        samples = _resample(samples, rate, target_rate)
        mel = get_logmel(mx.array(samples), _model.preprocessor_config)
        return (_model.generate(mel)[0].text or "").strip()
    except Exception:
        logger.exception("Parakeet transcription failed")
        raise SpeechError("Could not transcribe that recording") from None
