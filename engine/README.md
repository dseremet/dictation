# ditactic ASR engine

Self-hosted speech-to-text for **Bosnian / Croatian / Serbian medical dictation**.
FastAPI + [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2),
an OpenAI-compatible `POST /v1/audio/transcriptions`, a medical glossary that
feeds Whisper's `hotwords`, hallucination guards, and a BHS normaliser that turns
*"pritisak sto dvadeset sa osamdeset tačka"* into **`Pritisak 120/80.`**

```
upload ─▶ sniff magic bytes ─▶ ffmpeg → 16 kHz mono ─▶ language (auto ⊂ {hr,bs,sr})
      ─▶ faster-whisper (beam 5, VAD, hotwords = glossary) ─▶ guards ─▶ normaliser ─▶ JSON
```

Default model: `deepdml/faster-whisper-large-v3-turbo-ct2`, `int8` on CPU.
Bosnian is decoded with the Croatian token (`ASR_DECODE_LANG_MAP=bs:hr`).

## Install (Docker, recommended)

```bash
cd engine
cp .env.example .env            # set ASR_API_KEYS
docker compose -f docker-compose.example.yml up -d --build
docker compose -f docker-compose.example.yml logs -f    # first start downloads ~1.6 GB into the models volume
curl -s http://dictation-engine:8000/health             # from another container; see "Smoke test" for localhost
```

The example compose file runs the container **read-only, non-root, `cap_drop: ALL`,
no published ports**, with `/tmp` on tmpfs. Audio never touches a disk: the
upload goes to `/tmp/asr/<uuid>`, is decoded to memory and deleted before the
response is sent. Other services reach it at `http://dictation-engine:8000` on
the compose network; for a local smoke test uncomment the
`127.0.0.1:8321:8000` port mapping.

Images: `Dockerfile.cpu` (python:3.11-slim + ffmpeg), `Dockerfile.cuda`
(CUDA 12.4 + cuDNN runtime, `float16`), `Dockerfile.convert` (transformers →
CTranslate2 conversion, `make convert`), `Dockerfile.dev` (tests).

Without Docker: Python 3.11, `ffmpeg` on `PATH`,
`pip install -r requirements.txt`, `python -m asr_engine.main`.

## API

OpenAI-compatible, so any OpenAI SDK / client works with `base_url` pointed here.

| route | auth | notes |
|---|---|---|
| `POST /v1/audio/transcriptions` | bearer | multipart form, see fields below |
| `GET /v1/models` | bearer | the one loaded model |
| `GET /health` | none | `200 {"status":"ok",…}` or `503 {"status":"loading"}` while weights load |

Form fields: `file` (required; webm/opus, mp4/m4a/aac, wav, ogg, mp3, flac — detected
from magic bytes, the MIME type is ignored), `model` (ignored, one model per server),
`language` `bs|hr|sr|auto` (default `ASR_DEFAULT_LANGUAGE`), `prompt` (free text,
≤ 96 tokens together with the style header), `response_format` `json|verbose_json|text`,
`temperature` 0–1, `timestamp_granularities[]` `segment|word`.
Extensions ignored by real OpenAI: `glossary` — JSON array of
`"term"` or `{"canonical","variants":[…],"weight"}` merged in front of the built-in
glossary for this request (hotwords + normaliser), and `normalize` `true|false`
(default `true`).

`verbose_json` response: OpenAI fields `task, language, duration, text, segments[], words?`
plus

```json
"x_ditactic": {
  "model": "deepdml/faster-whisper-large-v3-turbo-ct2", "compute_type": "int8", "device": "cpu",
  "raw_text": "pritisak sto dvadeset sa osamdeset tačka",
  "normalized": true, "language_probability": 0.91, "decode_language": "hr",
  "duration_after_vad": 3.4, "processing_ms": 2210,
  "warnings": ["segment_dropped:hallucination:4"], "glossary_version": "939c3322a94e"
}
```

`text` is normalised, `raw_text` is Whisper's output; segment texts stay raw.
Errors use the OpenAI envelope `{"error":{"message","type","param","code"}}`:
400 (empty/undecodable), 401, 413 (`file_too_large`, `audio_too_long`), 415
(unknown container), 422 (bad parameter), 503 (`loading`, `busy` with `Retry-After`),
504 (timeout). Logs never contain transcript, prompt or glossary text.

### Smoke test

With the port mapping enabled (`127.0.0.1:8321`):

