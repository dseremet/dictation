"""Response models (OpenAI shapes + the ``x_ditactic`` extension block)."""

from __future__ import annotations

from pydantic import BaseModel, Field

RESPONSE_FORMATS = ("json", "verbose_json", "text")


class WordOut(BaseModel):
    word: str
    start: float
    end: float
    probability: float | None = None


class SegmentOut(BaseModel):
    id: int
    seek: int
    start: float
    end: float
    text: str
    tokens: list[int] = Field(default_factory=list)
    temperature: float = 0.0
    avg_logprob: float = 0.0
    compression_ratio: float = 0.0
    no_speech_prob: float = 0.0


class XDitactic(BaseModel):
    model: str
    compute_type: str
    device: str
    raw_text: str
    normalized: bool
    language_probability: float
    decode_language: str
    duration_after_vad: float
    processing_ms: int
    warnings: list[str] = Field(default_factory=list)
    glossary_version: str


class TranscriptionJson(BaseModel):
    text: str


class TranscriptionVerbose(BaseModel):
    task: str = "transcribe"
    language: str
    duration: float
    text: str
    segments: list[SegmentOut] | None = None
    words: list[WordOut] | None = None
    x_ditactic: XDitactic


class ModelOut(BaseModel):
    id: str
    object: str = "model"
    created: int
    owned_by: str = "ditactic"


class ModelList(BaseModel):
    object: str = "list"
    data: list[ModelOut]


class Health(BaseModel):
    status: str
    model: str | None = None
    device: str | None = None
    compute_type: str | None = None
    glossary_version: str | None = None
    inflight: int = 0
    waiting: int = 0
    uptime_s: float = 0.0
    version: str
