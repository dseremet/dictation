"""End-to-end tests with a real Whisper model (``pytest -m model``, ``ASR_MODEL=tiny`` in CI).

Skipped unless ``ASR_MODEL`` is set, so a plain ``pytest`` never downloads weights.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from asr_engine.config import Settings
from asr_engine.main import create_app
from tests.integration.speech_fixture import get_speech_clip

pytestmark = pytest.mark.model

ENGINE_DIR = Path(__file__).resolve().parents[2]
FIXTURES = ENGINE_DIR / "tests" / "fixtures"

if not os.environ.get("ASR_MODEL"):
    pytest.skip("set ASR_MODEL (e.g. tiny) to run model tests", allow_module_level=True)


@pytest.fixture(scope="module")
def live(tmp_path_factory: pytest.TempPathFactory):
    tmp = tmp_path_factory.mktemp("asr")
    settings = Settings(
        cache_dir=Path(os.environ.get("ASR_CACHE_DIR", ENGINE_DIR / "models")),
        tmp_dir=tmp,
        glossary_dir=ENGINE_DIR / "glossary",
        api_keys="",
        request_timeout_s=300,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        yield client


def post(client: TestClient, path: Path, **data):
    mime = {"wav": "audio/wav", "webm": "audio/webm", "m4a": "audio/mp4", "ogg": "audio/ogg", "mp3": "audio/mpeg"}
    with path.open("rb") as fh:
        return client.post(
            "/v1/audio/transcriptions",
            files={"file": (path.name, fh, mime.get(path.suffix[1:], "application/octet-stream"))},
            data={"response_format": "verbose_json", **data},
        )


def test_health_reports_loaded_model(live: TestClient) -> None:
    body = live.get("/health").json()
    assert body["status"] == "ok"
    assert body["device"] in {"cpu", "cuda"} and body["compute_type"]
    assert live.get("/v1/models").json()["data"][0]["id"] == os.environ["ASR_MODEL"]


def test_silence_gives_empty_text(live: TestClient) -> None:
    r = post(live, FIXTURES / "silence_5s.wav", language="hr")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["text"] == ""
    assert "no_speech" in body["x_ditactic"]["warnings"]
    assert body["x_ditactic"]["duration_after_vad"] < 0.5


def test_tone_has_valid_schema_and_restricted_language(live: TestClient) -> None:
    r = post(live, FIXTURES / "tone_10s.webm")  # language=auto
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["language"] in {"bs", "hr", "sr"}
    assert 9.5 < body["duration"] < 10.5
    assert body["x_ditactic"]["decode_language"] in {"hr", "sr"}
    assert isinstance(body["text"], str)


def test_bs_is_decoded_with_hr_token(live: TestClient) -> None:
    r = post(live, FIXTURES / "silence_5s.wav", language="bs")
    assert r.json()["x_ditactic"]["decode_language"] == "hr"
    assert r.json()["language"] == "bs"


@pytest.fixture(scope="module")
def speech_clips(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    clip, reason = get_speech_clip()
    if clip is None:
        pytest.skip(f"no public-domain speech clip available ({reason})")
    out = tmp_path_factory.mktemp("clips")
    wav = out / "speech.wav"
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(clip), "-ac", "1", "-ar", "16000", str(wav)], check=True)
    webm = out / "speech.webm"
    m4a = out / "speech.m4a"
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(wav), "-c:a", "libopus", "-b:a", "32k", str(webm)], check=True)
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(wav), "-c:a", "aac", "-b:a", "48k", str(m4a)], check=True)
    return {"wav": wav, "webm": webm, "m4a": m4a}


def _words(text: str) -> set[str]:
    return {w.strip(".,;:!?").lower() for w in text.split() if w.strip(".,;:!?")}


def test_real_speech_in_three_containers(live: TestClient, speech_clips: dict[str, Path]) -> None:
    texts = {}
    for kind, path in speech_clips.items():
        r = post(live, path, language="hr")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["text"].strip(), f"{kind}: empty transcript"
        assert body["segments"], f"{kind}: no segments"
        assert body["x_ditactic"]["raw_text"].strip()
        texts[kind] = _words(body["text"])
    base = texts["wav"]
    for kind in ("webm", "m4a"):
        overlap = len(base & texts[kind]) / max(1, len(base))
        assert overlap >= 0.5, f"{kind} transcript diverges from wav: {overlap:.2f}"


def test_real_speech_auto_language(live: TestClient, speech_clips: dict[str, Path]) -> None:
    r = post(live, speech_clips["wav"])
    assert r.status_code == 200
    assert r.json()["language"] in {"hr", "bs", "sr"}
    assert r.json()["x_ditactic"]["language_probability"] > 0
