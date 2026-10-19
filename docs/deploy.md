# Deploying

## Engine (CPU server next to the Laravel app)

```yaml
# docker-compose.dictation.yml
services:
  dictation-engine:
    image: ghcr.io/dseremet/dictation-engine:cpu   # or build: ./engine (Dockerfile.cpu)
    restart: unless-stopped
    ports: ["127.0.0.1:8321:8000"]      # never expose publicly
    environment:
      ASR_MODEL: deepdml/faster-whisper-large-v3-turbo-ct2
      ASR_COMPUTE_TYPE: int8
      ASR_CPU_THREADS: "8"
      ASR_MAX_CONCURRENCY: "1"
      ASR_API_KEYS: ${DICTATION_ENGINE_TOKEN}
      ASR_DEFAULT_LANGUAGE: bs
      HF_HUB_DISABLE_TELEMETRY: "1"
    volumes:
      - dictation-models:/models
    tmpfs:
      - /tmp/asr:size=512m,mode=1777
    read_only: true
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    mem_limit: 4g
volumes:
  dictation-models: {}
```

First start downloads ~1 GB of weights into the volume; `/health` answers 503
until the model is loaded. Budget 20–30 s of CPU per minute of audio on 8 vCPU.

## Laravel host

```
DICTATION_DRIVER=openai_compatible
DICTATION_ENGINE_URL=http://127.0.0.1:8321
DICTATION_ENGINE_TOKEN=<same as ASR_API_KEYS>
DICTATION_QUEUE=dictation
```

Run a dedicated worker so long transcriptions never delay notification jobs:

```
php artisan queue:work --queue=dictation --timeout=700 --tries=2
```

(`retry_after` on the queue connection must exceed the job timeout.)

## Mobile shell

Add `expo-audio`, `expo-file-system`, `@ditactic/dictation-react-native`,
`@ditactic/dictation-protocol`; configure the `expo-audio` plugin with a
microphone usage string; rebuild the native app (`expo prebuild`).

## Privacy checklist

- Audio stays on your servers: browser → your Laravel → your engine.
- Engine keeps nothing on disk and logs no text.
- Recordings are served only through the authenticated stream route with
  `Cache-Control: private, no-store`.
- The optional LLM clean-up sends transcript *text* to a third party; keep it
  off unless you have the agreements in place.
