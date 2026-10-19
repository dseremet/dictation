"""Target-text normalisation for fine-tuning data (pure helpers + CLI).

Targets keep casing, punctuation and the speaker's dialect; only script and
noise are normalised: Cyrillic -> Latin, NFC, noise tags removed, whitespace
and punctuation spacing fixed. Usage::

    python training/normalize_targets.py in.jsonl out.jsonl [--min-cps 2 --max-cps 30]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from asr_engine.normalizer.translit import to_latin

NOISE_TAG = re.compile(r"\[[^\]]{1,40}\]|\([^)]{1,40}\)|<[^>]{1,40}>|\{[^}]{1,40}\}")
NOISE_WORDS = {"hm", "hmm", "mhm", "aha", "ovaj", "ovaj,", "eee", "ee", "mm", "mmm", "uh", "um", "äh"}
_MULTI_SPACE = re.compile(r"\s+")
_SPACE_BEFORE_PUNCT = re.compile(r"\s+([.,;:!?])")
_NO_SPACE_AFTER_PUNCT = re.compile(r"([,;:!?])(?=[^\W\d_])")
_DASHES = str.maketrans({"–": "-", "—": "-", "„": '"', "“": '"', "”": '"', "’": "'", "‘": "'"})


def strip_noise_tags(text: str) -> str:
    """Remove ``[smijeh]``, ``(aplauz)``, ``<unk>`` style annotations."""
    return NOISE_TAG.sub(" ", text)


def strip_fillers(text: str) -> str:
    words = [w for w in text.split() if w.lower().strip(".,") not in NOISE_WORDS]
    return " ".join(words)


def fix_spacing(text: str) -> str:
    text = _SPACE_BEFORE_PUNCT.sub(r"\1", text)
    text = _NO_SPACE_AFTER_PUNCT.sub(r"\1 ", text)
    return _MULTI_SPACE.sub(" ", text).strip()


def normalize_target(text: str) -> str:
    """Full target normalisation; idempotent and dialect-preserving."""
    text = unicodedata.normalize("NFC", text or "")
    text = to_latin(text).translate(_DASHES)
    text = strip_noise_tags(text)
    text = strip_fillers(text)
    return fix_spacing(text)


def chars_per_second(text: str, duration_s: float) -> float:
    return len(text) / duration_s if duration_s > 0 else float("inf")


def is_acceptable(text: str, duration_s: float, *, min_cps: float = 2.0, max_cps: float = 30.0, min_chars: int = 3) -> bool:
    """Reject empty, implausibly dense or sparse targets (alignment errors, music)."""
    if len(text) < min_chars or not any(ch.isalpha() for ch in text):
        return False
    if not 0.3 <= duration_s <= 35.0:
        return False
    return min_cps <= chars_per_second(text, duration_s) <= max_cps


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path)
    ap.add_argument("dst", type=Path)
    ap.add_argument("--min-cps", type=float, default=2.0)
    ap.add_argument("--max-cps", type=float, default=30.0)
    args = ap.parse_args(argv)
    kept = dropped = 0
    with args.src.open(encoding="utf-8") as src, args.dst.open("w", encoding="utf-8") as dst:
        for line in src:
            if not line.strip():
                continue
            row = json.loads(line)
            text = normalize_target(row.get("text", ""))
            if not is_acceptable(text, float(row.get("duration", 0) or 0), min_cps=args.min_cps, max_cps=args.max_cps):
                dropped += 1
                continue
            row["text_raw"] = row.get("text", "")
            row["text"] = text
            dst.write(json.dumps(row, ensure_ascii=False) + "\n")
            kept += 1
    print(f"kept {kept}, dropped {dropped}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
