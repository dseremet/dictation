"""Table-driven normaliser tests from ``tests/cases/*.yaml``."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from asr_engine.normalizer import normalize, normalize_steps

CASES_DIR = Path(__file__).resolve().parents[1] / "cases"


def _load_cases() -> list[pytest.param]:
    params: list[pytest.param] = []
    for path in sorted(CASES_DIR.glob("*.yaml")):
        cases = yaml.safe_load(path.read_text(encoding="utf-8")) or []
        for case in cases:
            params.append(pytest.param(case, id=f"{path.stem}::{case['name']}"))
    return params


@pytest.mark.parametrize("case", _load_cases())
def test_case(case: dict, glossary) -> None:
    g = glossary.with_request_terms(case["glossary"]) if case.get("glossary") else glossary
    language = case.get("language", "bs")
    got = normalize(case["input"], language, g)
    if got != case["expected"]:
        trace = "\n".join(f"  {name:14s} {text!r}" for name, text in normalize_steps(case["input"], language, g))
        pytest.fail(f"{case['name']}\n  expected {case['expected']!r}\n  got      {got!r}\nsteps:\n{trace}")


def test_cases_cover_every_area() -> None:
    stems = {p.stem for p in CASES_DIR.glob("*.yaml")}
    assert {"commands", "numbers", "units", "abbreviations", "terms", "translit", "casing", "dialect"} <= stems
