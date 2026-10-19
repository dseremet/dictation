from asr_engine.normalizer.translit import has_cyrillic, to_latin, transliterate


def test_basic() -> None:
    assert to_latin("Пацијент") == "Pacijent"
    assert to_latin("љубав њега џеп ђак ћевап") == "ljubav njega džep đak ćevap"
    assert to_latin("Љубав Његош") == "Ljubav Njegoš"
    assert to_latin("ЉУБАВ") == "LJUBAV"


def test_latin_untouched() -> None:
    s = "Pacijent uzima lijek, čćšđž ČĆŠĐŽ"
    assert to_latin(s) == s
    assert not has_cyrillic(s)


def test_nfc() -> None:
    decomposed = "č"  # c + combining caron
    assert transliterate(decomposed) == "č"
