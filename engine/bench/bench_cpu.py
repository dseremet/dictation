"""CPU throughput benchmark: seconds of processing per minute of audio, peak RSS.

    make bench ASR_MODEL=turbo BENCH_ARGS="--audio path/to/5min.wav --runs 2"
    python bench/bench_cpu.py --audio tests/fixtures/tone_10s.wav --tile 60   # 60 s synthetic

Prints a Markdown row you can paste into README's performance table.
"""

from __future__ import annotations

import argparse
import os
import resource
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from asr_engine.asr.engine import AsrEngine
from asr_engine.asr.prompt import STYLE_HEADERS, build_hotwords
from asr_engine.asr.types import TranscribeOptions
from asr_engine.audio.decode import decode_to_pcm, duration_seconds
from asr_engine.config import get_settings
from asr_engine.normalizer import load_glossary


def peak_rss_mb() -> float:
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return rss / (1024 * 1024) if sys.platform == "darwin" else rss / 1024


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--audio", default="tests/fixtures/tone_10s.wav")
    ap.add_argument("--tile", type=float, default=0, help="repeat the clip up to this many seconds")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--language", default="hr")
    ap.add_argument("--beam", type=int, default=None)
    args = ap.parse_args()

    settings = get_settings()
    engine = AsrEngine(settings)
    t0 = time.monotonic()
    engine.load()
    load_s = time.monotonic() - t0

    pcm = decode_to_pcm(Path(args.audio), max_seconds=3600)
    if args.tile and duration_seconds(pcm) < args.tile:
        reps = int(np.ceil(args.tile / duration_seconds(pcm)))
        pcm = np.tile(pcm, reps)[: int(args.tile * 16000)]
    audio_s = duration_seconds(pcm)
    glossary = load_glossary(settings.glossary_dir)
    opts = TranscribeOptions(
        language=args.language,
        initial_prompt=STYLE_HEADERS[args.language],
        hotwords=build_hotwords(glossary.prompt_terms(), engine.count_tokens, settings.hotwords_token_budget),
        beam_size=args.beam or settings.beam_size,
        best_of=settings.best_of,
    )
    times = []
    for _ in range(args.runs):
        t1 = time.monotonic()
        result = engine.transcribe(pcm, opts)
        times.append(time.monotonic() - t1)
    best = min(times)
    per_min = best / max(audio_s, 1e-6) * 60
    cpus = os.cpu_count() or 0
    print(
        f"| {settings.model} | {engine.info.compute_type} | {cpus} vCPU | beam {opts.beam_size} | "
        f"{audio_s:.0f} s audio | {best:.1f} s | {per_min:.1f} s/min | load {load_s:.1f} s | "
        f"RSS {peak_rss_mb():.0f} MB | segments {len(result.segments)} |"
    )


if __name__ == "__main__":
    main()
