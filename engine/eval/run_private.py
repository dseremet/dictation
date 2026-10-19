"""WER/CER + medical-term recall on a private manifest (``{"audio","text","language"}`` JSONL).

    python eval/run_private.py data/private/dev.jsonl --engine-url http://127.0.0.1:8321 --api-key $KEY
    python eval/run_private.py data/private/dev.jsonl --model turbo --terms extra_terms.txt

Term recall uses the engine glossary (canonical spellings) plus ``--terms``
(one per line). Audio is decoded with ffmpeg to 16 kHz mono like the server does.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from asr_engine.audio.decode import decode_to_pcm
from asr_engine.normalizer import load_glossary
from eval._client import make_backend, pcm_to_wav_bytes
from eval.run_fleurs import summarize
from eval.text_norm import medical_term_recall


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest", type=Path)
    ap.add_argument("--engine-url")
    ap.add_argument("--api-key")
    ap.add_argument("--model", default="turbo")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--terms", type=Path, help="extra terms, one per line")
    ap.add_argument("--glossary-dir", type=Path, default=Path(__file__).resolve().parents[1] / "glossary")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--raw", action="store_true")
    ap.add_argument("--tag", default="private")
    ap.add_argument("--out-dir", type=Path, default=Path(__file__).parent / "results")
    args = ap.parse_args(argv)

    backend = make_backend(args)
    glossary = load_glossary(args.glossary_dir)
    terms = [t.canonical for t in glossary.terms if t.category not in {"dialect", "section"}]
    if args.terms:
        terms += [line.strip() for line in args.terms.read_text(encoding="utf-8").splitlines() if line.strip()]

    rows = []
    base = args.manifest.parent
    with args.manifest.open(encoding="utf-8") as fh:
        for i, line in enumerate(fh):
            if not line.strip() or (args.limit and i >= args.limit):
                continue
            item = json.loads(line)
            audio = Path(item["audio"])
            if not audio.is_absolute():
                audio = base / audio
            pcm = decode_to_pcm(audio, max_seconds=600)
            t0 = time.monotonic()
            resp = backend.transcribe(pcm_to_wav_bytes(pcm, 16000), item.get("language", "bs"))
            rows.append({"id": item.get("id", audio.name), "ref": item["text"], "hyp": resp.get("text", ""),
                         "language": item.get("language", "bs"), "duration": len(pcm) / 16000,
                         "wall_s": time.monotonic() - t0, "warnings": resp.get("x_ditactic", {}).get("warnings", [])})
    summary = summarize(rows)
    recall, occurrences = medical_term_recall([r["ref"] for r in rows], [r["hyp"] for r in rows], terms)
    summary["term_recall"] = 100 * recall
    summary["term_occurrences"] = occurrences
    by_lang = {}
    for lang in sorted({r["language"] for r in rows}):
        by_lang[lang] = summarize([r for r in rows if r["language"] == lang])
    report = {"tag": args.tag, "raw": args.raw, "summary": summary, "by_language": by_lang, "rows": rows}
    args.out_dir.mkdir(parents=True, exist_ok=True)
    out = args.out_dir / f"private_{args.tag}{'_raw' if args.raw else ''}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"wrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
