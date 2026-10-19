"""HTTP contract with a fake engine: auth, limits, formats, extension block."""

from __future__ import annotations

from pathlib import Path

import pytest

from asr_engine.audio.decode import ffmpeg_available
from asr_engine.auth import token_allowed

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
needs_ffmpeg = pytest.mark.skipif(not ffmpeg_available(), reason="ffmpeg not installed")


def upload(name: str = "tone_10s.webm", mime: str = "audio/webm"):
    return {"file": (name, (FIXTURES / name).read_bytes(), mime)}


def test_health_and_models(client) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["model"] == "fake" and body["glossary_version"]
    r = client.get("/v1/models")
    assert r.status_code == 200
    assert r.json()["data"][0]["id"] == "fake"


def test_docs_disabled_by_default(client) -> None:
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_auth_required_when_keys_set(auth_client) -> None:
    r = auth_client.get("/v1/models")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "invalid_api_key"
    assert auth_client.get("/v1/models", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert auth_client.get("/v1/models", headers={"Authorization": "Bearer secret-2"}).status_code == 200
    assert auth_client.get("/health").status_code == 200  # health stays open


def test_token_allowed() -> None:
    assert token_allowed(None, [])
    assert not token_allowed(None, ["a"])
    assert token_allowed("b", ["a", "b"])
    assert not token_allowed("c", ["a", "b"])


def test_415_for_unknown_container(client) -> None:
    r = client.post("/v1/audio/transcriptions", files={"file": ("x.txt", b"hello world, not audio", "text/plain")})
    assert r.status_code == 415
    assert r.json()["error"]["code"] == "unsupported_media_type"


def test_400_for_empty_file(client) -> None:
    r = client.post("/v1/audio/transcriptions", files={"file": ("x.webm", b"", "audio/webm")})
    assert r.status_code == 400


def test_413_for_oversized_upload(client) -> None:
    big = b"\x1a\x45\xdf\xa3" + b"\x00" * (1024 * 1024 + 10)  # > 1 MB test limit
    r = client.post("/v1/audio/transcriptions", files={"file": ("big.webm", big, "audio/webm")})
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "file_too_large"


def test_422_for_bad_params(client) -> None:
    assert client.post("/v1/audio/transcriptions", files=upload(), data={"language": "de"}).status_code == 422
    assert client.post("/v1/audio/transcriptions", files=upload(), data={"response_format": "srt"}).status_code == 422
    assert client.post("/v1/audio/transcriptions", files=upload(), data={"glossary": "{not json"}).status_code == 422
    assert client.post("/v1/audio/transcriptions", files=upload(), data={"temperature": "5"}).status_code == 422
    r = client.post("/v1/audio/transcriptions", data={"language": "hr"})
    assert r.status_code == 422 and r.json()["error"]["type"] == "invalid_request_error"


@needs_ffmpeg
def test_json_default_is_normalised(client, fake_engine) -> None:
    r = client.post("/v1/audio/transcriptions", files=upload(), data={"language": "bs"})
    assert r.status_code == 200
    assert r.json() == {"text": "Pritisak 120/80."}
    opts = fake_engine.calls[-1]
    assert opts.language == "hr"  # ASR_DECODE_LANG_MAP=bs:hr
    assert opts.hotwords and "," in opts.hotwords
    assert opts.initial_prompt.startswith("Ljekarski nalaz")


@needs_ffmpeg
def test_verbose_json_extension_block(client) -> None:
    r = client.post(
        "/v1/audio/transcriptions",
        files=upload("tone_10s.m4a", "audio/mp4"),
        data={"language": "hr", "response_format": "verbose_json", "timestamp_granularities[]": ["word", "segment"]},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["task"] == "transcribe" and body["language"] == "hr"
    assert 9.5 < body["duration"] < 10.5
    assert body["text"] == "Pritisak 120/80."
    assert body["segments"][0]["text"] == "pritisak sto dvadeset sa osamdeset tačka"
    assert body["words"][0]["word"] == "pritisak"
    x = body["x_ditactic"]
    assert x["raw_text"] == "pritisak sto dvadeset sa osamdeset tačka"
    assert x["normalized"] is True and x["decode_language"] == "hr" and x["model"] == "fake"
    assert x["glossary_version"] and isinstance(x["warnings"], list) and x["processing_ms"] >= 0


@needs_ffmpeg
def test_text_format_and_normalize_off(client) -> None:
    r = client.post("/v1/audio/transcriptions", files=upload("tone_10s.wav", "audio/wav"), data={"response_format": "text", "language": "hr"})
    assert r.status_code == 200 and r.text == "Pritisak 120/80.\n"
    r = client.post("/v1/audio/transcriptions", files=upload(), data={"language": "hr", "normalize": "false", "response_format": "verbose_json"})
    assert r.json()["text"] == "pritisak sto dvadeset sa osamdeset tačka"
    assert r.json()["x_ditactic"]["normalized"] is False


@needs_ffmpeg
def test_auto_language_uses_detection(client, fake_engine) -> None:
    fake_engine.language = "sr"
    r = client.post("/v1/audio/transcriptions", files=upload(), data={"response_format": "verbose_json"})
    assert r.status_code == 200
    assert fake_engine.detect_calls == 1
    assert r.json()["language"] == "sr"
    assert fake_engine.calls[-1].language == "sr"


@needs_ffmpeg
def test_request_glossary_merges(client, fake_engine) -> None:
    fake_engine.text = "aplikovan botoks"
    r = client.post(
        "/v1/audio/transcriptions",
        files=upload(),
        data={"language": "bs", "glossary": '[{"canonical": "Botox", "variants": ["botoks"]}]'},
    )
    assert r.json()["text"] == "Aplikovan Botox"
    assert fake_engine.calls[-1].hotwords.startswith("Botox")


@needs_ffmpeg
def test_prompt_is_forwarded(client, fake_engine) -> None:
    client.post("/v1/audio/transcriptions", files=upload(), data={"language": "hr", "prompt": "Dermatologija"})
    assert "Dermatologija" in fake_engine.calls[-1].initial_prompt


@needs_ffmpeg
def test_413_for_audio_longer_than_limit(tmp_path, fake_engine, glossary) -> None:
    from fastapi.testclient import TestClient

    from asr_engine.main import create_app
    from tests.conftest import make_settings

    app = create_app(make_settings(tmp_path, max_audio_seconds=5), engine=fake_engine, glossary=glossary)
    with TestClient(app) as c:
        r = c.post("/v1/audio/transcriptions", files=upload("tone_10s.wav", "audio/wav"))
    assert r.status_code == 413 and r.json()["error"]["code"] == "audio_too_long"


@needs_ffmpeg
def test_no_speech_returns_empty_text(client, fake_engine) -> None:
    fake_engine.text = ""
    r = client.post("/v1/audio/transcriptions", files=upload("silence_5s.wav", "audio/wav"), data={"response_format": "verbose_json", "language": "hr"})
    assert r.status_code == 200
    assert r.json()["text"] == ""
    assert "no_speech" in r.json()["x_ditactic"]["warnings"]


@needs_ffmpeg
def test_tmp_dir_is_cleaned(client, tmp_path) -> None:
    client.post("/v1/audio/transcriptions", files=upload(), data={"language": "hr"})
    assert list((tmp_path / "asr-tmp").iterdir()) == []


def test_503_while_loading(tmp_path, glossary) -> None:
    from fastapi.testclient import TestClient

    from asr_engine.main import create_app
    from tests.conftest import FakeEngine, make_settings

    engine = FakeEngine()
    engine.loaded = False
    app = create_app(make_settings(tmp_path), engine=engine, glossary=glossary)
    with TestClient(app) as c:
        assert c.get("/health").status_code == 503
        r = c.post("/v1/audio/transcriptions", files=upload())
        assert r.status_code == 503 and r.headers.get("retry-after")
