"""BHS medical text normaliser: a pipeline of pure functions over Whisper output.

Order (deliberate): transliteration -> numbers -> spoken commands -> units ->
terms -> abbreviations -> spacing/casing. Numbers run before commands so that
``zarez`` between two numbers is the decimal comma, not a sentence comma.
"""

from __future__ import annotations

from asr_engine.normalizer.abbreviations import apply_abbreviations
from asr_engine.normalizer.casing import finalize
from asr_engine.normalizer.commands import apply_commands
from asr_engine.normalizer.loader import Glossary, load_glossary, parse_request_terms
from asr_engine.normalizer.numbers import convert_numbers
from asr_engine.normalizer.terms import apply_terms
from asr_engine.normalizer.translit import transliterate
from asr_engine.normalizer.units import apply_units

__all__ = ["Glossary", "load_glossary", "normalize", "normalize_steps", "parse_request_terms"]


def normalize_steps(text: str, language: str, glossary: Glossary) -> list[tuple[str, str]]:
    """Run the pipeline and return ``[(step_name, text_after_step), ...]`` (for debugging/tests)."""
    steps: list[tuple[str, str]] = []
    t = transliterate(text)
    steps.append(("translit", t))
    t = convert_numbers(t, glossary.unit_trigger_words)
    steps.append(("numbers", t))
    t = apply_commands(t, glossary.commands_for(language))
    steps.append(("commands", t))
    t = apply_units(t, glossary.units)
    steps.append(("units", t))
    t = apply_terms(t, glossary.term_pattern, glossary.terms)
    t = apply_terms(t, glossary.term_pattern, glossary.terms)  # multi-word canonicals built by pass 1
    steps.append(("terms", t))
    t = apply_abbreviations(t, glossary.abbreviations)
    steps.append(("abbreviations", t))
    t = finalize(t)
    steps.append(("casing", t))
    return steps


def normalize(text: str, language: str, glossary: Glossary) -> str:
    """Normalise ``text`` (Whisper output) for ``language`` (``bs|hr|sr``)."""
    if not text or not text.strip():
        return ""
    return normalize_steps(text, language, glossary)[-1][1]
