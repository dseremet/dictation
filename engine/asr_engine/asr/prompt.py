"""``initial_prompt`` and ``hotwords`` construction within token budgets.

With ``condition_on_previous_text=False`` only ``hotwords`` is re-injected into
every 30 s window, so glossary terms go there; ``initial_prompt`` carries the
style header (casing, punctuation, register) plus the caller's free text.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from asr_engine.normalizer.loader import TermEntry

TokenCounter = Callable[[str], int]

STYLE_HEADERS: dict[str, str] = {
    # Register and casing cues only. Concrete values, units or lab names here
    # leak into the transcript ("puls 72" became "CRP 72" with "CRP 5 mg/l" in
    # the header, and "mmHg" appeared although never spoken), so the header
    # names the document type and its sections and nothing measurable.
    "bs": "Ljekarski nalaz. Anamneza, status, dijagnoza i terapija.",
    "hr": "Liječnički nalaz. Anamneza, status, dijagnoza i terapija.",
    "sr": "Lekarski nalaz. Anamneza, status, dijagnoza i terapija.",
}
MAX_CALLER_PROMPT_CHARS = 2000
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def sanitize_prompt(text: str | None) -> str:
    if not text:
        return ""
    text = _CONTROL.sub(" ", text)[:MAX_CALLER_PROMPT_CHARS]
    return " ".join(text.split())


def heuristic_token_count(text: str) -> int:
    """Rough BPE estimate for tests and for when no tokenizer is loaded (~1 token / 3.2 chars)."""
    return max(1, round(len(text) / 3.2)) if text else 0


def truncate_to_budget(text: str, count_tokens: TokenCounter, budget: int) -> str:
    """Drop trailing words until ``text`` fits ``budget`` tokens."""
    if not text or count_tokens(text) <= budget:
        return text
    words = text.split()
    lo, hi = 0, len(words)
    while lo < hi:  # binary search on the word count
        mid = (lo + hi + 1) // 2
        if count_tokens(" ".join(words[:mid])) <= budget:
            lo = mid
        else:
            hi = mid - 1
    return " ".join(words[:lo])


def build_initial_prompt(
    language: str, caller_prompt: str | None, count_tokens: TokenCounter, budget: int = 96
) -> str:
    header = STYLE_HEADERS.get(language, STYLE_HEADERS["hr"])
    caller = sanitize_prompt(caller_prompt)
    text = f"{header} {caller}".strip() if caller else header
    return truncate_to_budget(text, count_tokens, budget)


def build_hotwords(terms: list[TermEntry], count_tokens: TokenCounter, budget: int = 96) -> str | None:
    """Comma-separated canonical terms, highest weight first, within ``budget`` tokens."""
    chosen: list[str] = []
    seen: set[str] = set()
    for term in terms:
        name = term.canonical.strip()
        key = name.lower()
        if not name or key in seen:
            continue
        if count_tokens(", ".join([*chosen, name])) > budget:
            if chosen:
                break
            continue  # a single oversized term: skip it, try the next
        chosen.append(name)
        seen.add(key)
    return ", ".join(chosen) if chosen else None
