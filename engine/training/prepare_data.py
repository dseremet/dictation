"""Build train/dev manifests (JSONL) from public BHS corpora plus the private medical set.

Sources (each optional):
  --parlaspeech-hr  HF id or local dir  (default classla/ParlaSpeech-HR, CC BY-SA 4.0)
  --parlaspeech-rs  HF id or local dir  (default classla/ParlaSpeech-RS, Cyrillic targets -> Latin)
  --cv-hr / --cv-sr extracted Common Voice dirs (validated.tsv + clips/)
  --private         directory following training/private_dataset_spec.md

Mix (fractions of the final training set): HR 50 / RS 25 / CV 5 / private 20 %,
private rows upsampled x4 before mixing. Output rows:
  {"audio": path_or_hf_ref, "text": str, "language": "hr|sr|bs", "domain": "parl|cv|medical",
   "speaker": str|null, "duration": float}

Nothing is downloaded at import time; heavy libraries load inside the loaders.
Example:
  python training/prepare_data.py --out data/manifests --hours-hr 200 --hours-rs 100 \
      --private data/private --cv-hr data/cv/hr --seed 13
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from collections import defaultdict
from collections.abc import Iterable, Iterator
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from training.normalize_targets import is_acceptable, normalize_target

Row = dict


# ----------------------------------------------------------------------------- pure helpers
def subset_by_speaker_hours(rows: list[Row], hours: float, seed: int = 0) -> list[Row]:
    """Take whole speakers (shuffled) until ``hours`` of audio are collected."""
    if hours <= 0:
        return rows
    by_speaker: dict[str, list[Row]] = defaultdict(list)
    for r in rows:
        by_speaker[str(r.get("speaker") or "unknown")].append(r)
    speakers = list(by_speaker)
    random.Random(seed).shuffle(speakers)
    out: list[Row] = []
    total = 0.0
    for spk in speakers:
        out.extend(by_speaker[spk])
        total += sum(float(r.get("duration") or 0) for r in by_speaker[spk]) / 3600
        if total >= hours:
            break
    return out


def split_dev_by_speaker(rows: list[Row], dev_fraction: float = 0.02, seed: int = 0) -> tuple[list[Row], list[Row]]:
    """Speaker-disjoint dev split (so dev WER is not inflated by seen voices)."""
    speakers = sorted({str(r.get("speaker") or "unknown") for r in rows})
    rnd = random.Random(seed)
    rnd.shuffle(speakers)
    n_dev = max(1, int(len(speakers) * dev_fraction)) if len(speakers) > 1 else 0
    dev_speakers = set(speakers[:n_dev])
    dev = [r for r in rows if str(r.get("speaker") or "unknown") in dev_speakers]
    train = [r for r in rows if str(r.get("speaker") or "unknown") not in dev_speakers]
    return train, dev


def mix_sources(sources: dict[str, list[Row]], weights: dict[str, float], upsample: dict[str, int], seed: int = 0) -> list[Row]:
    """Combine sources so that their *row* proportions follow ``weights`` (sources may be smaller)."""
    rnd = random.Random(seed)
    pools = {name: rows * upsample.get(name, 1) for name, rows in sources.items() if rows}
    if not pools:
        return []
    active = {name: weights.get(name, 0.0) for name in pools}
    wsum = sum(active.values()) or 1.0
    active = {k: v / wsum for k, v in active.items()}
    # the largest pool relative to its weight sets the scale; others are sampled with replacement if short
    scale = max(len(rows) / active[name] for name, rows in pools.items() if active[name] > 0)
    out: list[Row] = []
    for name, rows in pools.items():
        target = round(scale * active[name])
        if target <= len(rows):
            out.extend(rnd.sample(rows, target))
        else:
            out.extend(rows)
            out.extend(rnd.choices(rows, k=target - len(rows)))
    rnd.shuffle(out)
    return out


def parse_mix(spec: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for part in spec.split(","):
        name, _, value = part.partition("=")
        if name.strip():
            out[name.strip()] = float(value or 0)
    return out


# ----------------------------------------------------------------------------- loaders
def _row(audio: str, text: str, language: str, domain: str, speaker: str | None, duration: float) -> Row | None:
    text = normalize_target(text)
    if not is_acceptable(text, duration):
        return None
    return {"audio": audio, "text": text, "language": language, "domain": domain, "speaker": speaker, "duration": round(duration, 3)}


def load_parlaspeech(spec: str, language: str, split: str = "train") -> Iterator[Row]:
    """ParlaSpeech-HR/RS from the Hub (streaming) or from a local ``manifest.jsonl``.

    Column names on the Hub have changed between releases; adjust ``TEXT_KEYS``/``SPEAKER_KEYS``
    if a release renames them. Audio stays referenced as ``hf://<dataset>#<index>`` and is
    materialised by train_lora.py through ``datasets``.
    """
    local = Path(spec)
    if local.is_dir():
        for line in (local / "manifest.jsonl").open(encoding="utf-8"):
            r = json.loads(line)
            row = _row(str(local / r["audio"]), r["text"], language, "parl", r.get("speaker"), float(r.get("duration", 0)))
            if row:
                yield row
        return
    from datasets import load_dataset  # heavy import, only when used

    ds = load_dataset(spec, split=split, streaming=True)
    text_keys = ("text", "normalized_text", "sentence", "transcript")
    speaker_keys = ("speaker_id", "speaker", "speaker_info")
    for i, ex in enumerate(ds):
        text = next((ex[k] for k in text_keys if ex.get(k)), "")
        spk = next((ex[k] for k in speaker_keys if ex.get(k)), None)
        if isinstance(spk, dict):
            spk = spk.get("id") or spk.get("name")
        audio = ex.get("audio") or {}
        duration = len(audio.get("array", [])) / float(audio.get("sampling_rate") or 16000) if audio else float(ex.get("duration", 0))
        row = _row(f"hf://{spec}#{split}#{i}", text, language, "parl", str(spk) if spk else None, duration)
        if row:
            yield row


def load_common_voice(root: Path, language: str) -> Iterator[Row]:
    tsv = root / "validated.tsv"
    with tsv.open(encoding="utf-8") as fh:
        for rec in csv.DictReader(fh, delimiter="\t"):
            clip = root / "clips" / rec["path"]
            duration = float(rec.get("duration") or 0) / 1000 if rec.get("duration") else 0.0
            row = _row(str(clip), rec["sentence"], language, "cv", rec.get("client_id"), duration or 5.0)
            if row:
                yield row


def load_private(root: Path) -> Iterator[Row]:
    for line in (root / "metadata.jsonl").open(encoding="utf-8"):
        if not line.strip():
            continue
        r = json.loads(line)
        row = _row(str(root / r["audio"]), r["text"], r.get("language", "bs"), r.get("domain", "medical"), r.get("speaker"), float(r.get("duration", 0)))
        if row:
            yield row


def write_jsonl(path: Path, rows: Iterable[Row]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
            n += 1
    return n


# ----------------------------------------------------------------------------- CLI
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--parlaspeech-hr", default="classla/ParlaSpeech-HR")
    ap.add_argument("--parlaspeech-rs", default="classla/ParlaSpeech-RS")
    ap.add_argument("--no-parlaspeech", action="store_true")
    ap.add_argument("--cv-hr", type=Path)
    ap.add_argument("--cv-sr", type=Path)
    ap.add_argument("--private", type=Path)
    ap.add_argument("--hours-hr", type=float, default=200)
    ap.add_argument("--hours-rs", type=float, default=100)
    ap.add_argument("--mix", default="hr=0.5,rs=0.25,cv=0.05,private=0.2")
    ap.add_argument("--private-upsample", type=int, default=4)
    ap.add_argument("--dev-fraction", type=float, default=0.02)
    ap.add_argument("--seed", type=int, default=13)
    args = ap.parse_args(argv)

    sources: dict[str, list[Row]] = {}
    if not args.no_parlaspeech:
        sources["hr"] = subset_by_speaker_hours(list(load_parlaspeech(args.parlaspeech_hr, "hr")), args.hours_hr, args.seed)
        sources["rs"] = subset_by_speaker_hours(list(load_parlaspeech(args.parlaspeech_rs, "sr")), args.hours_rs, args.seed)
    cv: list[Row] = []
    if args.cv_hr:
        cv += list(load_common_voice(args.cv_hr, "hr"))
    if args.cv_sr:
        cv += list(load_common_voice(args.cv_sr, "sr"))
    if cv:
        sources["cv"] = cv
    if args.private:
        sources["private"] = list(load_private(args.private))

    train_parts: dict[str, list[Row]] = {}
    dev: list[Row] = []
    for name, rows in sources.items():
        tr, dv = split_dev_by_speaker(rows, args.dev_fraction, args.seed)
        train_parts[name] = tr
        dev += dv
    train = mix_sources(train_parts, parse_mix(args.mix), {"private": args.private_upsample}, args.seed)
    n_train = write_jsonl(args.out / "train.jsonl", train)
    n_dev = write_jsonl(args.out / "dev.jsonl", dev)
    hours = sum(r["duration"] for r in train) / 3600
    print(f"train rows={n_train} (~{hours:.1f} h incl. upsampling), dev rows={n_dev}", file=sys.stderr)
    for name, rows in sources.items():
        print(f"  {name:8s} {len(rows):7d} rows  {sum(r['duration'] for r in rows) / 3600:6.1f} h", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
