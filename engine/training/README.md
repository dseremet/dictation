# Training

Fine-tuning recipe for `ditactic/whisper-large-v3-turbo-bhs-medical`. None of
this runs in the serving image; it needs one GPU with 24 GB (A10/3090/4090/A100).

```bash
pip install -r requirements-train.txt

# 1. manifests (train.jsonl / dev.jsonl, speaker-disjoint dev)
python training/prepare_data.py --out data/manifests \
    --hours-hr 200 --hours-rs 100 \
    --cv-hr data/cv/hr --cv-sr data/cv/sr \
    --private data/private --private-upsample 4

# 2. (optional) re-normalise or filter targets
python training/normalize_targets.py data/manifests/train.jsonl data/manifests/train.norm.jsonl

# 3. LoRA training (bf16, r=32/α=64 on q,k,v,out,fc1,fc2 of encoder+decoder, SpecAugment,
#    lr 1e-4, effective batch 32, 2 epochs, eval on dev + FLEURS hr validation)
python training/train_lora.py --config training/configs/lora_turbo_bhs.yaml
python training/train_lora.py --config training/configs/lora_turbo_bhs.yaml --max-steps 30   # smoke

# 4. merge + CTranslate2 (int8 for CPU, float16 for GPU) + model card
python training/merge_and_convert.py --adapter runs/turbo-bhs-lora/adapter \
    --out models/whisper-large-v3-turbo-bhs-medical --quantization int8 float16 \
    --metrics runs/turbo-bhs-lora/final_metrics.json

# 5. serve it
ASR_MODEL=/models/whisper-large-v3-turbo-bhs-medical/ct2-int8 docker compose up -d
```

## Data mix

| source | licence | share | notes |
|---|---|---|---|
| ParlaSpeech-HR (`classla/ParlaSpeech-HR`) | CC BY-SA 4.0 | 50 % | 200 h subset, whole speakers |
| ParlaSpeech-RS (`classla/ParlaSpeech-RS`) | CC BY-SA 4.0 | 25 % | 100 h subset, Cyrillic targets transliterated |
| Common Voice hr + sr | CC0 | 5 % | validated clips only |
| private medical dictations | — | 20 % | upsampled ×4, see `private_dataset_spec.md` |

Targets keep casing and punctuation, Latin script only, dialect untouched.
Bosnian rows are trained with the Croatian language token
(`language_token_map: {bs: hr}`), mirroring `ASR_DECODE_LANG_MAP=bs:hr` in
the engine; evaluate on FLEURS `bs_ba` before changing either.

## Budget

~200 h, 2 epochs, batch 32: 6–8 h on an A100-40GB (≈ $15–30 on a rented
instance), ~12 h on a 4090. Peak memory ≈ 18 GB with gradient checkpointing.

## Files

| file | purpose |
|---|---|
| `prepare_data.py` | loaders, speaker-based subsetting, mixing, manifests |
| `normalize_targets.py` | pure target normalisation + acceptance filter (unit-tested) |
| `train_lora.py` | transformers + peft training loop |
| `merge_and_convert.py` | merge adapter, CT2 conversion, model card, optional Hub upload |
| `configs/lora_turbo_bhs.yaml` | all hyper-parameters |
| `private_dataset_spec.md` | how the private set must look |

ParlaSpeech column names on the Hub have changed between releases; if
`prepare_data.py` yields zero rows, check `TEXT_KEYS`/`SPEAKER_KEYS` in
`load_parlaspeech`.
