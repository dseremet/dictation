"""Merge a LoRA adapter into the base Whisper weights and convert to CTranslate2.

    python training/merge_and_convert.py --adapter runs/turbo-bhs-lora/adapter \
        --base openai/whisper-large-v3-turbo --out models/whisper-large-v3-turbo-bhs-medical \
        --quantization int8 float16 [--push ditactic/faster-whisper-large-v3-turbo-bhs-medical]

Produces ``<out>/hf`` (merged transformers checkpoint + model card) and
``<out>/ct2-<quant>`` directories that ``ASR_MODEL`` can point at.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

MODEL_CARD = """---
language: [hr, bs, sr]
license: mit
library_name: ctranslate2
tags: [whisper, faster-whisper, speech-recognition, medical, bhs]
base_model: {base}
---

# {name}

Whisper large-v3-turbo fine-tuned (LoRA, merged) for Bosnian/Croatian/Serbian
medical dictation, converted to CTranslate2 (`{quants}`) for faster-whisper.
Built with [ditactic/dictation](https://github.com/dseremet/dictation) on {today}.

## Usage

```bash
ASR_MODEL={name} docker compose up -d      # ditactic ASR engine
```

```python
from faster_whisper import WhisperModel
model = WhisperModel("{name}", compute_type="int8")
segments, info = model.transcribe("nalaz.wav", language="hr", beam_size=5)
```

## Training data

{data}

## Evaluation

{eval}
"""


def merge(base: str, adapter: Path, out_hf: Path) -> None:
    import torch
    from peft import PeftModel
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    model = WhisperForConditionalGeneration.from_pretrained(base, torch_dtype=torch.float16)
    model = PeftModel.from_pretrained(model, str(adapter)).merge_and_unload()
    model.generation_config.forced_decoder_ids = None
    out_hf.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out_hf, safe_serialization=True)
    WhisperProcessor.from_pretrained(base).save_pretrained(out_hf)


def convert(out_hf: Path, out_ct2: Path, quantization: str) -> None:
    cmd = [
        "ct2-transformers-converter", "--model", str(out_hf), "--output_dir", str(out_ct2),
        "--quantization", quantization, "--copy_files", "tokenizer.json", "preprocessor_config.json", "--force",
    ]
    subprocess.run(cmd, check=True)


def write_card(out_dir: Path, name: str, base: str, quants: list[str], metrics: Path | None, data_note: str) -> None:
    eval_text = "See `eval/results/` in the repository."
    if metrics and metrics.is_file():
        m = json.loads(metrics.read_text())
        eval_text = "| metric | value |\n|---|---|\n" + "\n".join(f"| {k} | {v:.2f} |" for k, v in m.items() if isinstance(v, int | float))
    card = MODEL_CARD.format(name=name, base=base, quants=", ".join(quants), today=date.today().isoformat(), data=data_note, eval=eval_text)
    (out_dir / "README.md").write_text(card, encoding="utf-8")
    for q in quants:
        shutil.copy(out_dir / "README.md", out_dir / f"ct2-{q}" / "README.md")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--adapter", type=Path, required=True)
    ap.add_argument("--base", default="openai/whisper-large-v3-turbo")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--name", default="ditactic/faster-whisper-large-v3-turbo-bhs-medical")
    ap.add_argument("--quantization", nargs="+", default=["int8", "float16"])
    ap.add_argument("--metrics", type=Path, help="final_metrics.json from train_lora.py")
    ap.add_argument("--data-note", default="ParlaSpeech-HR/RS subsets, Common Voice hr/sr, private de-identified medical dictations (not released).")
    ap.add_argument("--push", metavar="REPO_ID", help="upload the CT2 int8 directory to the Hub")
    ap.add_argument("--skip-merge", action="store_true", help="reuse <out>/hf")
    args = ap.parse_args(argv)

    out_hf = args.out / "hf"
    if not args.skip_merge:
        merge(args.base, args.adapter, out_hf)
    for q in args.quantization:
        convert(out_hf, args.out / f"ct2-{q}", q)
    write_card(args.out, args.name, args.base, args.quantization, args.metrics, args.data_note)
    if args.push:
        from huggingface_hub import HfApi

        HfApi().upload_folder(repo_id=args.push, folder_path=str(args.out / f"ct2-{args.quantization[0]}"), repo_type="model")
    print(f"done: {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
