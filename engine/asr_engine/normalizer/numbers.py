"""Spoken BHS numbers -> digits.

Rules (see tests/cases/numbers.yaml):

* numbers >= 10 become digits; 1-9 stay words unless followed by a unit trigger
  (``mg``, ``puta``, ``posto``, ``tablete``, ...), part of a decimal, a blood
  pressure reading or a range whose other side converts;
* ``<n> zarez|cijelih|celih <n>`` -> ``n,n``; ``<n> i po`` -> ``n,5``;
* ``pritisak|RR|TA|tlak <n> sa|kroz|na <n>`` -> ``n/n`` (plausible ranges only);
* a lone ``sto`` only converts next to a measurement word or unit (``sto`` is also "table").

The function is pure and runs *before* spoken commands so that ``zarez``
between numbers is read as the decimal comma.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import NamedTuple

TOKEN_RE = re.compile(r"\w+|[^\w\s]+|\s+", re.UNICODE)

UNITS: dict[str, int] = {
    "nula": 0, "jedan": 1, "jedna": 1, "jedno": 1, "jednu": 1, "jednog": 1,
    "dva": 2, "dvije": 2, "dve": 2, "dvje": 2, "dvjema": 2, "dvema": 2,
    "tri": 3, "četiri": 4, "cetiri": 4, "pet": 5, "šest": 6, "sest": 6, "sedam": 7,
    "osam": 8, "devet": 9, "deset": 10, "jedanaest": 11, "dvanaest": 12, "trinaest": 13,
    "četrnaest": 14, "cetrnaest": 14, "petnaest": 15, "šesnaest": 16, "sesnaest": 16,
    "sedamnaest": 17, "osamnaest": 18, "devetnaest": 19,
}
TENS: dict[str, int] = {
    "dvadeset": 20, "trideset": 30, "četrdeset": 40, "cetrdeset": 40, "pedeset": 50,
    "šezdeset": 60, "sezdeset": 60, "sedamdeset": 70, "osamdeset": 80, "devedeset": 90,
}
HUNDREDS: dict[str, int] = {
    "sto": 100, "stotinu": 100, "stotina": 100, "stotine": 100,
    "dvjesto": 200, "dvjesta": 200, "dvesta": 200, "dvesto": 200, "dvije stotine": 200,
    "tristo": 300, "trista": 300, "četiristo": 400, "cetiristo": 400, "četristo": 400,
    "petsto": 500, "šesto": 600, "šeststo": 600, "sesto": 600, "seststo": 600,
    "sedamsto": 700, "osamsto": 800, "devetsto": 900,
}
HUNDRED_MULTIPLIERS = {"sto", "stotinu", "stotina", "stotine"}  # "pet stotina"
HUNDRED_NEEDS_MULTIPLIER = {"stotina", "stotine"}
THOUSANDS = {"hiljadu", "hiljade", "hiljada", "tisuću", "tisucu", "tisuće", "tisuce", "tisuća", "tisuca"}
MILLIONS = {"milion", "miliona", "milijun", "milijuna", "milijon", "milijona"}

DECIMAL_SEPARATORS = {
    "zarez", "zapeta", "koma", "cijelih", "cijela", "cijelo", "cijeli", "celih", "cela", "celo",
    "celi", "cjelih", "cijelu",
}
BP_KEYWORDS = {
    "pritisak", "pritiska", "pritisku", "pritiskom", "tlak", "tlaka", "tlaku", "tlakom",
    "rr", "ta", "tenzija", "tenzije", "tenziju", "tenzijom", "krvni", "arterijski",
    "te", "er",  # "te a", "er er" before the abbreviation step runs
}
BP_SEPARATORS_WITH_KEYWORD = {"sa", "s", "na", "prema", "kroz", "po"}
BP_SEPARATORS_ALWAYS = {"kroz"}
RANGE_WORDS = {"do"}
MEASURE_WORDS = {
    "puls", "pulsa", "frekvencija", "frekvencije", "saturacija", "saturacije", "glukoza",
    "glikemija", "šećer", "secer", "težina", "tezina", "visina", "temperatura", "spo2", "sat",
    "otkucaja", "iznosi", "je", "oko", "preko", "ispod", "iznad", "od", "do", "x", "puta",
}
ORDINALS: dict[str, int] = {  # feminine genitive, as in "dvije hiljade devetnaeste (godine)"
    "prve": 1, "druge": 2, "treće": 3, "trece": 3, "četvrte": 4, "cetvrte": 4, "pete": 5, "šeste": 6,
    "seste": 6, "sedme": 7, "osme": 8, "devete": 9, "desete": 10, "jedanaeste": 11, "dvanaeste": 12,
    "trinaeste": 13, "četrnaeste": 14, "petnaeste": 15, "šesnaeste": 16, "sedamnaeste": 17,
    "osamnaeste": 18, "devetnaeste": 19, "dvadesete": 20, "tridesete": 30, "četrdesete": 40,
    "pedesete": 50, "šezdesete": 60, "sedamdesete": 70, "osamdesete": 80, "devedesete": 90,
}
UNIT_TRIGGERS = {
    "mg", "ml", "mcg", "g", "kg", "l", "dl", "cm", "mm", "m", "ij", "mmol", "meq", "ie",
    "miligrama", "miligram", "mililitara", "mililitar", "mikrograma", "grama", "gram", "kilograma",
    "kilogram", "litara", "litar", "centimetara", "milimetara", "jedinica", "jedinice",
    "posto", "procenata", "procenat", "procenta", "odsto", "promila", "puta", "put", "x",
    "stepeni", "stepen", "stepena", "stupnjeva", "stupnja", "celzijusa",
    "tableta", "tablete", "tabletu", "tabletom", "tabl", "tbl", "kapsula", "kapsule", "kapsulu",
    "kapi", "kap", "ampula", "ampule", "ampulu", "doza", "doze", "dozu", "injekcija", "injekcije", "injekciju", "inhalacija", "inhalacije", "udaha", "udah", "udisaja",
    "kašika", "kašike", "kasika", "kasike", "kašičica", "kašičice", "kasicica", "kasicice",
    "mjerica", "mjerice", "merica", "merice", "komada", "komad", "serija", "serije", "ciklusa",
    "ciklus", "sesija", "sesije", "seansa", "seanse", "epizoda", "epizode",
    "dan", "dana", "sat", "sata", "sati", "minuta", "minute", "minut", "sekundi", "sekunde",
    "sedmica", "sedmice", "sedmicu", "tjedan", "tjedna", "tjedana", "nedjelja", "nedjelje",
    "nedelja", "nedelje", "nedjelju", "nedelju", "mjesec", "mjeseca", "mjeseci", "mesec",
    "meseca", "meseci", "godina", "godine", "godinu", "godišnje", "dnevno", "sedmično",
    "tjedno", "nedjeljno", "nedeljno", "mjesečno", "mesečno", "otkucaja", "respiracija",
    "trudnoća", "trudnoće", "poroda", "porod", "pobačaja", "operacije", "operacija", "zuba",
}


class _Parsed(NamedTuple):
    value: int
    consumed: int
    has_thousand: bool = False
    open_for_ordinal: bool = False  # phrase ended on thousands/hundreds/tens, no unit yet
    tens_open: bool = False  # ended on tens: a following ordinal must be < 10


@dataclass
class _Item:
    start: int  # token index, inclusive
    end: int  # token index, exclusive
    text: str
    value: float | None
    spoken: bool  # came from words (digits are kept as they are)
    force: bool = False
    lone_sto: bool = False
    blocked: bool = False  # e.g. "dvadeset pete": an ordinal compound, keep the words

    @property
    def small(self) -> bool:
        return self.spoken and self.value is not None and self.value < 10


def _is_inline_space(tok: str) -> bool:
    return tok.isspace() and "\n" not in tok


def _next_word(tokens: list[str], idx: int) -> int | None:
    """Index of the next word token after ``idx`` (exclusive) across inline whitespace."""
    j = idx
    while j < len(tokens) and _is_inline_space(tokens[j]):
        j += 1
    if j < len(tokens) and tokens[j][0].isalnum():
        return j
    return None


def _prev_word(tokens: list[str], idx: int) -> int | None:
    j = idx - 1
    while j >= 0 and _is_inline_space(tokens[j]):
        j -= 1
    if j >= 0 and tokens[j][0].isalnum():
        return j
    return None


def _parse_words(words: list[str]) -> _Parsed | None:
    """Parse a run of lowercased number words; return ``(value, consumed, ...)``."""
    total = 0
    group = 0
    have_h = have_t = have_u = have_k = have_m = False
    consumed = 0
    i = 0
    while i < len(words):
        w = words[i]
        if w in UNITS:
            v = UNITS[w]
            if w == "nula":
                if consumed == 0:
                    return _Parsed(0, 1)
                break
            if have_u or (have_t and v >= 10):
                break
            group += v
            have_u = True
        elif w in TENS:
            if have_t or have_u:
                break
            group += TENS[w]
            have_t = True
        elif w in HUNDREDS:
            if have_h or have_t:
                break
            if have_u:
                if w not in HUNDRED_MULTIPLIERS:
                    break
                group *= 100
                have_u = False
            else:
                if w in HUNDRED_NEEDS_MULTIPLIER:
                    break
                group += HUNDREDS[w]
            have_h = True
        elif w in THOUSANDS:
            if have_k or (have_m and group == 0):
                break
            total += (group if (have_h or have_t or have_u) else 1) * 1000
            group, have_h, have_t, have_u = 0, False, False, False
            have_k = True
        elif w in MILLIONS:
            if have_m or have_k:
                break
            total += (group if (have_h or have_t or have_u) else 1) * 1_000_000
            group, have_h, have_t, have_u = 0, False, False, False
            have_m = True
        elif w == "i" and i + 1 < len(words):
            nxt = words[i + 1]
            after = words[i + 2] if i + 2 < len(words) else ""
            joins_unit = nxt in UNITS and UNITS[nxt] < 10 and (have_t or have_h) and not have_u
            joins_tens = nxt in TENS and have_h and not have_t and not have_u
            if not (joins_unit or joins_tens) or after in THOUSANDS or after in MILLIONS:
                break
            consumed += 1
            i += 1
            continue
        else:
            break
        consumed += 1
        i += 1
    if consumed == 0:
        return None
    if words[0] == "nula":
        return _Parsed(0, 1)
    return _Parsed(total + group, consumed, have_k or have_m, not have_u, have_t and not have_u)


def _collect_words(tokens: list[str], start: int, limit: int = 12) -> list[tuple[int, str]]:
    """Word tokens starting at ``start`` separated by inline whitespace only."""
    out: list[tuple[int, str]] = []
    j: int | None = start
    while j is not None and len(out) < limit:
        out.append((j, tokens[j].lower()))
        j = _next_word(tokens, j + 1)
    return out


def _parse_fraction(tokens: list[str], start: int) -> tuple[str, int] | None:
    """Digits after a decimal separator: ``nula nula pet`` -> ``005``. Returns (digits, end)."""
    if tokens[start].isdigit():
        return tokens[start], start + 1
    words = _collect_words(tokens, start)
    zeros = 0
    while zeros < len(words) and words[zeros][1] == "nula":
        zeros += 1
    rest = [w for _, w in words[zeros:]]
    parsed = _parse_words(rest) if rest else None
    if parsed is None:
        if zeros == 0:
            return None
        return "0" * zeros, words[zeros - 1][0] + 1
    if parsed.has_thousand or parsed.value >= 1000:
        return None
    end = words[zeros + parsed.consumed - 1][0] + 1
    return "0" * zeros + str(parsed.value), end


def _scan_items(tokens: list[str]) -> list[_Item]:
    items: list[_Item] = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if not tok[0].isalnum():
            i += 1
            continue
        if tok.isdigit():
            items.append(_Item(i, i + 1, tok, float(tok), spoken=False))
            i += 1
            continue
        words = _collect_words(tokens, i)
        parsed = _parse_words([w for _, w in words])
        if parsed is None:
            i += 1
            continue
        value, consumed = parsed.value, parsed.consumed
        end = words[consumed - 1][0] + 1
        if parsed.has_thousand and parsed.open_for_ordinal and consumed < len(words):
            ordinal = ORDINALS.get(words[consumed][1])
            if ordinal is not None and (not parsed.tens_open or ordinal < 10):
                # "dvije hiljade devetnaeste (godine)" -> "2019."
                items.append(_Item(i, words[consumed][0] + 1, f"{value + ordinal}.", None, True, force=True))
                i = words[consumed][0] + 1
                continue
        lone_sto = consumed == 1 and words[0][1] in {"sto", "stotinu"}
        blocked = consumed < len(words) and words[consumed][1] in ORDINALS
        items.append(_Item(i, end, str(value), float(value), spoken=True, lone_sto=lone_sto, blocked=blocked))
        i = end
    return items


def _word_at(tokens: list[str], idx: int | None) -> str:
    return tokens[idx].lower() if idx is not None else ""


def _has_bp_keyword(tokens: list[str], start: int) -> bool:
    j = _prev_word(tokens, start)
    for _ in range(4):
        if j is None:
            return False
        if tokens[j].lower() in BP_KEYWORDS:
            return True
        j = _prev_word(tokens, j)
    return False


def _combine(tokens: list[str], items: list[_Item]) -> list[_Item]:
    """Merge decimals and blood pressure pairs into single items."""
    by_start = {it.start: it for it in items}
    out: list[_Item] = []
    consumed_starts: set[int] = set()
    for it in items:
        if it.start in consumed_starts:
            continue
        cur = it
        # decimal: <n> zarez <n> | <n> i po
        k = _next_word(tokens, cur.end)
        word = _word_at(tokens, k)
        if word in DECIMAL_SEPARATORS and k is not None:
            k2 = _next_word(tokens, k + 1)
            frac = _parse_fraction(tokens, k2) if k2 is not None else None
            if frac is not None:
                digits, end = frac
                if k2 in by_start:
                    consumed_starts.add(k2)
                cur = _Item(cur.start, end, f"{cur.text},{digits}", None, True, force=True)
        elif word == "i" and k is not None:
            k2 = _next_word(tokens, k + 1)
            if _word_at(tokens, k2) in {"po", "pol"} and k2 is not None:
                cur = _Item(cur.start, k2 + 1, f"{cur.text},5", None, True, force=True)
        # blood pressure: <n> sa|kroz|na <n>
        k = _next_word(tokens, cur.end)
        word = _word_at(tokens, k)
        if k is not None and word in BP_SEPARATORS_WITH_KEYWORD:
            k2 = _next_word(tokens, k + 1)
            other = by_start.get(k2) if k2 is not None else None
            if other is not None and cur.value is not None and other.value is not None:
                plausible = 40 <= cur.value <= 300 and 20 <= other.value <= 200
                keyword_ok = word in BP_SEPARATORS_ALWAYS or _has_bp_keyword(tokens, cur.start)
                if plausible and keyword_ok:
                    consumed_starts.add(other.start)
                    cur = _Item(cur.start, other.end, f"{cur.text}/{other.text}", None, True, force=True)
        out.append(cur)
    return out


def _should_convert(tokens: list[str], it: _Item, triggers: frozenset[str]) -> bool:
    if it.force:
        return True
    if not it.spoken or it.blocked:
        return False
    nxt = _word_at(tokens, _next_word(tokens, it.end))
    if nxt in triggers or nxt in UNIT_TRIGGERS:
        return True
    if it.lone_sto:
        prev = _word_at(tokens, _prev_word(tokens, it.start))
        return prev in MEASURE_WORDS
    return it.value is not None and it.value >= 10


# Blood pressure Whisper already wrote in digits but with the wrong separator:
# "pritisak 120-80", "TA 120,80", "RR 120 80" -> "120/80". Only after a
# pressure keyword and only for plausible values, so dates and ranges survive.
_BP_DIGITS_RE = re.compile(
    r"(?i)\b(pritisak|pritiska|pritisku|pritiskom|tlak|tlaka|tlaku|tlakom|RR|TA|krvni pritisak|krvni tlak)"
    r"(\s*(?:je|iznosi|od|:)?\s*)(\d{2,3})\s*[-\u2013,]?\s*(\d{2,3})\b(?!\s*[/.,]\d)"
)


def _fix_digit_pressure(text: str) -> str:
    def repl(m: re.Match[str]) -> str:
        sys_, dia = int(m.group(3)), int(m.group(4))
        if 40 <= sys_ <= 300 and 20 <= dia <= 200 and sys_ > dia:
            return f"{m.group(1)}{m.group(2)}{sys_}/{dia}"
        return m.group(0)

    return _BP_DIGITS_RE.sub(repl, text)


def convert_numbers(text: str, unit_triggers: frozenset[str] = frozenset()) -> str:
    """Convert spoken numbers in ``text`` to digits according to the module rules."""
    if not text:
        return text
    text = _fix_digit_pressure(text)
    tokens = TOKEN_RE.findall(text)
    items = _combine(tokens, _scan_items(tokens))
    convert = {it.start: _should_convert(tokens, it, unit_triggers) for it in items}
    # ranges: "od pet do deset" -> both sides follow the converting side
    for idx, it in enumerate(items[:-1]):
        nxt = items[idx + 1]
        between = _next_word(tokens, it.end)
        if between is not None and tokens[between].lower() in RANGE_WORDS:
            after = _next_word(tokens, between + 1)
            if after == nxt.start and (convert[it.start] or convert[nxt.start]):
                convert[it.start] = convert[nxt.start] = True
    out: list[str] = []
    i = 0
    starts = {it.start: it for it in items}
    while i < len(tokens):
        it = starts.get(i)
        if it is not None and convert[i]:
            out.append(it.text)
            i = it.end
            continue
        out.append(tokens[i])
        i += 1
    return "".join(out)
