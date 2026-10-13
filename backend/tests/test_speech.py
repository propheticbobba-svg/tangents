"""WAV checks and the transcribe route. Never loads Parakeet."""

import pytest
from fastapi.testclient import TestClient

import wave

import numpy as np

from app.speech import SpeechError, UnsupportedAudio, read_wav_mono, validate_wav


def minimal_wav(extra: bytes = b"") -> bytes:
    data_size = len(extra)
    header = bytearray(44)
    header[0:4] = b"RIFF"
    header[4:8] = (36 + data_size).to_bytes(4, "little")
    header[8:12] = b"WAVE"
    header[12:16] = b"fmt "
    header[16:20] = (16).to_bytes(4, "little")
    header[20:22] = (1).to_bytes(2, "little")
    header[22:24] = (1).to_bytes(2, "little")
    header[24:28] = (16000).to_bytes(4, "little")
    header[28:32] = (32000).to_bytes(4, "little")
    header[32:34] = (2).to_bytes(2, "little")
    header[34:36] = (16).to_bytes(2, "little")
    header[36:40] = b"data"
    header[40:44] = data_size.to_bytes(4, "little")
    return bytes(header) + extra


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TANGENTS_DB", str(tmp_path / "tangents.db"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_MODEL", "")
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


def test_validate_wav_accepts_header():
    validate_wav(minimal_wav())


def test_validate_wav_rejects_garbage():
    with pytest.raises(UnsupportedAudio, match="Send a WAV recording"):
        validate_wav(b"not a wav")


def test_validate_wav_rejects_short_buffer():
    with pytest.raises(UnsupportedAudio, match="Send a WAV recording"):
        validate_wav(b"RIFF")


def test_read_wav_mono_returns_float_samples(tmp_path):
    path = tmp_path / "clip.wav"
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(np.array([0, 32767, -32767], dtype=np.int16).tobytes())
    samples, rate = read_wav_mono(str(path))
    assert rate == 16000
    np.testing.assert_allclose(samples, [0.0, 32767 / 32768.0, -32767 / 32768.0])


def test_validate_wav_rejects_riff_without_wave():
    data = bytearray(44)
    data[0:4] = b"RIFF"
    data[8:12] = b"XXXX"
    with pytest.raises(UnsupportedAudio, match="Send a WAV recording"):
        validate_wav(bytes(data))


def test_transcribe_returns_text(client: TestClient, monkeypatch):
    monkeypatch.setattr("app.speech.transcribe_wav", lambda path: "hello there")
    response = client.post(
        "/api/transcribe",
        files={"audio": ("dictation.wav", minimal_wav(), "audio/wav")},
    )
    assert response.status_code == 200
    assert response.json() == {"text": "hello there"}


def test_transcribe_rejects_non_wav(client: TestClient):
    response = client.post(
        "/api/transcribe",
        files={"audio": ("dictation.wav", b"nope", "audio/wav")},
    )
    assert response.status_code == 400
    assert response.json() == {"detail": "Send a WAV recording."}


def test_transcribe_rejects_oversize(client: TestClient):
    response = client.post(
        "/api/transcribe",
        files={"audio": ("dictation.wav", b"x" * (8 * 1024 * 1024 + 1), "audio/wav")},
    )
    assert response.status_code == 413
    assert response.json() == {"detail": "Recording is larger than 8 MB"}


def test_transcribe_maps_speech_error(client: TestClient, monkeypatch):
    def boom(_path: str) -> str:
        raise SpeechError("fail")

    monkeypatch.setattr("app.speech.transcribe_wav", boom)
    response = client.post(
        "/api/transcribe",
        files={"audio": ("dictation.wav", minimal_wav(), "audio/wav")},
    )
    assert response.status_code == 503
    assert response.json() == {"detail": "Could not transcribe that recording"}
