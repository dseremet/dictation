from __future__ import annotations

import pytest

from asr_engine.normalizer.numbers import _parse_words, convert_numbers


@pytest.mark.parametrize(
    ("words", "value"),
    [
        ("nula", 0),
        ("jedan", 1),
        ("dvije", 2),
        ("devetnaest", 19),
        ("dvadeset jedan", 21),
        ("sto", 100),
        ("sto pet", 105),
        ("sto dvadeset pet", 125),
        ("dvjesto pedeset", 250),
        ("dvesta", 200),
        ("tristo", 300),
        ("pet stotina", 500),
        ("dvije stotine dvadeset", 220),
        ("hiljadu", 1000),
        ("tisuću dvjesto", 1200),
        ("dvije hiljade dvadeset četiri", 2024),
        ("pet hiljada petsto", 5500),
        ("trideset i pet", 35),
        ("sto i dvadeset", 120),
        ("milion", 1_000_000),
    ],
)
def test_parse_words(words: str, value: int) -> None:
    parsed = _parse_words(words.split())
    assert parsed is not None
    assert parsed.value == value
    assert parsed.consumed == len(words.split())


def test_parse_stops_at_invalid_sequence() -> None:
    assert _parse_words(["pet", "tri"])[:2] == (5, 1)
    assert _parse_words(["dvadeset", "dvanaest"])[:2] == (20, 1)
    assert _parse_words(["pacijent"]) is None
    assert _parse_words(["stotine"]) is None


def test_plain_conversion_rules() -> None:
    assert convert_numbers("ima dvadeset godina") == "ima 20 godina"
    assert convert_numbers("ima dva sina") == "ima dva sina"
    assert convert_numbers("dva miligrama") == "2 miligrama"
    assert convert_numbers("tri zarez pet") == "3,5"
    assert convert_numbers("pritisak sto dvadeset sa osamdeset") == "pritisak 120/80"
    assert convert_numbers("Sto dvadeset.") == "120."


def test_implausible_pressure_is_not_merged() -> None:
    assert convert_numbers("pritisak pet sa tri") == "pritisak pet sa tri"


def test_newline_breaks_a_number_phrase() -> None:
    assert convert_numbers("dvadeset\npet") == "20\npet"
