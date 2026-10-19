"""Locate (or best-effort fetch) one short public-domain Croatian utterance for the model tests.

Order: ``ASR_SPEECH_FIXTURE`` env path -> ``engine/models/fixtures/speech_hr.wav`` ->
Hugging Face datasets-server (``google/fleurs`` ``hr_hr`` test, first row). The
datasets-server currently refuses FLEURS ("scan size limit exceeded"), so the
fetch usually fails and the dependent tests skip with a reason. Nothing is
ever written under ``tests/fixtures``.
"""

from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parents[2]
CACHE = ENGINE_DIR / "models" / "fixtures"
ROWS_URL = "https://datasets-server.huggingface.co/rows?dataset=google%2Ffleurs&config=hr_hr&split=test&offset=0&length=1"


def _fetch_from_datasets_server(dest: Path, timeout: int = 30) -> tuple[Path | None, str]:
    try:
        with urllib.request.urlopen(ROWS_URL, timeout=timeout) as resp:
            payload = json.load(resp)
    except Exception as exc:  # network, 4xx/5xx, bad JSON
        return None, f"datasets-server unreachable: {type(exc).__name__}"
    if "error" in payload:
        return None, f"datasets-server refused FLEURS: {str(payload['error'])[:80]}"
    try:
        row = payload["rows"][0]["row"]
        audio = row["audio"][0]["src"] if isinstance(row["audio"], list) else row["audio"]["src"]
        transcript = row.get("transcription") or row.get("raw_transcription") or ""
    except (KeyError, IndexError, TypeError) as exc:
        return None, f"unexpected datasets-server payload: {exc}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(audio, timeout=timeout) as resp, dest.open("wb") as fh:
            fh.write(resp.read())
        dest.with_suffix(".txt").write_text(transcript, encoding="utf-8")
    except Exception as exc:
        dest.unlink(missing_ok=True)
        return None, f"audio download failed: {type(exc).__name__}"
    return dest, "fetched from datasets-server"


def get_speech_clip() -> tuple[Path | None, str]:
    """Return ``(path, reason)``; ``path`` is ``None`` when no clip is available."""
    env = os.environ.get("ASR_SPEECH_FIXTURE")
    if env:
        p = Path(env)
        return (p, "ASR_SPEECH_FIXTURE") if p.is_file() else (None, f"ASR_SPEECH_FIXTURE not found: {p}")
    for candidate in sorted(CACHE.glob("speech_hr.*")) if CACHE.is_dir() else []:
        if candidate.suffix in {".wav", ".flac", ".mp3", ".ogg", ".webm", ".m4a"}:
            return candidate, "cached"
    if os.environ.get("HF_HUB_OFFLINE", "0") in {"1", "true"}:
        return None, "offline and no cached speech clip"
    return _fetch_from_datasets_server(CACHE / "speech_hr.wav")
