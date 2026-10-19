"""Post-decoding guards against Whisper hallucinations. Pure functions over ``RawSegment``."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from asr_engine.asr.types import RawSegment

NO_SPEECH_PROB = 0.6
AVG_LOGPROB = -1.0
COMPRESSION_RATIO = 2.4
REPEAT_MIN = 4
REPEAT_MAX_NGRAM = 4
REPEAT_DROP_FRACTION = 0.6
RATE_HIGH_WPS = 6.0
RATE_LOW_WPS = 0.3
RATE_MIN_SECONDS = 5.0
_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)


@dataclass
class GuardResult:
    segments: list[RawSegment]
    warnings: list[str] = field(default_factory=list)


def _norm(text: str) -> str:
    return " ".join(_PUNCT.sub(" ", text.lower()).split())


def collapse_repetitions(text: str, min_repeats: int = REPEAT_MIN, max_n: int = REPEAT_MAX_NGRAM) -> tuple[str, float]:
    """Collapse 1..``max_n``-gram runs repeated >= ``min_repeats`` times. Returns (text, removed_fraction)."""
    tokens = text.split()
    original = len(tokens)
    if original == 0:
        return text, 0.0
    keys = [_norm(t) for t in tokens]
    changed = True
    while changed:
        changed = False
        for n in range(1, max_n + 1):
            out_t: list[str] = []
            out_k: list[str] = []
            i = 0
            while i < len(tokens):
                unit = keys[i : i + n]
                if len(unit) < n:
                    out_t.extend(tokens[i:])
                    out_k.extend(keys[i:])
                    break
                reps = 1
                while keys[i + reps * n : i + (reps + 1) * n] == unit:
                    reps += 1
                if reps >= min_repeats:
                    out_t.extend(tokens[i : i + n])
                    out_k.extend(unit)
                    i += reps * n
                    changed = True
                else:
                    out_t.append(tokens[i])
                    out_k.append(keys[i])
                    i += 1
            tokens, keys = out_t, out_k
    removed = original - len(tokens)
    return " ".join(tokens), removed / original


def is_hallucination(text: str, phrases: list[str]) -> bool:
    """True when the segment is (mostly) a known filler phrase such as "Hvala na gledanju"."""
    t = _norm(text)
    if not t:
        return False
    for raw in phrases:
        p = _norm(raw)
        if not p:
            continue
        if t == p:
            return True
        if " " in p and t.startswith(p + " "):
            return True
        if re.search(rf"(?<!\w){re.escape(p)}(?!\w)", t) and len(p) / len(t) >= 0.6:
            return True
    return False


def speech_rate_warning(segments: list[RawSegment]) -> str | None:
    words = sum(len(s.text.split()) for s in segments)
    seconds = sum(max(0.0, s.end - s.start) for s in segments)
    if seconds < RATE_MIN_SECONDS or words == 0:
        return None
    wps = words / seconds
    if wps > RATE_HIGH_WPS:
        return "speech_rate_high"
    if wps < RATE_LOW_WPS:
        return "speech_rate_low"
    return None


def apply_guards(
    segments: list[RawSegment],
    *,
    speech_seconds: float,
    hallucinations: list[str],
    min_speech_seconds: float = 0.5,
) -> GuardResult:
    """Filter and clean ``segments``; every drop is reported as a warning (never with text)."""
    warnings: list[str] = []
    if speech_seconds < min_speech_seconds:
        return GuardResult([], ["no_speech"])
    kept: list[RawSegment] = []
    for seg in segments:
        text = seg.text.strip()
        if not text or seg.end <= seg.start:
            warnings.append(f"segment_dropped:empty:{seg.id}")
            continue
        if seg.no_speech_prob > NO_SPEECH_PROB and seg.avg_logprob < AVG_LOGPROB:
            warnings.append(f"segment_dropped:low_confidence:{seg.id}")
            continue
        if seg.compression_ratio > COMPRESSION_RATIO:
            warnings.append(f"segment_dropped:compression_ratio:{seg.id}")
            continue
        collapsed, fraction = collapse_repetitions(text)
        if fraction > REPEAT_DROP_FRACTION:
            warnings.append(f"segment_dropped:repetition:{seg.id}")
            continue
        if fraction > 0:
            warnings.append(f"repetition_collapsed:{seg.id}")
            text = collapsed
            seg.words = []  # word timings no longer line up
        if is_hallucination(text, hallucinations):
            warnings.append(f"segment_dropped:hallucination:{seg.id}")
            continue
        seg.text = text
        kept.append(seg)
    if not kept and segments:
        warnings.append("no_speech")
    rate = speech_rate_warning(kept)
    if rate:
        warnings.append(rate)
    return GuardResult(kept, warnings)