```bash
curl -s http://127.0.0.1:8321/health
curl -s http://127.0.0.1:8321/v1/audio/transcriptions \
  -H "Authorization: Bearer $ASR_API_KEY" \
  -F file=@sample.webm -F language=hr -F response_format=verbose_json \
  -F 'glossary=["Botox","Juvederm"]' | jq '{text, raw: .x_ditactic.raw_text, warnings: .x_ditactic.warnings}'
```

## Environment variables

| variable | default | meaning |
|---|---|---|
| `ASR_MODEL` | `deepdml/faster-whisper-large-v3-turbo-ct2` | alias (`turbo`, `large-v3`, `medium`, `small`, `base`, `tiny`), HF CTranslate2 repo, or a directory (absolute, or relative to `ASR_CACHE_DIR`) |
| `ASR_DEVICE` | `auto` | `auto` \| `cpu` \| `cuda` |
| `ASR_COMPUTE_TYPE` | `int8` | `int8`, `int8_float16`, `float16`, `float32`; falls back to a supported type |
| `ASR_CPU_THREADS` | `0` | CTranslate2 intra-op threads (0 = library default) |
| `ASR_NUM_WORKERS` | `1` | CTranslate2 workers (parallel decodes inside one model) |
| `ASR_MAX_CONCURRENCY` | `1` | concurrent decodes (1 on 8 vCPU, 2 on 16) |
| `ASR_QUEUE_DEPTH` | `4` | requests allowed to wait for a slot before `503 busy` |
| `ASR_REQUEST_TIMEOUT_S` | `600` | decode time limit per request (`504`) |
| `ASR_API_KEYS` | *(empty = no auth)* | comma-separated bearer tokens, compared with `compare_digest` |
| `ASR_DEFAULT_LANGUAGE` | `auto` | used when the request has no `language` |
| `ASR_DECODE_LANG_MAP` | `bs:hr` | decode language overrides, `src:dst,…` |
| `ASR_GLOSSARY_DIR` | `./glossary` | YAML glossary root (see `glossary/README.md`) |
| `ASR_CACHE_DIR` | `/models` | model download/cache volume |
| `ASR_TMP_DIR` | `/tmp/asr` | per-request working dir (keep it on tmpfs) |
| `ASR_MAX_UPLOAD_MB` | `50` | `413` above this |
| `ASR_MAX_AUDIO_SECONDS` | `600` | `413` above this (decoding stops at limit + 10 s) |
| `ASR_FFMPEG_TIMEOUT_S` | `60` | ffmpeg wall-clock limit |
| `ASR_BEAM_SIZE` / `ASR_BEST_OF` | `5` / `5` | decoding width |
| `ASR_PROMPT_TOKEN_BUDGET` / `ASR_HOTWORDS_TOKEN_BUDGET` | `96` / `96` | token caps |
| `ASR_MIN_SPEECH_SECONDS` | `0.5` | below this (after VAD) the text is empty with warning `no_speech` |
| `ASR_DOCS_ENABLED` | `false` | Swagger UI at `/docs` |
| `ASR_LOG_LEVEL` | `info` | |
| `ASR_HOST` / `ASR_PORT` | `0.0.0.0` / `8000` | |
| `HF_HUB_OFFLINE` | `0` | set `1` once the weights are cached |
| `HF_HUB_DISABLE_TELEMETRY` | `1` (in images) | |

## docker-compose (production shape)

```yaml
services:
  dictation-engine:
    image: ditactic/asr-engine:cpu
    env_file: .env
    volumes: [asr-models:/models]
    tmpfs: ["/tmp:size=1g,mode=1777"]
    read_only: true
    user: "10001:10001"
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    # ports: ["127.0.0.1:8321:8000"]      # only if the consumer is not on this network
    deploy: { resources: { limits: { memory: 4g } } }
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8000/health"]
      interval: 30s
      start_period: 10m
    restart: unless-stopped
    stop_grace_period: 11m
volumes:
  asr-models:
```

The full file is `docker-compose.example.yml`.

## Normaliser

Pure functions over Whisper's text, in this order (`asr_engine/normalizer/`):
Cyrillic → Latin + NFC · spoken numbers (`dvjesto pedeset` → `250`, `trideset osam zarez pet` →
`38,5`, `pritisak sto dvadeset sa osamdeset` → `120/80`, `dvije hiljade devetnaeste` → `2019.`;
1–9 stay words unless a unit follows) · spoken commands (`tačka|točka`, `zarez|zapeta`,
`dvotačka`, `nova linija`, `novi pasus`, zagrade, `crtica`, `kosa crta`; `bolna tačka` is
protected) · units (`miligrama` → `mg`, `posto` → `%`, `na sat` → `/h`, `stepeni` → `°C`) ·
glossary terms (misrecognition → canonical, inflection-aware, longest match first) ·
context-gated abbreviations (`EKG`, `CRP`; `TA`/`RR` only before a number or
`uredna|povišena|snižena`; `Dg.`/`Th.` only at line start or before `:`; `tbl.`/`amp.`
only after a number; `p.o.`, `i.v.`, `i.m.`, `s.c.`) · spacing and sentence casing.

