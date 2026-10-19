from pathlib import Path

import pytest

from asr_engine.config import MODEL_ALIASES, Settings


def test_defaults() -> None:
    s = Settings()
    assert s.model == "deepdml/faster-whisper-large-v3-turbo-ct2"
    assert s.compute_type == "int8" and s.device == "auto"
    assert s.decode_map == {"bs": "hr"}
    assert s.max_upload_bytes == 50 * 1024 * 1024
    assert s.max_audio_seconds == 600
    assert s.api_key_list == []


def test_env_parsing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ASR_API_KEYS", " a , b ,")
    monkeypatch.setenv("ASR_DECODE_LANG_MAP", "bs:hr,sr:hr")
    monkeypatch.setenv("ASR_MODEL", "tiny")
    s = Settings()
    assert s.api_key_list == ["a", "b"]
    assert s.decode_map == {"bs": "hr", "sr": "hr"}
    assert s.resolve_model() == MODEL_ALIASES["tiny"]


def test_local_model_dir(tmp_path: Path) -> None:
    (tmp_path / "custom").mkdir()
    assert Settings(model=str(tmp_path / "custom")).resolve_model() == str(tmp_path / "custom")
    assert Settings(model="custom", cache_dir=tmp_path).resolve_model() == str(tmp_path / "custom")
    assert Settings(model="org/repo").resolve_model() == "org/repo"


def test_validation() -> None:
    with pytest.raises(ValueError):
        Settings(device="tpu")
    with pytest.raises(ValueError):
        Settings(default_language="de")
