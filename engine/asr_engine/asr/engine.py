"""faster-whisper wrapper: model resolution/loading, decoding, concurrency slots."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from collections.abc import Iterable

import numpy as np

from asr_engine.asr.types import ModelInfo, RawResult, RawSegment, RawWord, TranscribeOptions
from asr_engine.config import SUPPORTED_LANGUAGES, Settings

log = logging.getLogger("asr.engine")

CPU_FALLBACKS = ("int8", "int8_float32", "float32")
CUDA_FALLBACKS = ("float16", "int8_float16", "int8", "float32")
VAD_PARAMETERS = {"threshold": 0.5, "min_silence_duration_ms": 700, "speech_pad_ms": 300}


class SlotsFullError(Exception):
    """Too many requests waiting for a decoding slot."""


class Slot:
    """A held decoding slot. ``release`` is idempotent."""

    def __init__(self, owner: Slots) -> None:
        self._owner = owner
        self._released = False

    def release(self) -> None:
        if not self._released:
            self._released = True
            self._owner.inflight -= 1
            self._owner._sem.release()


class Slots:
    """Bounded semaphore with a bounded wait queue (``503`` instead of unbounded latency)."""

    def __init__(self, concurrency: int, queue_depth: int) -> None:
        self._sem = asyncio.Semaphore(max(1, concurrency))
        self._queue_depth = max(0, queue_depth)
        self.concurrency = max(1, concurrency)
        self.waiting = 0
        self.inflight = 0

    async def acquire(self) -> Slot:
        if self._sem.locked() and self.waiting >= self._queue_depth:
            raise SlotsFullError()
        self.waiting += 1
        try:
            await self._sem.acquire()
        finally:
            self.waiting -= 1
        self.inflight += 1
        return Slot(self)


def pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import ctranslate2

        return "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    except Exception:  # pragma: no cover - defensive
        return "cpu"


def pick_compute_type(requested: str, device: str) -> str:
    """Requested type if the backend supports it, else the first supported fallback."""
    try:
        import ctranslate2

        supported = set(ctranslate2.get_supported_compute_types(device))
    except Exception:  # pragma: no cover - defensive
        return requested
    if requested in supported:
        return requested
    for candidate in CUDA_FALLBACKS if device == "cuda" else CPU_FALLBACKS:
        if candidate in supported:
            log.warning("compute_type %s unsupported on %s, using %s", requested, device, candidate)
            return candidate
    return requested


class AsrEngine:
    """One loaded Whisper model. Thread-safe for concurrent ``transcribe`` calls (CT2 handles it)."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._model = None
        self._lock = threading.Lock()
        self.info = ModelInfo(model=settings.model, device="?", compute_type="?")
        self.loaded_at: float | None = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        from faster_whisper import WhisperModel

        s = self.settings
        model_id = s.resolve_model()
        device = pick_device(s.device)
        compute = pick_compute_type(s.compute_type, device)
        s.cache_dir.mkdir(parents=True, exist_ok=True)
        log.info("loading model=%s device=%s compute=%s cache=%s", model_id, device, compute, s.cache_dir)
        t0 = time.monotonic()
        offline = os.environ.get("HF_HUB_OFFLINE", "0") in {"1", "true", "True"}
        with self._lock:
            self._model = WhisperModel(
                model_id,
                device=device,
                compute_type=compute,
                cpu_threads=s.cpu_threads,
                num_workers=s.num_workers,
                download_root=str(s.cache_dir),
                local_files_only=offline,
            )
        self.info = ModelInfo(model=s.model, device=device, compute_type=compute)
        self.loaded_at = time.time()
        log.info("model ready in %.1fs", time.monotonic() - t0)

    # -- helpers -------------------------------------------------------------------------

    def count_tokens(self, text: str) -> int:
        if self._model is None:
            from asr_engine.asr.prompt import heuristic_token_count

            return heuristic_token_count(text)
        return len(self._model.hf_tokenizer.encode(text, add_special_tokens=False).ids)

    def detect_language(self, pcm: np.ndarray, allowed: Iterable[str] = SUPPORTED_LANGUAGES) -> tuple[str, float]:
        """Most probable language among ``allowed`` (falls back to the first allowed one)."""
        assert self._model is not None, "model not loaded"
        from faster_whisper.vad import VadOptions

        allowed_set = set(allowed)
        _, _, all_probs = self._model.detect_language(
            audio=pcm, vad_filter=True, vad_parameters=VadOptions(**VAD_PARAMETERS), language_detection_segments=2
        )
        best = [(lang, p) for lang, p in all_probs if lang in allowed_set]
        if not best:
            return sorted(allowed_set)[0], 0.0
        lang, prob = max(best, key=lambda x: x[1])
        return lang, float(prob)

    def transcribe(self, pcm: np.ndarray, opts: TranscribeOptions) -> RawResult:
        from faster_whisper.vad import VadOptions

        assert self._model is not None, "model not loaded"
        segments_iter, info = self._model.transcribe(
            pcm,
            language=opts.language,
            task="transcribe",
            beam_size=opts.beam_size,
            best_of=opts.best_of,
            temperature=list(opts.temperature),
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
            condition_on_previous_text=False,
            initial_prompt=opts.initial_prompt or None,
            hotwords=opts.hotwords or None,
            word_timestamps=opts.word_timestamps,
            vad_filter=True,
            vad_parameters=VadOptions(**VAD_PARAMETERS),
            hallucination_silence_threshold=2.0 if opts.word_timestamps else None,
        )
        segments: list[RawSegment] = []
        for seg in segments_iter:
            words = [
                RawWord(word=w.word, start=float(w.start), end=float(w.end), probability=float(w.probability))
                for w in (seg.words or [])
            ]
            segments.append(
                RawSegment(
                    id=int(seg.id),
                    seek=int(seg.seek),
                    start=float(seg.start),
                    end=float(seg.end),
                    text=seg.text,
                    tokens=list(seg.tokens or []),
                    temperature=float(seg.temperature or 0.0),
                    avg_logprob=float(seg.avg_logprob),
                    compression_ratio=float(seg.compression_ratio),
                    no_speech_prob=float(seg.no_speech_prob),
                    words=words,
                )
            )
        return RawResult(
            segments=segments,
            language=str(info.language),
            language_probability=float(info.language_probability or 0.0),
            duration=float(info.duration),
            duration_after_vad=float(info.duration_after_vad if info.duration_after_vad is not None else info.duration),
        )
