"""Pure helpers of training/ and eval/ (the GPU scripts themselves only need to import cleanly)."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

from eval.text_norm import (
    char_error_rate,
    edit_distance,
    medical_term_recall,
    norm_loose,
    norm_strict,
    strip_diacritics,
    word_error_rate,
)
from training.normalize_targets import (
    fix_spacing,
    is_acceptable,
    normalize_target,
    strip_fillers,
    strip_noise_tags,
)
from training.prepare_data import (
    mix_sources,
    parse_mix,
    split_dev_by_speaker,
    subset_by_speaker_hours,
)


@pytest.mark.parametrize("module", ["training.prepare_data", "training.train_lora", "training.merge_and_convert", "eval.run_fleurs", "eval.run_private", "eval.report", "bench.bench_cpu"])
def test_scripts_import_without_gpu_libraries(module: str) -> None:
    importlib.import_module(module)


# ---------------------------------------------------------------- normalize_targets
def test_normalize_target_keeps_case_punct_and_dialect() -> None:
    assert normalize_target("Lijek za mjesec dana, kontrola 2. dan.") == "Lijek za mjesec dana, kontrola 2. dan."
    assert normalize_target("Lek za mesec dana.") == "Lek za mesec dana."


def test_normalize_target_translit_and_noise() -> None:
    assert normalize_target("Пацијент [kašalj] наводи (aplauz) бол ,  ovaj,  у леђима .") == "Pacijent navodi bol, u leđima."
    assert strip_noise_tags("a [b] c <unk> d {e}") == "a   c   d  "
    assert strip_fillers("hm pacijent ovaj navodi") == "pacijent navodi"
    assert fix_spacing("bol ,mučnina . kraj") == "bol, mučnina. kraj"


def test_normalize_target_idempotent() -> None:
    once = normalize_target("Temperatura – 38,5 °C „jutros“")
    assert once == 'Temperatura - 38,5 °C "jutros"'
    assert normalize_target(once) == once


def test_is_acceptable() -> None:
    assert is_acceptable("Pacijent navodi bolove u leđima.", 3.0)
    assert not is_acceptable("", 3.0)
    assert not is_acceptable("123", 3.0)
    assert not is_acceptable("a" * 500, 3.0)  # too dense
    assert not is_acceptable("bol", 20.0)  # too sparse
    assert not is_acceptable("bol u leđima", 0.1)


def test_normalize_targets_cli(tmp_path: Path) -> None:
    from training.normalize_targets import main

    src = tmp_path / "in.jsonl"
    src.write_text(json.dumps({"text": "Бол у леђима.", "duration": 2.0}) + "\n" + json.dumps({"text": "", "duration": 2.0}) + "\n")
    dst = tmp_path / "out.jsonl"
    assert main([str(src), str(dst)]) == 0
    rows = [json.loads(line) for line in dst.read_text().splitlines()]
    assert rows == [{"text": "Bol u leđima.", "duration": 2.0, "text_raw": "Бол у леђима."}]


# ---------------------------------------------------------------- prepare_data
def _rows(prefix: str, speakers: int, per: int, dur: float = 10.0) -> list[dict]:
    return [{"audio": f"{prefix}{s}_{i}.wav", "text": "x", "speaker": f"{prefix}{s}", "duration": dur} for s in range(speakers) for i in range(per)]


def test_subset_by_speaker_hours_takes_whole_speakers() -> None:
    rows = _rows("a", speakers=10, per=36, dur=100.0)  # 1 h per speaker
    out = subset_by_speaker_hours(rows, hours=3, seed=1)
    assert len(out) == 3 * 36
    assert len({r["speaker"] for r in out}) == 3
    assert subset_by_speaker_hours(rows, hours=0) is rows


def test_split_dev_by_speaker_is_disjoint() -> None:
    rows = _rows("s", speakers=50, per=4)
    train, dev = split_dev_by_speaker(rows, dev_fraction=0.1, seed=3)
    assert len(train) + len(dev) == len(rows)
    assert not ({r["speaker"] for r in train} & {r["speaker"] for r in dev})
    assert len({r["speaker"] for r in dev}) == 5


def test_mix_sources_follows_weights_and_upsamples() -> None:
    sources = {"hr": _rows("h", 10, 100), "rs": _rows("r", 10, 50), "private": _rows("p", 2, 20)}
    mixed = mix_sources(sources, parse_mix("hr=0.5,rs=0.25,private=0.25"), {"private": 4}, seed=0)
    counts = {k: sum(1 for r in mixed if r["speaker"].startswith(k[0])) for k in sources}
    assert counts["hr"] == 1000  # the largest pool is kept whole
    assert counts["rs"] == 500
    assert counts["private"] == 500  # 40 rows x4 = 160 unique, sampled with replacement to 500
    assert mix_sources({}, {"hr": 1}, {}) == []


def test_parse_mix() -> None:
    assert parse_mix("hr=0.5, rs=0.25,cv=0") == {"hr": 0.5, "rs": 0.25, "cv": 0.0}


# ---------------------------------------------------------------- eval.text_norm
def test_norms() -> None:
    assert norm_strict("Pacijent, NAVODI bol!") == "pacijent navodi bol"
    assert norm_strict("Пацијент") == "pacijent"
    assert norm_loose("Čučanj šđž ĐURO") == "cucanj sdjz djuro"
    assert strip_diacritics("đ Đ") == "dj Dj"


def test_error_rates() -> None:
    assert edit_distance(["a", "b", "c"], ["a", "x", "c"]) == 1
    assert word_error_rate(["a b c d"], ["a b c d"]) == 0.0
    assert word_error_rate(["a b c d"], ["a x c"]) == pytest.approx(0.5)
    assert char_error_rate(["abcd"], ["abxd"]) == pytest.approx(0.25)
    assert word_error_rate([], []) == 0.0


def test_medical_term_recall() -> None:
    refs = ["Pacijent ima hipertenziju i dijabetes.", "CRP povišen, EKG uredan."]
    hyps = ["pacijent ima hipertenziju i diabetes", "crp povisen ekg uredan"]
    recall, n = medical_term_recall(refs, hyps, ["hipertenziju", "dijabetes", "CRP", "EKG"])
    assert n == 4
    assert recall == pytest.approx(0.75)
    assert medical_term_recall(["x"], ["y"], ["nothing"]) == (1.0, 0)
