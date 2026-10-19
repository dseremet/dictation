"""Spoken units after a number -> symbols (``500 miligrama`` -> ``500 mg``)."""

from __future__ import annotations

import re

from asr_engine.normalizer.loader import UnitEntry

NUMBER = r"\d+(?:[,.]\d+)?"
SYMBOL = r"[A-Za-zµ°%‰/]{0,8}"
KNOWN_SYMBOLS = ("mmHg", "mcg", "mEq", "mmol", "mg", "ml", "kg", "cm", "mm", "dl", "IJ", "g", "l")


def _alt(phrases: list[str]) -> str:
    ordered = sorted({p.strip() for p in phrases if p.strip()}, key=len, reverse=True)
    return "|".join(r"\s+".join(re.escape(w) for w in p.split()) for p in ordered)


def apply_units(text: str, units: list[UnitEntry]) -> str:
    if not text or not units:
        return text
    for unit in units:
        alt = _alt(unit.phrases)
        if not alt:
            continue
        if unit.attach == "suffix":
            pattern = re.compile(rf"(?<!\w)({NUMBER}\s?{SYMBOL})\s+(?:{alt})(?!\w)", re.IGNORECASE)
            text = pattern.sub(lambda m, s=unit.symbol: f"{m.group(1).rstrip()}{s}", text)
        else:
            joiner = "" if unit.attach == "glue" else " "
            pattern = re.compile(rf"(?<!\w)({NUMBER})\s+(?:{alt})(?!\w)", re.IGNORECASE)
            text = pattern.sub(lambda m, s=unit.symbol, j=joiner: f"{m.group(1)}{j}{s}", text)
    # "500mg" -> "500 mg" for symbols Whisper glued to the number
    glued = re.compile(rf"(?<!\w)({NUMBER})({'|'.join(KNOWN_SYMBOLS)})(?!\w)")
    text = glued.sub(lambda m: f"{m.group(1)} {m.group(2)}", text)
    return text
