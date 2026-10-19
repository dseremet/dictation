from __future__ import annotations

from asr_engine.asr.guards import (
    apply_guards,
    collapse_repetitions,
    is_hallucination,
    speech_rate_warning,
)
from asr_engine.asr.types import RawSegment

HALL = ["Hvala na gledanju", "Titlovi by", "Prevod i obrada", "Muzika"]


def seg(i: int, text: str, **kw) -> RawSegment:
    base = {"id": i, "seek": 0, "start": float(i), "end": float(i) + 2.0, "text": text,
            "avg_logprob": -0.3, "compression_ratio": 1.2, "no_speech_prob": 0.1}
    base.update(kw)
    return RawSegment(**base)


def test_collapse_unigram_and_ngram_runs() -> None:
    text, frac = collapse_repetitions("da da da da da da pacijent")
    assert text == "da pacijent"
    assert 0.7 < frac < 0.8
    text, frac = collapse_repetitions("i tako dalje i tako dalje i tako dalje i tako dalje kraj")
    assert text == "i tako dalje kraj"
    assert collapse_repetitions("bol bol bol pacijent")[1] == 0.0  # 3 repeats are allowed
    assert collapse_repetitions("")[1] == 0.0


def test_hallucination_matching() -> None:
    assert is_hallucination("Hvala na gledanju.", HALL)
    assert is_hallucination("hvala na gledanju!", HALL)
    assert is_hallucination("Titlovi by Marko Marković", HALL)
    assert is_hallucination("Muzika", HALL)
    assert not is_hallucination("Muzika mu pomaže kod anksioznosti i spavanja", HALL)
    assert not is_hallucination("Hvala, pacijent dolazi na kontrolu za mjesec dana", HALL)


def test_apply_guards_drops_and_reports() -> None:
    segments = [
        seg(0, " Pacijent navodi bol."),
        seg(1, " ", end=1.0),
        seg(2, " šum", no_speech_prob=0.9, avg_logprob=-1.5),
        seg(3, " aaaa aaaa", compression_ratio=3.0),
        seg(4, " da da da da da da da da"),
        seg(5, " Hvala na gledanju"),
        seg(6, " uzima lijek lijek lijek lijek lijek svaki dan"),
    ]
    res = apply_guards(segments, speech_seconds=12.0, hallucinations=HALL)
    assert [s.id for s in res.segments] == [0, 6]
    assert res.segments[1].text == "uzima lijek svaki dan"
    assert "segment_dropped:empty:1" in res.warnings
    assert "segment_dropped:low_confidence:2" in res.warnings
    assert "segment_dropped:compression_ratio:3" in res.warnings
    assert "segment_dropped:repetition:4" in res.warnings
    assert "segment_dropped:hallucination:5" in res.warnings
    assert "repetition_collapsed:6" in res.warnings
    assert not any("Pacijent" in w for w in res.warnings)


def test_no_speech_short_circuit() -> None:
    res = apply_guards([seg(0, "nešto")], speech_seconds=0.2, hallucinations=[])
    assert res.segments == [] and res.warnings == ["no_speech"]


def test_all_dropped_reports_no_speech() -> None:
    res = apply_guards([seg(0, "Hvala na gledanju")], speech_seconds=3.0, hallucinations=HALL)
    assert res.segments == [] and "no_speech" in res.warnings


def test_speech_rate() -> None:
    fast = [seg(0, " ".join(["riječ"] * 40), start=0.0, end=5.0)]
    slow = [seg(0, "bol", start=0.0, end=20.0)]
    short = [seg(0, " ".join(["riječ"] * 40), start=0.0, end=2.0)]
    assert speech_rate_warning(fast) == "speech_rate_high"
    assert speech_rate_warning(slow) == "speech_rate_low"
    assert speech_rate_warning(short) is None
