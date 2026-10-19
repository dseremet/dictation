"""Plain data types shared by the engine, guards and API (no faster-whisper import)."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class RawWord:
    word: str
    start: float
    end: float
    probability: float


@dataclass
class RawSegment:
    id: int
    seek: int
    start: float
    end: float
    text: str
    tokens: list[int] = field(default_factory=list)
    temperature: float = 0.0
    avg_logprob: float = 0.0
    compression_ratio: float = 0.0
    no_speech_prob: float = 0.0
    words: list[RawWord] = field(default_factory=list)


@dataclass
class RawResult:
    segments: list[RawSegment]
    language: str
    language_probability: float
    duration: float
    duration_after_vad: float


@dataclass
class TranscribeOptions:
    language: str  # Whisper language token to decode with
    initial_prompt: str | None = None
    hotwords: str | None = None
    temperature: tuple[float, ...] = (0.0, 0.2, 0.4)
    beam_size: int = 5
    best_of: int = 5
    word_timestamps: bool = True


@dataclass
class ModelInfo:
    model: str
    device: str
    compute_type: str
