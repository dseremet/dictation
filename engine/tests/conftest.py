"""Shared fixtures: repository glossary, a fake engine and a TestClient app."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from asr_engine.asr.types import ModelInfo, RawResult, RawSegment, RawWord, TranscribeOptions
from asr_engine.config import Settings
from asr_engine.main import create_app
from asr_engine.normalizer import Glossary, load_glossary

ENGINE_DIR = Path(__file__).resolve().parents[1]
FIXTURES = ENGINE_DIR / "tests" / "fixtures"
GLOSSARY_DIR = ENGINE_DIR / "glossary"


@pytest.fixture(scope="session")
def glossary() -> Glossary:
    return load_glossary(GLOSSARY_DIR)


class FakeEngine:
    """Returns canned segments; records the options it was called with."""

    def __init__(self, text: str = "pritisak sto dvadeset sa osamdeset tačka", language: str = "hr") -> None:
        self.text = text
        self.language = language
        self.info = ModelInfo(model="fake", device="cpu", compute_type="int8")
        self.loaded = True
        self.calls: list[TranscribeOptions] = []
        self.detect_calls = 0

    def count_tokens(self, text: str) -> int:
        return len(text.split())

    def detect_language(self, pcm: np.ndarray, allowed) -> tuple[str, float]:
        self.detect_calls += 1
        return self.language, 0.9

    def transcribe(self, pcm: np.ndarray, opts: TranscribeOptions) -> RawResult:
        self.calls.append(opts)
        duration = len(pcm) / 16000
        words = [RawWord(w, i * 0.3, i * 0.3 + 0.25, 0.9) for i, w in enumerate(self.text.split())]
        seg = RawSegment(
            id=0, seek=0, start=0.0, end=min(duration, 3.0), text=" " + self.text, tokens=[1, 2, 3],
            avg_logprob=-0.2, compression_ratio=1.1, no_speech_prob=0.05, words=words,
        )
        return RawResult([seg] if self.text else [], opts.language, 0.9, duration, duration if self.text else 0.0)


def make_settings(tmp_path: Path, **overrides) -> Settings:
    values = {
        "model": "fake",
        "glossary_dir": GLOSSARY_DIR,
        "cache_dir": tmp_path / "models",
        "tmp_dir": tmp_path / "asr-tmp",
        "api_keys": "",
        "preload": False,
        "max_upload_mb": 1,
        "max_audio_seconds": 30,
        "request_timeout_s": 20,
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def fake_engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
def client(tmp_path: Path, fake_engine: FakeEngine, glossary: Glossary):
    app = create_app(make_settings(tmp_path), engine=fake_engine, glossary=glossary)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def auth_client(tmp_path: Path, fake_engine: FakeEngine, glossary: Glossary):
    app = create_app(make_settings(tmp_path, api_keys="secret-1,secret-2"), engine=fake_engine, glossary=glossary)
    with TestClient(app) as c:
        yield c

