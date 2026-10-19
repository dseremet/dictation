from __future__ import annotations

from asr_engine.asr.prompt import (
    STYLE_HEADERS,
    build_hotwords,
    build_initial_prompt,
    heuristic_token_count,
    sanitize_prompt,
    truncate_to_budget,
)
from asr_engine.normalizer.loader import TermEntry


def words(text: str) -> int:
    return len(text.split())


def test_initial_prompt_has_header_and_caller_text() -> None:
    p = build_initial_prompt("bs", "Kardiologija, dr. Hadžić", words, budget=96)
    assert p.startswith(STYLE_HEADERS["bs"])
    assert "Kardiologija" in p


def test_initial_prompt_respects_budget() -> None:
    long = " ".join(f"term{i}" for i in range(500))
    p = build_initial_prompt("hr", long, words, budget=40)
    assert words(p) <= 40
    assert p.startswith(STYLE_HEADERS["hr"])


def test_truncate_binary_search_is_exact() -> None:
    text = " ".join(str(i) for i in range(100))
    out = truncate_to_budget(text, words, 37)
    assert words(out) == 37
    assert truncate_to_budget("", words, 5) == ""


def test_sanitize_strips_control_chars_and_caps_length() -> None:
    assert sanitize_prompt("a\x00b\n\nc") == "a b c"
    assert len(sanitize_prompt("x" * 5000)) == 2000
    assert sanitize_prompt(None) == ""


def test_hotwords_ordered_by_weight_within_budget() -> None:
    terms = [
        TermEntry(canonical="paracetamol", weight=1),
        TermEntry(canonical="hipertenzija", weight=3),
        TermEntry(canonical="skip me", prompt=False, weight=9),
        TermEntry(canonical="Hipertenzija", weight=2),  # duplicate (case) is dropped
        *[TermEntry(canonical=f"term{i}") for i in range(200)],
    ]
    ordered = sorted((t for t in terms if t.prompt), key=lambda t: -t.weight)
    hw = build_hotwords(ordered, heuristic_token_count, budget=30)
    assert hw is not None
    assert hw.startswith("hipertenzija, paracetamol")
    assert "skip me" not in hw
    assert hw.lower().count("hipertenzija") == 1
    assert heuristic_token_count(hw) <= 30


def test_hotwords_empty() -> None:
    assert build_hotwords([], words) is None
    assert build_hotwords([TermEntry(canonical="x" * 60)], heuristic_token_count, budget=5) is None


def test_glossary_hotwords_fit_default_budget(glossary) -> None:
    hw = build_hotwords(glossary.prompt_terms(), heuristic_token_count, budget=96)
    assert hw and heuristic_token_count(hw) <= 96
    assert hw.split(", ")[0] in {t.canonical for t in glossary.terms if t.weight >= 2}
