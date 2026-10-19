"""Context-gated abbreviations (``elektrokardiogram`` -> ``EKG``, ``te a 120`` -> ``TA 120``)."""

from __future__ import annotations

import re

from asr_engine.normalizer.loader import AbbreviationEntry


def _alt(words: list[str]) -> str:
    ordered = sorted({w.strip() for w in words if w.strip()}, key=len, reverse=True)
    return "|".join(r"\s+".join(re.escape(p) for p in w.split()) for w in ordered)


def _context_ok(entry: AbbreviationEntry, text: str, start: int, end: int) -> bool:
    before = text[:start]
    after = text[end:]
    if entry.context == "always":
        return True
    if entry.context == "before_number":
        if re.match(r"\s*(?:je\s+|iznosi\s+|od\s+)?\d", after):
            return True
        return bool(
            entry.or_words
            and re.match(rf"\s*(?:je\s+)?(?:{_alt(entry.or_words)})(?!\w)", after, re.IGNORECASE)
        )
    if entry.context == "after_number":
        return bool(re.search(r"\d\s*$", before))
    if entry.context == "line_start_or_colon":
        at_line_start = re.search(r"(?:^|\n)[ \t]*$", before) is not None
        before_colon = re.match(r"\s*:", after) is not None
        return at_line_start or before_colon
    return False


def apply_abbreviations(text: str, entries: list[AbbreviationEntry]) -> str:
    if not text:
        return text
    for entry in entries:
        alt = _alt([*entry.variants])
        if not alt:
            continue
        pattern = re.compile(rf"(?<!\w)(?:{alt})(?!\w)", re.IGNORECASE)
        pieces: list[str] = []
        pos = 0
        for m in pattern.finditer(text):
            if not _context_ok(entry, text, m.start(), m.end()):
                continue
            canonical = entry.canonical
            if canonical.endswith(".") and re.match(r"\s*[:.]", text[m.end():]):
                canonical = canonical[:-1]  # "Dg.:" -> "Dg:", "tbl.." -> "tbl."
            pieces.append(text[pos:m.start()])
            pieces.append(canonical)
            pos = m.end()
        pieces.append(text[pos:])
        text = "".join(pieces)
    return text
