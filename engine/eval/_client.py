"""Transcription backends shared by run_fleurs.py and run_private.py."""

from __future__ import annotations

import io
import json
import sys
import urllib.request
import wave
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def pcm_to_wav_bytes(array: np.ndarray, rate: int) -> bytes:
    pcm16 = (np.clip(array, -1, 1) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()


class HttpBackend:
    """Talks to a running engine (or any OpenAI-compatible server)."""

    def __init__(self, url: str, api_key: str | None, normalize: bool = True) -> None:
        self.url = url.rstrip("/") + "/v1/audio/transcriptions"
        self.api_key = api_key
        self.normalize = normalize

    def transcribe(self, wav_bytes: bytes, language: str) -> dict[str, Any]:
        boundary = "----ditacticEval"
        fields = {"language": language, "response_format": "verbose_json", "normalize": "true" if self.normalize else "false"}
        body = io.BytesIO()
        for k, v in fields.items():
            body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
        body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode())
        body.write(wav_bytes)
        body.write(f"\r\n--{boundary}--\r\n".encode())
        req = urllib.request.Request(self.url, data=body.getvalue(), method="POST")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        if self.api_key:
            req.add_header("Authorization", f"Bearer {self.api_key}")
        with urllib.request.urlopen(req, timeout=900) as resp:
            return json.load(resp)


class LocalBackend:
    """Loads the model in-process (same code path as the server, no HTTP)."""

    def __init__(self, model: str, compute_type: str = "int8", normalize: bool = True) -> None:
        from asr_engine.asr.engine import AsrEngine
        from asr_engine.asr.prompt import STYLE_HEADERS, build_hotwords
        from asr_engine.config import Settings
        from asr_engine.normalizer import load_glossary

        self.settings = Settings(model=model, compute_type=compute_type)
        self.engine = AsrEngine(self.settings)
        self.engine.load()
        self.glossary = load_glossary(self.settings.glossary_dir)
        self.headers = STYLE_HEADERS
        self.hotwords = build_hotwords(self.glossary.prompt_terms(), self.engine.count_tokens, self.settings.hotwords_token_budget)
        self.normalize = normalize

    def transcribe(self, wav_bytes: bytes, language: str) -> dict[str, Any]:
        from asr_engine.asr.guards import apply_guards
        from asr_engine.asr.types import TranscribeOptions
        from asr_engine.normalizer import normalize

        with wave.open(io.BytesIO(wav_bytes)) as w:
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
        decode_lang = self.settings.decode_map.get(language, language)
        opts = TranscribeOptions(language=decode_lang, initial_prompt=self.headers[language], hotwords=self.hotwords,
                                 beam_size=self.settings.beam_size, best_of=self.settings.best_of)
        result = self.engine.transcribe(pcm, opts)
        guarded = apply_guards(result.segments, speech_seconds=result.duration_after_vad, hallucinations=self.glossary.hallucinations_for(language))
        raw = " ".join(s.text.strip() for s in guarded.segments)
        text = normalize(raw, language, self.glossary) if self.normalize else raw
        return {"text": text, "x_ditactic": {"raw_text": raw, "warnings": guarded.warnings}}


def make_backend(args) -> HttpBackend | LocalBackend:
    if args.engine_url:
        return HttpBackend(args.engine_url, args.api_key, normalize=not args.raw)
    return LocalBackend(args.model, args.compute_type, normalize=not args.raw)
