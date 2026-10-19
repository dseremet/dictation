"""The normaliser must never rewrite ijekavica into ekavica or vice versa."""

from __future__ import annotations

import pytest

from asr_engine.normalizer import normalize

PAIRS = [
    ("lijek", "lek"),
    ("mjesec", "mesec"),
    ("dijete", "dete"),
    ("vrijeme", "vreme"),
    ("liječenje", "lečenje"),
    ("svijest", "svest"),
    ("crijevo", "crevo"),
    ("koljeno", "koleno"),
    ("sljedeća", "sledeća"),
    ("ljekar", "lekar"),
]


@pytest.mark.parametrize(("ije", "e"), PAIRS)
@pytest.mark.parametrize("language", ["bs", "hr", "sr"])
def test_both_dialects_survive(ije: str, e: str, language: str, glossary) -> None:
    for word in (ije, e):
        out = normalize(f"pacijent kaže {word} i ništa više", language, glossary)
        assert word in out, f"{word!r} was rewritten to {out!r} for language={language}"


def test_glossary_has_no_cross_dialect_mapping(glossary) -> None:
    """A dialect form may only map onto itself."""
    flat = {ije: e for ije, e in PAIRS} | {e: ije for ije, e in PAIRS}
    for term in glossary.terms:
        for variant in term.variants:
            v = variant.lower()
            if v in flat:
                assert term.canonical.lower() == v, f"{variant} -> {term.canonical} flips the dialect"
