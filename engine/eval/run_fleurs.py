"""WER/CER on FLEURS hr_hr / sr_rs / bs_ba (test split) through the engine.

    python eval/run_fleurs.py --engine-url http://127.0.0.1:8321 --api-key $KEY --langs hr sr bs --limit 200
    python eval/run_fleurs.py --model turbo --langs hr            # in-process, no server

Writes eval/results/fleurs_<tag>.json with per-utterance rows and summary metrics
(strict + diacritic-insensitive). FLEURS references are lowercase without
punctuation in `transcription` and cased in `raw_transcription`; we score
against `raw_transcription` after norm_strict so both sides are treated alike.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from eval._client import make_backend, pcm_to_wav_bytes
from eval.text_norm import char_error_rate, norm_loose, norm_strict, word_error_rate

FLEURS_CONFIG = {"hr": "hr_hr", "sr": "sr_rs", "bs": "bs_ba"}


def summarize(rows: list[dict]) -> dict[str, float]:
    refs = [r["ref"] for r in rows]
    hyps = [r["hyp"] for r in rows]
    return {
        "n": len(rows),
        "wer_strict": 100 * word_error_rate([norm_strict(r) for r in refs], [norm_strict(h) for h in hyps]),
        "wer_loose": 100 * word_error_rate([norm_loose(r) for r in refs], [norm_loose(h) for h in hyps]),
        "cer_strict": 100 * char_error_rate([norm_strict(r) for r in refs], [norm_strict(h) for h in hyps]),
        "cer_loose": 100 * char_error_rate([norm_loose(r) for r in refs], [norm_loose(h) for h in hyps]),
        "audio_s": sum(r["duration"] for r in rows),
        "wall_s": sum(r["wall_s"] for r in rows),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engine-url")
    ap.add_argument("--api-key")
    ap.add_argument("--model", default="turbo")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--langs", nargs="+", default=["hr", "sr", "bs"], choices=list(FLEURS_CONFIG))
    ap.add_argument("--split", default="test")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--raw", action="store_true", help="score Whisper output without the normaliser")
    ap.add_argument("--tag", default=None)
    ap.add_argument("--out-dir", type=Path, default=Path(__file__).parent / "results")
    args = ap.parse_args(argv)

    from datasets import load_dataset

    backend = make_backend(args)
    tag = args.tag or (args.engine_url.replace("://", "_").replace("/", "_") if args.engine_url else args.model.replace("/", "_"))
    report: dict = {"tag": tag, "split": args.split, "raw": args.raw, "languages": {}}
    for lang in args.langs:
        ds = load_dataset("google/fleurs", FLEURS_CONFIG[lang], split=args.split, streaming=True)
        rows = []
        for i, ex in enumerate(ds):
            if args.limit and i >= args.limit:
                break
            audio = ex["audio"]
            wav = pcm_to_wav_bytes(audio["array"], audio["sampling_rate"])
            t0 = time.monotonic()
            resp = backend.transcribe(wav, lang)
            rows.append({
                "id": ex.get("id", i), "ref": ex["raw_transcription"], "hyp": resp.get("text", ""),
                "duration": len(audio["array"]) / audio["sampling_rate"], "wall_s": time.monotonic() - t0,
                "warnings": resp.get("x_ditactic", {}).get("warnings", []),
            })
            if i % 25 == 0:
                print(f"[{lang}] {i} rows, running WER {100 * word_error_rate([norm_strict(r['ref']) for r in rows], [norm_strict(r['hyp']) for r in rows]):.2f}", file=sys.stderr)
        report["languages"][lang] = {"summary": summarize(rows), "rows": rows}
        print(f"{lang}: {json.dumps(report['languages'][lang]['summary'])}")
    args.out_dir.mkdir(parents=True, exist_ok=True)
    out = args.out_dir / f"fleurs_{tag}{'_raw' if args.raw else ''}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
