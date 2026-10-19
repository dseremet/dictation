"""``POST /v1/audio/transcriptions`` (multipart, OpenAI-compatible)."""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
import uuid
from pathlib import Path
from typing import Annotated

import numpy as np
from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

from asr_engine.api.errors import ApiError
from asr_engine.api.schemas import (
    RESPONSE_FORMATS,
    SegmentOut,
    TranscriptionJson,
    TranscriptionVerbose,
    WordOut,
    XDitactic,
)
from asr_engine.asr.engine import SlotsFullError
from asr_engine.asr.guards import apply_guards
from asr_engine.asr.prompt import build_hotwords, build_initial_prompt
from asr_engine.asr.types import RawResult, TranscribeOptions
from asr_engine.audio.decode import DecodeError, DecodeTimeoutError, decode_to_pcm, duration_seconds
from asr_engine.audio.sniff import ALLOWED_KINDS, extension_for, sniff
from asr_engine.auth import require_api_key
from asr_engine.config import SUPPORTED_LANGUAGES
from asr_engine.normalizer import normalize

log = logging.getLogger("asr.api")
router = APIRouter(dependencies=[Depends(require_api_key)])

CHUNK = 1024 * 1024


def _parse_language(value: str | None, default: str) -> str:
    lang = (value or default or "auto").strip().lower()
    if lang in {"", "auto"}:
        return "auto"
    if lang not in SUPPORTED_LANGUAGES:
        raise ApiError(422, "language must be one of bs, hr, sr or auto", code="unsupported_language", param="language")
    return lang


def _parse_glossary(raw: str | None) -> list:
    if raw is None or not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ApiError(422, "glossary must be a JSON array", code="invalid_value", param="glossary") from exc
    if not isinstance(data, list):
        raise ApiError(422, "glossary must be a JSON array", code="invalid_value", param="glossary")
    return data


def _temperatures(value: float | None) -> tuple[float, ...]:
    if value is None:
        return (0.0, 0.2, 0.4)
    if not 0.0 <= value <= 1.0:
        raise ApiError(422, "temperature must be between 0 and 1", code="invalid_value", param="temperature")
    return tuple(min(1.0, round(value + step, 2)) for step in (0.0, 0.2, 0.4))


