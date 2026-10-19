"""The shipped glossary meets the v1 coverage floor and validates."""

from __future__ import annotations

import pytest

from asr_engine.normalizer.loader import Glossary, TermEntry, parse_request_terms


def test_coverage(glossary: Glossary) -> None:
    categories = {}
    for t in glossary.terms:
        categories[t.category or "none"] = categories.get(t.category or "none", 0) + 1
    medical = sum(v for k, v in categories.items() if k not in {"drug", "dialect"})
    assert medical >= 120, categories
    assert categories.get("drug", 0) >= 60, categories
    assert len(glossary.abbreviations) >= 40
    assert len(glossary.units) >= 15
    for lang in ("bs", "hr", "sr"):
        assert len(glossary.commands_for(lang)) >= 10
        assert len(glossary.hallucinations.get(lang, [])) >= 10
    assert glossary.version != "empty"


def test_no_duplicate_variants_across_terms(glossary: Glossary) -> None:
    seen: dict[str, str] = {}
    for t in glossary.terms:
        for v in (*t.variants, t.canonical):
            key = " ".join(v.lower().split())
            if key in seen and seen[key] != t.canonical:
                pytest.fail(f"variant {v!r} maps to both {seen[key]!r} and {t.canonical!r}")
            seen.setdefault(key, t.canonical)


def test_request_terms_parse_and_merge(glossary: Glossary) -> None:
    terms = parse_request_terms(["Botox", {"canonical": "Juvederm", "variants": ["juviderm"], "weight": 1}])
    assert [t.canonical for t in terms] == ["Botox", "Juvederm"]
    assert all(t.weight >= 5 for t in terms)
    merged = glossary.with_request_terms(["Botox"])
    assert merged.terms[0].canonical == "Botox"
    assert merged.prompt_terms()[0].canonical == "Botox"
    assert len(glossary.terms) + 1 == len(merged.terms)


def test_request_terms_rejected() -> None:
    with pytest.raises(ValueError):
        parse_request_terms("not a list")  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        parse_request_terms([42])
    with pytest.raises(ValueError):
        parse_request_terms(["x"] * 201)
    with pytest.raises(ValueError):
        TermEntry(canonical="")
