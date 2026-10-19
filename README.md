# Speech to text

Open-source speech-to-text for **Bosnian, Croatian and Serbian medical
dictation** (Latin script, Latin medical terminology). Doctors press a mic on
desktop or mobile, speak, and get the text plus the recording attached to the
patient record.

| Part | What it is |
|---|---|
| [`engine/`](engine/) | Self-hosted ASR engine (Python, FastAPI, faster-whisper). OpenAI-compatible `POST /v1/audio/transcriptions`, BHS medical normaliser and glossary, fine-tuning and evaluation pipeline. |
| [`packages/laravel`](packages/laravel/) | `ditactic/dictation-laravel`: recordings storage, queue job, upload/stream/correct endpoints, authorizer contract, optional LLM clean-up. |
| [`packages/vue`](packages/vue/) | `@ditactic/dictation-vue`: `useRecorder`/`useDictation` composables, `<DictationButton>`, `<DictationRecordingList>`. Records with `MediaRecorder`, or through the native bridge when running inside a React Native WebView. |
| [`packages/react-native`](packages/react-native/) | `@ditactic/dictation-react-native`: `expo-audio` recorder hook and the WebView bridge that records on behalf of a web page. |
| [`packages/protocol`](packages/protocol/) | `@ditactic/dictation-protocol`: the WebView bridge message contract shared by the Vue and React Native packages. |

## How it fits together

```
 browser / WebView                 Laravel app                      engine (Docker)
 ┌──────────────────┐   upload     ┌──────────────────────┐  HTTP   ┌────────────────────┐
 │ <DictationButton>│ ──────────▶ │ POST /recordings      │ ──────▶ │ /v1/audio/         │
 │ MediaRecorder or │             │ store file, queue job │         │   transcriptions   │
 │ native bridge    │ ◀────────── │ GET /recordings/{id}  │ ◀────── │ whisper + glossary │
 └──────────────────┘   poll      └──────────────────────┘  json    │ + BHS normaliser   │
        ▲  │ postMessage                                            └────────────────────┘
        │  ▼
 ┌──────────────────┐
 │ RN shell:        │
 │ useDictationBridge│ records with expo-audio, streams the file back as base64 chunks
 └──────────────────┘
```

The engine speaks the OpenAI transcription API, so the Laravel driver can be
pointed at the self-hosted engine (default) or at any compatible hosted API.

## Quick start

```bash
# 1. Engine
cd engine && cp .env.example .env && docker compose -f docker-compose.example.yml up -d

# 2. Laravel
composer require ditactic/dictation-laravel
php artisan vendor:publish --tag=dictation-config --tag=dictation-migrations && php artisan migrate

# 3. Vue
npm i @ditactic/dictation-vue
```

See each package README for details and `docs/` for architecture, the bridge
protocol and deployment notes.

## Development

```bash
npm install            # JS workspaces (protocol, vue, react-native)
npm test               # JS tests
npm run test:laravel   # PHP tests (Orchestra Testbench, SQLite in-memory)
npm run test:engine    # Python tests (runs in Docker)
```

## License

MIT © diTactic Media