async def _save_upload(file: UploadFile, dest: Path, limit: int) -> int:
    size = 0
    with dest.open("wb") as out:
        while True:
            chunk = await file.read(CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise ApiError(413, f"file exceeds {limit // (1024 * 1024)} MB", code="file_too_large", param="file")
            out.write(chunk)
    return size


def _join_text(result: RawResult) -> str:
    return " ".join(s.text.strip() for s in result.segments if s.text.strip())


@router.post("/v1/audio/transcriptions", response_model=None)
async def create_transcription(
    request: Request,
    file: Annotated[UploadFile, File()],
    model: Annotated[str | None, Form()] = None,
    language: Annotated[str | None, Form()] = None,
    prompt: Annotated[str | None, Form()] = None,
    response_format: Annotated[str, Form()] = "json",
    temperature: Annotated[float | None, Form()] = None,
    timestamp_granularities: Annotated[list[str] | None, Form(alias="timestamp_granularities[]")] = None,
    timestamp_granularities_plain: Annotated[list[str] | None, Form(alias="timestamp_granularities")] = None,
    glossary: Annotated[str | None, Form()] = None,
    normalize_text: Annotated[bool, Form(alias="normalize")] = True,
) -> JSONResponse | PlainTextResponse:
    state = request.app.state
    settings = state.settings
    if not getattr(state, "ready", False):
        raise ApiError(503, "model is loading", error_type="server_error", code="loading", headers={"Retry-After": "30"})
    if response_format not in RESPONSE_FORMATS:
        raise ApiError(422, "response_format must be json, verbose_json or text", code="invalid_value", param="response_format")
    requested_language = _parse_language(language, settings.default_language)
    request_terms = _parse_glossary(glossary)
    temps = _temperatures(temperature)
    granularities = set(timestamp_granularities or []) | set(timestamp_granularities_plain or [])
    want_words = "word" in granularities
    _ = model  # accepted for compatibility; this server serves exactly one model

    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > settings.max_upload_bytes + CHUNK:
        raise ApiError(413, f"file exceeds {settings.max_upload_mb} MB", code="file_too_large", param="file")

    started = time.monotonic()
    work_dir = settings.tmp_dir / uuid.uuid4().hex
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        raw_path = work_dir / "upload.bin"
        size = await _save_upload(file, raw_path, settings.max_upload_bytes)
        if size == 0:
            raise ApiError(400, "file is empty", code="empty_file", param="file")
        with raw_path.open("rb") as fh:
            kind = sniff(fh.read(16))
        if kind is None or kind not in ALLOWED_KINDS:
            raise ApiError(415, "unsupported audio container (expected webm, mp4/m4a, wav, ogg, mp3 or flac)", code="unsupported_media_type", param="file")
        audio_path = raw_path.with_suffix("." + extension_for(kind))
        raw_path.rename(audio_path)

        try:
            pcm = await asyncio.to_thread(
                decode_to_pcm, audio_path, max_seconds=settings.max_audio_seconds, timeout_s=settings.ffmpeg_timeout_s
            )
        except DecodeTimeoutError as exc:
            raise ApiError(504, "audio decoding timed out", error_type="server_error", code="decode_timeout") from exc
        except DecodeError as exc:
            raise ApiError(400, f"could not decode audio: {exc}", code="invalid_audio", param="file") from exc
        audio_path.unlink(missing_ok=True)

        duration = duration_seconds(pcm)
        if duration > settings.max_audio_seconds:
            raise ApiError(413, f"audio longer than {settings.max_audio_seconds} s", code="audio_too_long", param="file")

        result, decode_lang, user_lang, lang_prob = await _run_decoding(
            request, pcm, requested_language, prompt, request_terms, temps
        )
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    glossary_obj = state.glossary.with_request_terms(request_terms) if request_terms else state.glossary
    guarded = apply_guards(
        result.segments,
        speech_seconds=result.duration_after_vad,
        hallucinations=glossary_obj.hallucinations_for(user_lang),
        min_speech_seconds=settings.min_speech_seconds,
    )
    result.segments = guarded.segments
    raw_text = _join_text(result)
    text = normalize(raw_text, user_lang, glossary_obj) if normalize_text else raw_text
    processing_ms = int((time.monotonic() - started) * 1000)
    log.info(
        "transcribed lang=%s decode=%s duration=%.1fs speech=%.1fs segments=%d warnings=%d ms=%d",
        user_lang, decode_lang, duration, result.duration_after_vad, len(result.segments), len(guarded.warnings), processing_ms,
    )

    if response_format == "text":
        return PlainTextResponse(text + ("\n" if text else ""))
    if response_format == "json":
        return JSONResponse(TranscriptionJson(text=text).model_dump())

    engine = state.engine
    segments = [
        SegmentOut(
            id=s.id, seek=s.seek, start=round(s.start, 3), end=round(s.end, 3), text=s.text.strip(),
            tokens=s.tokens, temperature=s.temperature, avg_logprob=round(s.avg_logprob, 4),
            compression_ratio=round(s.compression_ratio, 4), no_speech_prob=round(s.no_speech_prob, 4),
        )
        for s in result.segments
    ]
    words = (
        [WordOut(word=w.word.strip(), start=round(w.start, 3), end=round(w.end, 3), probability=round(w.probability, 4))
         for s in result.segments for w in s.words]
        if want_words else None
    )
    body = TranscriptionVerbose(
        language=user_lang,
        duration=round(duration, 3),
        text=text,
        segments=segments,
        words=words,
        x_ditactic=XDitactic(
            model=engine.info.model,
            compute_type=engine.info.compute_type,
            device=engine.info.device,
            raw_text=raw_text,
            normalized=bool(normalize_text),
            language_probability=round(lang_prob, 4),
            decode_language=decode_lang,
            duration_after_vad=round(result.duration_after_vad, 3),
            processing_ms=processing_ms,
            warnings=guarded.warnings,
            glossary_version=glossary_obj.version,
        ),
    )
    return JSONResponse(body.model_dump(exclude_none=True))


async def _run_decoding(
    request: Request,
    pcm: np.ndarray,
    requested_language: str,
    prompt: str | None,
    request_terms: list,
    temps: tuple[float, ...],
) -> tuple[RawResult, str, str, float]:
    """Hold a slot, detect language if needed, decode. Returns (result, decode_lang, user_lang, prob)."""
    state = request.app.state
    settings = state.settings
    engine = state.engine
    glossary_obj = state.glossary.with_request_terms(request_terms) if request_terms else state.glossary

    def work() -> tuple[RawResult, str, str, float]:
        user_lang, prob = requested_language, 1.0
        if user_lang == "auto":
            user_lang, prob = engine.detect_language(pcm, SUPPORTED_LANGUAGES)
        decode_lang = settings.decode_map.get(user_lang, user_lang)
        opts = TranscribeOptions(
            language=decode_lang,
            initial_prompt=build_initial_prompt(user_lang, prompt, engine.count_tokens, settings.prompt_token_budget),
            hotwords=build_hotwords(glossary_obj.prompt_terms(), engine.count_tokens, settings.hotwords_token_budget),
            temperature=temps,
            beam_size=settings.beam_size,
            best_of=settings.best_of,
        )
        return engine.transcribe(pcm, opts), decode_lang, user_lang, prob

    try:
        slot = await state.slots.acquire()
    except SlotsFullError as exc:
        raise ApiError(503, "engine busy, retry later", error_type="server_error", code="busy", headers={"Retry-After": "5"}) from exc
    task = asyncio.ensure_future(asyncio.to_thread(work))
    try:
        done, _ = await asyncio.wait({task}, timeout=settings.request_timeout_s)
        if not done:
            raise ApiError(504, "transcription timed out", error_type="server_error", code="timeout")
        return task.result()
    finally:
        if task.done():
            slot.release()
        else:
            task.add_done_callback(lambda _t: slot.release())  # the thread keeps its slot until it ends
