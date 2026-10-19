"""Serbian Cyrillic -> Latin (Gaj's alphabet) and Unicode NFC."""

from __future__ import annotations

import unicodedata

_PAIRS = {
    "А": "A", "Б": "B", "В": "V", "Г": "G", "Д": "D", "Ђ": "Đ", "Е": "E", "Ж": "Ž", "З": "Z",
    "И": "I", "Ј": "J", "К": "K", "Л": "L", "Љ": "Lj", "М": "M", "Н": "N", "Њ": "Nj", "О": "O",
    "П": "P", "Р": "R", "С": "S", "Т": "T", "Ћ": "Ć", "У": "U", "Ф": "F", "Х": "H", "Ц": "C",
    "Ч": "Č", "Џ": "Dž", "Ш": "Š",
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "ђ": "đ", "е": "e", "ж": "ž", "з": "z",
    "и": "i", "ј": "j", "к": "k", "л": "l", "љ": "lj", "м": "m", "н": "n", "њ": "nj", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "ћ": "ć", "у": "u", "ф": "f", "х": "h", "ц": "c",
    "ч": "č", "џ": "dž", "ш": "š",
}
_TABLE = str.maketrans(_PAIRS)


def has_cyrillic(text: str) -> bool:
    return any("Ѐ" <= ch <= "ӿ" for ch in text)


def to_latin(text: str) -> str:
    """Transliterate Cyrillic letters; uppercase digraphs follow the next letter's case."""
    if not has_cyrillic(text):
        return text
    out: list[str] = []
    chars = list(text)
    for i, ch in enumerate(chars):
        mapped = _PAIRS.get(ch)
        if mapped is None:
            out.append(ch)
            continue
        if len(mapped) == 2 and mapped[0].isupper():
            nxt = chars[i + 1] if i + 1 < len(chars) else ""
            if nxt.isupper():
                mapped = mapped.upper()  # "ЉУБАВ" -> "LJUBAV"
        out.append(mapped)
    return "".join(out)


def nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def transliterate(text: str) -> str:
    return nfc(to_latin(text))
