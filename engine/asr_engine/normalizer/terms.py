"""Dictionary step: misrecognised medical terms -> canonical spelling (longest match first).

Variants match as whole words, case-insensitively. A variant may also carry a
BHS case ending (``furo semida`` -> ``furosemida``) when both the variant and
the canonical end the same way (consonant, or the same vowel), so inflected
misrecognitions do not have to be listed one by one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from asr_engine.normalizer.loader import TermEntry

SUFFIXES = ("ama", "ima", "om", "em", "og", "oj", "im", "ih", "a", "e", "i", "u", "o")
_SUFFIX_ALT = "|".join(SUFFIXES)
_VOWELS = "aeiou"
MIN_STEM = 4


@dataclass(frozen=True)
class _Stem:
    canonical_stem: str
    ending: str  # "c" consonant or the vowel itself


def _norm_key(s: str) -> str:
    return " ".join(s.lower().split())


def _ending(word: str) -> str | None:
    last = word[-1].lower()
    if last.isdigit():
        return None
    return last if last in _VOWELS else "c"


def _stem(word: str) -> str:
    return word[:-1] if word[-1].lower() in _VOWELS else word


def build_term_map(terms: list[TermEntry]) -> dict[str, str]:
    """variant (lowercase) -> canonical. First definition wins (request terms come first)."""
    mapping: dict[str, str] = {}
    for term in terms:
        for variant in (*term.variants, term.canonical):
            key = _norm_key(variant)
            if key and key not in mapping:
                mapping[key] = term.canonical
    return mapping


def build_stem_map(terms: list[TermEntry]) -> dict[str, _Stem]:
    """variant stem -> canonical stem, for variants that can take a case ending."""
    stems: dict[str, _Stem] = {}
    for key, canonical in build_term_map(terms).items():
        v_end, c_end = _ending(key), _ending(canonical)
        if v_end is None or c_end is None or v_end != c_end or not key[-1].isalpha():
            continue
        stem = _stem(key)
        if len(stem.split()[-1]) < MIN_STEM:
            continue
        stems.setdefault(stem, _Stem(_stem(canonical), v_end))
    return stems


def build_term_pattern(terms: list[TermEntry]) -> re.Pattern[str] | None:
    keys = sorted(build_term_map(terms), key=len, reverse=True)
    if not keys:
        return None
    stems = build_stem_map(terms)
    alts: list[str] = []
    for k in keys:
        alts.append(r"\s+".join(re.escape(w) for w in k.split()))
    for stem in sorted(stems, key=len, reverse=True):
        alts.append(r"\s+".join(re.escape(w) for w in stem.split()) + rf"(?:{_SUFFIX_ALT})")
    alts.sort(key=len, reverse=True)
    return re.compile(rf"(?<!\w)({'|'.join(alts)})(?!\w)", re.IGNORECASE)


def _match_case(match_text: str, replacement: str) -> str:
    if match_text[0].isupper() and replacement[0].islower():
        return replacement[0].upper() + replacement[1:]
    return replacement


def resolve(match_text: str, mapping: dict[str, str], stems: dict[str, _Stem]) -> str | None:
    """Canonical form for ``match_text`` (exact, or stem + case ending), or ``None``."""
    key = _norm_key(match_text)
    if key in mapping:
        return mapping[key]
    for suffix in sorted(SUFFIXES, key=len, reverse=True):
        if key.endswith(suffix) and key[: -len(suffix)] in stems:
            stem = stems[key[: -len(suffix)]]
            return stem.canonical_stem + suffix
    return None


def apply_terms(text: str, pattern: re.Pattern[str] | None, terms: list[TermEntry]) -> str:
    if not text or pattern is None:
        return text
    mapping = build_term_map(terms)
    stems = build_stem_map(terms)

    def sub(m: re.Match[str]) -> str:
        found = resolve(m.group(1), mapping, stems)
        if found is None or found.lower() == m.group(1).lower():
            return m.group(1)  # keep the speaker's own casing when nothing changes
        return _match_case(m.group(1), found)

    return pattern.sub(sub, text)
