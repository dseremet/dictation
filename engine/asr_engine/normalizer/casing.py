"""Final pass: whitespace, punctuation spacing, sentence casing.

Spoken commands emit ``HARD_STOP`` after ``.`` so that a dictated full stop
always ends a sentence, while a period Whisper placed after a digit (``2. dan``)
is treated as an ordinal and does not capitalise the next word.
"""

from __future__ import annotations

import re

HARD_STOP = ""  # private-use marker appended to a dictated "."
_HP = ""  # internal: hard period (". + marker" collapsed to one char)

NO_CAP_AFTER = {
    "tbl", "amp", "caps", "supp", "gtt", "dg", "th", "rp", "npr", "tj", "itd", "sl", "dr", "mr",
    "prof", "br", "god", "st", "cca", "min", "max", "ev", "evt", "tzv", "odn", "str", "gosp", "ul",
}
_LETTER = r"[^\W\d_]"


def _is_abbreviation_before(text: str, dot_idx: int) -> bool:
    m = re.search(r"(\S+)$", text[:dot_idx])
    if not m:
        return False
    word = m.group(1)
    if word[-1].isdigit():
        return True  # ordinal "2." / date
    if len(word) == 1 and word.isalpha():
        return True  # "p.o." / "i.v."
    if re.fullmatch(r"(?:\w\.)+\w", word):
        return True  # "p.o" before its final dot
    return word.lower().strip("(") in NO_CAP_AFTER


def fix_spacing(text: str) -> str:
    text = text.replace("\t", " ").replace("\r", "")
    text = re.sub(rf"\.{HARD_STOP}", _HP, text)
    text = text.replace(HARD_STOP, "")
    text = re.sub(r"[ ]{2,}", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(rf" +([.,;:!?){_HP}])", r"\1", text)
    text = re.sub(r"\( +", "(", text)
    text = re.sub(rf"[.{_HP}](?:\s*[.{_HP}])+", _HP, text)  # ". ." / ".." -> hard stop
    text = re.sub(r"([,;:!?])(?:\s*\1)+", r"\1", text)
    text = re.sub(rf",\s*([.{_HP}])", r"\1", text)
    text = re.sub(rf"([,;:])(?={_LETTER})", r"\1 ", text)
    text = re.sub(rf"(?<!\b\w)([.!?{_HP}])(?={_LETTER})", r"\1 ", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.strip()


def sentence_case(text: str) -> str:
    if not text:
        return text
    chars = list(text)
    for m in re.finditer(rf"(?:^|\n)[^\S\n]*({_LETTER})", text):
        chars[m.start(1)] = chars[m.start(1)].upper()
    for m in re.finditer(rf"([.!?{_HP}])[ ]+({_LETTER})", text):
        if m.group(1) == "." and _is_abbreviation_before(text, m.start(1)):
            continue
        chars[m.start(2)] = chars[m.start(2)].upper()
    return "".join(chars)


def finalize(text: str) -> str:
    return sentence_case(fix_spacing(text)).replace(_HP, ".")