It never rewrites dialect: `lijek`/`lek`, `tlak`/`pritisak`, `tjedan`/`sedmica` are all
kept, and `tests/unit/test_dialect_invariance.py` fails if a glossary entry would flip one.
Cases live in `tests/cases/*.yaml`; add a line there before changing a rule.

## Glossary

`glossary/shared/*.yaml` (Latin medical terms, drugs, abbreviations, units) and
`glossary/{bs,hr,sr}/*.yaml` (commands, dialect terms, hallucination phrases).
Terms with `prompt: true` become Whisper `hotwords` ordered by `weight` within 96
tokens; variants drive the normaliser. Format and rules: `glossary/README.md`.
The response reports `glossary_version` (hash of the files) so a Laravel app can
tell which glossary produced a transcript.

## Performance

Fill this table with `make bench ASR_MODEL=turbo BENCH_ARGS="--audio nalaz_5min.wav"`
on the target host (prints a ready-made row).

| model | compute | host | beam | audio | wall | s per audio-minute | RSS |
|---|---|---|---|---|---|---|---|
| large-v3-turbo (ct2) | int8 | 8 vCPU cloud | 5 | 5 min | *≈ 2–4 min (expected)* | *≈ 20–30 (expected)* | *≈ 1.5–2 GB (expected)* |
| small | int8 | 8 vCPU cloud | 5 | 5 min | *≈ 20 s (expected)* | *≈ 3–5 (expected)* | *≈ 0.6 GB (expected)* |
| large-v3-turbo (ct2) | float16 | 1× T4 | 5 | 5 min | *≈ 15 s (expected)* | *≈ 3 (expected)* | — |

Expected numbers are planning values, not measurements. Consequences for the
caller: HTTP timeout 600 s, queue job timeout 660 s, `retry_after` > 660 s, one
decode at a time on 8 vCPU (`ASR_MAX_CONCURRENCY=1`), 4 GB container limit.

## Swapping in fine-tuned weights

1. Train and convert with `training/` (`train_lora.py` → `merge_and_convert.py`), or pull a
   published CTranslate2 repo such as `ditactic/faster-whisper-large-v3-turbo-bhs-medical`.
2. Either set `ASR_MODEL=<hf-repo>` (downloaded into the models volume on start) or copy the
   converted directory into the volume and set `ASR_MODEL=/models/<dir>` (works offline;
   the directory needs `model.bin`, `config.json`, `tokenizer.json`, `preprocessor_config.json`).
3. Restart the container; `/health` reports the new `model`. Check
   `eval/run_fleurs.py` / `eval/run_private.py` before and after.

A transformers checkpoint that is not yet CTranslate2:
`make convert SRC=org/whisper-finetune OUT=whisper-finetune-int8 QUANT=int8`.

## Development

```bash
make test          # builds the dev image once, then pytest -m "not model" (no downloads)
make test-model    # ASR_MODEL=tiny integration tests, ~75 MB into ./models
make lint          # ruff
make fixtures      # regenerate the synthetic wav/webm/m4a fixtures
make bench         # bench/bench_cpu.py
make build-cpu     # production image
```

Layout: `asr_engine/` (api, audio, asr, normalizer, config, auth, main), `glossary/`,
`tests/` (unit, integration `-m model`, `cases/*.yaml`, `fixtures/`), `bench/`,
`training/` (LoRA recipe), `eval/` (WER/CER/term recall).

## Security notes

Bearer tokens compared in constant time; `/docs` off unless `ASR_DOCS_ENABLED=true`;
container read-only and unprivileged; uploads live only on tmpfs and are removed in a
`finally`; logs carry sizes, durations, language codes and warning codes — never text;
`HF_HUB_DISABLE_TELEMETRY=1`. Put the engine on a private network or bind to
`127.0.0.1`; terminate TLS in the reverse proxy and cap request bodies there too.

## Licence

MIT. Whisper weights: MIT (OpenAI); CTranslate2 conversions as published by their authors.
