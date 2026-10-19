# Evaluation

Measures the engine end to end (decode + guards + normaliser) or the raw Whisper
output (`--raw`), through HTTP against a running engine or in-process.

```bash
# public benchmark, three languages, 200 utterances each
python eval/run_fleurs.py --engine-url http://127.0.0.1:8321 --api-key $ASR_API_KEY --langs hr sr bs --limit 200
python eval/run_fleurs.py --model turbo --langs hr --raw          # in-process, raw Whisper text

# private medical dev set (manifest from training/prepare_data.py or hand-made)
python eval/run_private.py data/private/dev.jsonl --engine-url http://127.0.0.1:8321 --api-key $ASR_API_KEY

# table
python eval/report.py --out eval/results/REPORT.md
```

Metrics (see `text_norm.py`, unit-tested):

| metric | normalisation |
|---|---|
| `wer_strict`, `cer_strict` | lowercase, Cyrillic -> Latin, punctuation removed |
| `wer_loose`, `cer_loose` | strict + diacritics folded (č/ć→c, š→s, ž→z, đ→dj) |
| `term_recall` | share of glossary/medical terms in the reference that appear in the hypothesis (loose) |
| RTF | wall-clock / audio seconds |

Baselines to beat on FLEURS hr test (WER strict): `openai/whisper-large-v3-turbo`
12.73, `GoranS/whisper-large-v3-turbo-hr` 8.66 (published; re-measure here
because the normaliser and the strict scorer differ from the papers').

`results/*.json` are git-ignored except `REPORT.md`; commit the report, not the
per-utterance dumps (they contain reference text).

FLEURS language configs: `hr_hr`, `sr_rs` (Cyrillic references, transliterated
by `norm_strict`), `bs_ba`.
