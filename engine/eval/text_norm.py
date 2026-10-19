"""Text normalisation and error rates for evaluation (pure, dependency-free).

* ``norm_strict``: lowercase, Cyrillic -> Latin, punctuation removed, whitespace collapsed.
* ``norm_loose``: ``norm_strict`` + diacritics folded (č/ć -> c, š -> s, ž -> z, đ -> dj),
  which matches how many BHS users type and separates "wrong word" from "wrong accent".
* ``word_error_rate`` / ``char_error_rate``: Levenshtein over the whole corpus.
* ``medical_term_recall``: share of glossary terms present in the reference that the
  hypothesis also contains (loose match).
"""

from __future__ import annotations

import re
import sys
import unicodedata
from collections.abc import Iterable, Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from asr_engine.normalizer.translit import to_latin

_PUNCT = re.compile(r"[^\w\s]|_", re.UNICODE)
_DIACRITICS = str.maketrans({"č": "c", "ć": "c", "š": "s", "ž": "z", "Č": "C", "Ć": "C", "Š": "S", "Ž": "Z"})


def strip_diacritics(text: str) -> str:
    text = text.replace("đ", "dj").replace("Đ", "Dj")
    return text.translate(_DIACRITICS)


def norm_strict(text: str) -> str:
    text = unicodedata.normalize("NFC", to_latin(text or ""))
    text = _PUNCT.sub(" ", text.lower())
    return " ".join(text.split())


def norm_loose(text: str) -> str:
    return norm_strict(strip_diacritics(text or ""))


def edit_distance(ref: Sequence[str], hyp: Sequence[str]) -> int:
    """Levenshtein distance between two token sequences (O(len(ref)) memory)."""
    if not ref:
        return len(hyp)
    if not hyp:
        return len(ref)
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i]
        for j, h in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h)))
        prev = cur
    return prev[-1]


def word_error_rate(refs: Iterable[str], hyps: Iterable[str]) -> float:
    errors = total = 0
    for ref, hyp in zip(refs, hyps, strict=True):
        r, h = ref.split(), hyp.split()
        errors += edit_distance(r, h)
        total += len(r)
    return errors / total if total else 0.0


def char_error_rate(refs: Iterable[str], hyps: Iterable[str]) -> float:
    errors = total = 0
    for ref, hyp in zip(refs, hyps, strict=True):
        r, h = list(ref.replace(" ", "")), list(hyp.replace(" ", ""))
        errors += edit_distance(r, h)
        total += len(r)
    return errors / total if total else 0.0


def medical_term_recall(refs: Iterable[str], hyps: Iterable[str], terms: Iterable[str]) -> tuple[float, int]:
    """(recall, number of term occurrences in refs). Terms match as whole words, loosely normalised."""
    patterns = [re.compile(rf"(?<!\w){re.escape(norm_loose(t))}(?!\w)") for t in terms if t.strip()]
    found = occurrences = 0
    for ref, hyp in zip(refs, hyps, strict=True):
        r, h = norm_loose(ref), norm_loose(hyp)
        for pat in patterns:
            n = len(pat.findall(r))
            if n:
                occurrences += n
                found += min(n, len(pat.findall(h)))
    return (found / occurrences if occurrences else 1.0), occurrences
