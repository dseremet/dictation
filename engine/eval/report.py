"""Render eval/results/*.json into one Markdown table (stdout or --out results/REPORT.md)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def rows_from(path: Path) -> list[tuple[str, str, dict]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    tag = data.get("tag", path.stem) + (" (raw)" if data.get("raw") else "")
    if "languages" in data:
        return [(tag, f"FLEURS {lang}", v["summary"]) for lang, v in data["languages"].items()]
    out = [(tag, "private (all)", data["summary"])]
    out += [(tag, f"private {lang}", s) for lang, s in data.get("by_language", {}).items()]
    return out


def render(results_dir: Path) -> str:
    lines = [
        "| model | set | n | WER | WER (no diacritics) | CER | term recall | RTF |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for path in sorted(results_dir.glob("*.json")):
        for tag, name, s in rows_from(path):
            rtf = s["wall_s"] / s["audio_s"] if s.get("audio_s") else 0
            recall = f"{s['term_recall']:.1f} %" if "term_recall" in s else "—"
            lines.append(f"| {tag} | {name} | {s['n']} | {s['wer_strict']:.2f} | {s['wer_loose']:.2f} | {s['cer_strict']:.2f} | {recall} | {rtf:.2f} |")
    lines.append("")
    lines.append("Baselines on FLEURS hr test (WER, strict): whisper-large-v3-turbo 12.73 · GoranS/whisper-large-v3-turbo-hr 8.66 (published numbers, re-measure with this script).")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--results-dir", type=Path, default=Path(__file__).parent / "results")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args(argv)
    text = render(args.results_dir)
    if args.out:
        args.out.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
