"""LoRA fine-tuning of Whisper (large-v3-turbo) for BHS with transformers + peft.

    python training/train_lora.py --config training/configs/lora_turbo_bhs.yaml \
        [--base-model ...] [--output-dir ...] [--max-steps 50]   # smoke run

Reads the manifests from prepare_data.py, applies SpecAugment, trains LoRA
adapters on encoder+decoder attention/MLP projections in bf16, evaluates WER
(strict and diacritic-insensitive, eval/text_norm.py) on the dev manifest and on
a FLEURS slice, saves the adapter to ``output_dir/adapter``. One 24 GB GPU is
enough with batch 8 x accumulation 4; ~200 h take 6-8 h on an A100.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from eval.text_norm import norm_loose, norm_strict, word_error_rate

LANG_NAMES = {"hr": "croatian", "sr": "serbian", "bs": "bosnian", "sl": "slovenian", "en": "english"}


def load_config(path: Path, overrides: dict[str, Any]) -> dict[str, Any]:
    cfg = yaml.safe_load(path.read_text(encoding="utf-8"))
    for key, value in overrides.items():
        if value is not None:
            cfg[key] = value
    return cfg


def read_manifest(path: Path) -> list[dict[str, Any]]:
    with Path(path).open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def resolve_language_token(language: str, token_map: dict[str, str]) -> str:
    return LANG_NAMES.get(token_map.get(language, language), "croatian")


@dataclass
class Collator:
    """Pads input features and labels; masks the pad tokens and the leading BOS in labels."""

    processor: Any
    decoder_start_token_id: int

    def __call__(self, features: list[dict[str, Any]]) -> dict[str, Any]:
        import torch

        inputs = [{"input_features": f["input_features"]} for f in features]
        batch = self.processor.feature_extractor.pad(inputs, return_tensors="pt")
        labels = self.processor.tokenizer.pad([{"input_ids": f["labels"]} for f in features], return_tensors="pt")
        label_ids = labels["input_ids"].masked_fill(labels["attention_mask"].ne(1), -100)
        if (label_ids[:, 0] == self.decoder_start_token_id).all().cpu().item():
            label_ids = label_ids[:, 1:]
        batch["labels"] = label_ids
        batch["input_features"] = batch["input_features"].to(torch.bfloat16)
        return batch


def build_dataset(rows: list[dict[str, Any]], processor: Any, cfg: dict[str, Any]):
    """Manifest rows -> HF dataset with log-mel features and label ids (lazy audio decoding)."""
    from datasets import Audio, Dataset

    token_map = cfg.get("language_token_map", {})
    max_seconds = float(cfg["training"].get("max_audio_seconds", 30))
    hf_rows = [r for r in rows if not str(r["audio"]).startswith("hf://")]  # hf:// refs are resolved by prepare_data users
    ds = Dataset.from_list(hf_rows).cast_column("audio", Audio(sampling_rate=16000))

    def prepare(example: dict[str, Any]) -> dict[str, Any]:
        audio = example["audio"]
        array = audio["array"][: int(max_seconds * 16000)]
        features = processor.feature_extractor(array, sampling_rate=16000).input_features[0]
        processor.tokenizer.set_prefix_tokens(language=resolve_language_token(example["language"], token_map), task=cfg.get("task", "transcribe"))
        labels = processor.tokenizer(example["text"]).input_ids
        return {"input_features": features, "labels": labels, "label_len": len(labels)}

    ds = ds.map(prepare, remove_columns=ds.column_names, num_proc=cfg["training"].get("dataloader_num_workers", 1) or 1)
    return ds.filter(lambda ex: ex["label_len"] <= int(cfg["training"].get("max_label_length", 448)))


def load_fleurs_rows(language: str, limit: int) -> list[dict[str, Any]]:
    from datasets import load_dataset

    ds = load_dataset("google/fleurs", f"{language}_{ {'hr': 'hr', 'sr': 'rs', 'bs': 'ba'}[language] }", split="validation", streaming=True)
    rows = []
    for i, ex in enumerate(ds):
        if i >= limit:
            break
        rows.append({"audio": ex["audio"], "text": ex["raw_transcription"], "language": language, "domain": "fleurs"})
    return rows


def make_compute_metrics(processor: Any):
    def compute(pred) -> dict[str, float]:
        label_ids = pred.label_ids.copy()
        label_ids[label_ids == -100] = processor.tokenizer.pad_token_id
        hyps = processor.tokenizer.batch_decode(pred.predictions, skip_special_tokens=True)
        refs = processor.tokenizer.batch_decode(label_ids, skip_special_tokens=True)
        return {
            "wer": 100 * word_error_rate([norm_strict(r) for r in refs], [norm_strict(h) for h in hyps]),
            "wer_loose": 100 * word_error_rate([norm_loose(r) for r in refs], [norm_loose(h) for h in hyps]),
        }

    return compute


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=Path(__file__).parent / "configs" / "lora_turbo_bhs.yaml")
    ap.add_argument("--base-model")
    ap.add_argument("--output-dir")
    ap.add_argument("--max-steps", type=int, default=None, help="smoke-test: stop after N steps")
    ap.add_argument("--no-fleurs", action="store_true")
    args = ap.parse_args(argv)
    cfg = load_config(args.config, {"base_model": args.base_model, "output_dir": args.output_dir})

    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import (
        Seq2SeqTrainer,
        Seq2SeqTrainingArguments,
        WhisperForConditionalGeneration,
        WhisperProcessor,
    )

    tcfg = cfg["training"]
    processor = WhisperProcessor.from_pretrained(cfg["base_model"])
    model = WhisperForConditionalGeneration.from_pretrained(cfg["base_model"], torch_dtype=torch.bfloat16)
    model.config.forced_decoder_ids = None
    model.config.suppress_tokens = []
    model.generation_config.forced_decoder_ids = None
    sa = cfg.get("spec_augment", {})
    if sa.get("enabled"):
        model.config.apply_spec_augment = True
        model.config.mask_time_prob = sa.get("mask_time_prob", 0.05)
        model.config.mask_time_length = sa.get("mask_time_length", 10)
        model.config.mask_feature_prob = sa.get("mask_feature_prob", 0.05)
        model.config.mask_feature_length = sa.get("mask_feature_length", 10)
    if tcfg.get("gradient_checkpointing"):
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()

    lcfg = cfg["lora"]
    model = get_peft_model(
        model,
        LoraConfig(r=lcfg["r"], lora_alpha=lcfg["alpha"], lora_dropout=lcfg.get("dropout", 0.05), target_modules=lcfg["target_modules"], bias="none"),
    )
    model.print_trainable_parameters()

    train_ds = build_dataset(read_manifest(Path(cfg["manifests"]["train"])), processor, cfg)
    dev_rows = read_manifest(Path(cfg["manifests"]["dev"]))
    if not args.no_fleurs and cfg["manifests"].get("fleurs_dev_lang"):
        dev_rows += load_fleurs_rows(cfg["manifests"]["fleurs_dev_lang"], int(cfg["manifests"].get("fleurs_dev_rows", 300)))
    dev_ds = build_dataset(dev_rows, processor, cfg)

    training_args = Seq2SeqTrainingArguments(
        output_dir=cfg["output_dir"],
        per_device_train_batch_size=tcfg["per_device_train_batch_size"],
        gradient_accumulation_steps=tcfg["gradient_accumulation_steps"],
        per_device_eval_batch_size=tcfg["per_device_eval_batch_size"],
        learning_rate=float(tcfg["learning_rate"]),
        warmup_steps=tcfg["warmup_steps"],
        num_train_epochs=tcfg["num_train_epochs"],
        max_steps=args.max_steps if args.max_steps else -1,
        bf16=tcfg.get("precision", "bf16") == "bf16",
        eval_strategy="steps",
        eval_steps=tcfg["eval_steps"],
        save_steps=tcfg["save_steps"],
        logging_steps=tcfg["logging_steps"],
        predict_with_generate=True,
        generation_max_length=tcfg["generation_max_length"],
        remove_unused_columns=False,
        label_names=["labels"],
        dataloader_num_workers=tcfg.get("dataloader_num_workers", 2),
        report_to=tcfg.get("report_to", ["none"]),
        seed=tcfg.get("seed", 13),
        load_best_model_at_end=True,
        metric_for_best_model="wer",
        greater_is_better=False,
        save_total_limit=3,
    )
    trainer = Seq2SeqTrainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=dev_ds,
        data_collator=Collator(processor, model.config.decoder_start_token_id),
        compute_metrics=make_compute_metrics(processor),
        processing_class=processor.feature_extractor,
    )
    trainer.train()
    adapter_dir = Path(cfg["output_dir"]) / "adapter"
    model.save_pretrained(adapter_dir)
    processor.save_pretrained(adapter_dir)
    metrics = trainer.evaluate()
    (Path(cfg["output_dir"]) / "final_metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
