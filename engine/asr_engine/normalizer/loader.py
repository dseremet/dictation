"""Glossary data model and YAML loading.

Layout (``ASR_GLOSSARY_DIR``)::

    shared/*.yaml       terms / abbreviations / units (all languages)
    {bs,hr,sr}/*.yaml   commands / terms / hallucinations per language

Every file may contain any of the top-level keys ``terms``, ``abbreviations``,
``units``, ``commands``, ``hallucinations``; the directory decides the language.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, field_validator

LANGUAGES = ("bs", "hr", "sr")
MAX_REQUEST_TERMS = 200
MAX_TERM_LEN = 64


class TermEntry(BaseModel):
    """A canonical spelling and the misrecognitions that map onto it."""

    canonical: str = Field(min_length=1, max_length=MAX_TERM_LEN)
    variants: list[str] = Field(default_factory=list)
    weight: float = 1.0
    prompt: bool = True
    category: str | None = None

    @field_validator("variants")
    @classmethod
    def _clean_variants(cls, v: list[str]) -> list[str]:
        return [s.strip() for s in v if s and s.strip() and len(s) <= MAX_TERM_LEN]


class AbbreviationEntry(BaseModel):
    canonical: str
    variants: list[str] = Field(default_factory=list)
    context: str = "always"  # always | before_number | after_number | line_start_or_colon
    or_words: list[str] = Field(default_factory=list)

    @field_validator("context")
    @classmethod
    def _context(cls, v: str) -> str:
        allowed = {"always", "before_number", "after_number", "line_start_or_colon"}
        if v not in allowed:
            raise ValueError(f"context must be one of {sorted(allowed)}")
        return v


class UnitEntry(BaseModel):
    symbol: str
    phrases: list[str]
    attach: str = "space"  # space ("5 mg") | glue ("5%") | suffix ("ml/h", appended to unit)


class CommandEntry(BaseModel):
    output: str
    phrases: list[str]
    attach: str = "left"  # left (".") | right ("(") | newline | none
    not_after: list[str] = Field(default_factory=list)


@dataclass
class Glossary:
    """Merged, validated glossary. Immutable in practice; ``with_request_terms`` copies."""

    terms: list[TermEntry] = field(default_factory=list)
    abbreviations: list[AbbreviationEntry] = field(default_factory=list)
    units: list[UnitEntry] = field(default_factory=list)
    commands: dict[str, list[CommandEntry]] = field(default_factory=dict)
    hallucinations: dict[str, list[str]] = field(default_factory=dict)
    version: str = "empty"

    def commands_for(self, language: str) -> list[CommandEntry]:
        """Union of all languages, the requested one first (speakers mix bs/hr/sr freely)."""
        ordered = [language, *[lang for lang in self.commands if lang != language]]
        out: list[CommandEntry] = []
        for lang in ordered:
            out.extend(self.commands.get(lang, []))
        return out

    def hallucinations_for(self, language: str) -> list[str]:
        phrases: list[str] = []
        for lang in (language, *[lang for lang in self.hallucinations if lang != language]):
            phrases.extend(self.hallucinations.get(lang, []))
        return phrases

    def prompt_terms(self) -> list[TermEntry]:
        """Terms eligible for ``hotwords`` ordered by weight (request terms first)."""
        return sorted(
            (t for t in self.terms if t.prompt),
            key=lambda t: (-(t.weight), t.canonical.lower()),
        )

    @cached_property
    def unit_trigger_words(self) -> frozenset[str]:
        words = set()
        for unit in self.units:
            if unit.attach == "suffix":
                continue  # "na sat" is a suffix to a unit, not a trigger on its own
            for phrase in unit.phrases:
                first = phrase.split()[0].lower() if phrase.split() else ""
                if len(first) >= 2:
                    words.add(first)
        return frozenset(words)

    @cached_property
    def term_pattern(self) -> re.Pattern[str] | None:
        from asr_engine.normalizer.terms import build_term_pattern

        return build_term_pattern(self.terms)

    def with_request_terms(self, entries: list[Any]) -> Glossary:
        """Return a new glossary with per-request terms in front (highest priority)."""
        extra = parse_request_terms(entries)
        if not extra:
            return self
        return Glossary(
            terms=[*extra, *self.terms],
            abbreviations=self.abbreviations,
            units=self.units,
            commands=self.commands,
            hallucinations=self.hallucinations,
            version=self.version,
        )


def parse_request_terms(entries: list[Any]) -> list[TermEntry]:
    """Validate the request ``glossary`` field: strings or ``{canonical, variants, weight}``."""
    if not isinstance(entries, list):
        raise ValueError("glossary must be a JSON array")
    if len(entries) > MAX_REQUEST_TERMS:
        raise ValueError(f"glossary may hold at most {MAX_REQUEST_TERMS} entries")
    out: list[TermEntry] = []
    for raw in entries:
        if isinstance(raw, str):
            raw = {"canonical": raw}
        if not isinstance(raw, dict):
            raise ValueError("glossary entries must be strings or objects")
        term = TermEntry.model_validate(raw)
        term.weight = max(term.weight, 5.0)  # request terms always outrank the built-in ones
        out.append(term)
    return out


def _read_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: top level must be a mapping")
    return data


def load_glossary(root: Path) -> Glossary:
    """Load and merge every YAML file under ``root``. Missing directories yield an empty glossary."""
    root = Path(root)
    glossary = Glossary(commands={lang: [] for lang in LANGUAGES},
                        hallucinations={lang: [] for lang in LANGUAGES})
    digest = hashlib.sha1()
    files = sorted(root.glob("shared/*.yaml")) + [
        p for lang in LANGUAGES for p in sorted(root.glob(f"{lang}/*.yaml"))
    ]
    for path in files:
        digest.update(str(path.relative_to(root)).encode())
        digest.update(path.read_bytes())
        data = _read_yaml(path)
        lang = path.parent.name if path.parent.name in LANGUAGES else None
        for raw in data.get("terms", []) or []:
            glossary.terms.append(TermEntry.model_validate(raw))
        for raw in data.get("abbreviations", []) or []:
            glossary.abbreviations.append(AbbreviationEntry.model_validate(raw))
        for raw in data.get("units", []) or []:
            glossary.units.append(UnitEntry.model_validate(raw))
        for raw in data.get("commands", []) or []:
            glossary.commands.setdefault(lang or "bs", []).append(CommandEntry.model_validate(raw))
        for raw in data.get("hallucinations", []) or []:
            glossary.hallucinations.setdefault(lang or "bs", []).append(str(raw))
    glossary.version = digest.hexdigest()[:12] if files else "empty"
    return glossary
