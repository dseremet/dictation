"""Spoken punctuation / layout commands (``tačka`` -> ``.``, ``nova linija`` -> newline)."""

from __future__ import annotations

import re

from asr_engine.normalizer.casing import HARD_STOP
from asr_engine.normalizer.loader import CommandEntry


def _phrase_regex(phrase: str) -> str:
    return r"\s+".join(re.escape(part) for part in phrase.split())


def build_command_pattern(commands: list[CommandEntry]) -> tuple[re.Pattern[str] | None, dict[str, CommandEntry]]:
    lookup: dict[str, CommandEntry] = {}
    phrases: list[str] = []
    for cmd in commands:
        for phrase in cmd.phrases:
            key = " ".join(phrase.lower().split())
            if key and key not in lookup:
                lookup[key] = cmd
                phrases.append(key)
    if not phrases:
        return None, lookup
    phrases.sort(key=len, reverse=True)
    pattern = re.compile(
        r"(?<!\w)(" + "|".join(_phrase_regex(p) for p in phrases) + r")(?!\w)",
        re.IGNORECASE,
    )
    return pattern, lookup


def _previous_word(text: str) -> str:
    m = re.search(r"(\w+)\W*$", text)
    return m.group(1).lower() if m else ""


def apply_commands(text: str, commands: list[CommandEntry]) -> str:
    """Replace spoken commands with their output, honouring attachment and ``not_after`` gates."""
    pattern, lookup = build_command_pattern(commands)
    if pattern is None or not text:
        return text
    out: list[str] = []
    pos = 0
    for m in pattern.finditer(text):
        key = " ".join(m.group(1).lower().split())
        cmd = lookup.get(key)
        if cmd is None:
            continue
        before = text[pos:m.start()]
        if cmd.not_after and _previous_word("".join(out) + before) in {w.lower() for w in cmd.not_after}:
            continue
        rest = text[m.end():]
        if cmd.attach == "left":
            out.append(before.rstrip(" \t"))
            out.append(cmd.output + HARD_STOP if cmd.output == "." else cmd.output)
            if rest[:1].isalnum():
                out.append(" ")
        elif cmd.attach == "right":
            out.append(before.rstrip(" \t"))
            if out and "".join(out) and not "".join(out).endswith(("\n", " ", "(")):
                out.append(" ")
            out.append(cmd.output)
            # drop following whitespace by advancing pos
            m_ws = re.match(r"[ \t]+", rest)
            pos = m.end() + (m_ws.end() if m_ws else 0)
            continue
        elif cmd.attach == "newline":
            out.append(before.rstrip(" \t"))
            out.append(cmd.output)
            m_ws = re.match(r"[ \t]+", rest)
            pos = m.end() + (m_ws.end() if m_ws else 0)
            continue
        else:
            out.append(before)
            out.append(cmd.output)
        pos = m.end()
    out.append(text[pos:])
    return "".join(out)
