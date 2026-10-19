# Architecture

```
 page (Vue)                      Laravel host                         engine
 useDictation ──upload──▶ POST {mount}/            ──queue job──▶ POST /v1/audio/transcriptions
             ◀──poll────  GET  {mount}/{uuid}      ◀──verbose_json──  (whisper + glossary + normaliser)
                          PATCH {mount}/{uuid}        (transcript_corrected)
                          GET  {mount}/{uuid}/audio   (stream, private)
```

## Components

- **engine/** — stateless HTTP service. Decodes any browser/phone container with
  ffmpeg, runs faster-whisper (CTranslate2) with a per-language medical prompt and
  glossary hotwords, filters hallucinations, then applies a deterministic BHS
  medical normaliser (spoken punctuation, numbers, units, abbreviations, Latin
  terms). Audio only ever touches tmpfs.
- **packages/laravel** — owns the `dictation_recordings` table and the audio
  files. The host app decides *who* may record on *what* through a
  `RecordingAuthorizer` and an `OwnerResolver`; recordings attach to any model
  via a morph (`recordable`). The `TranscribeRecording` job talks to the engine
  through the `openai_compatible` driver and stores the raw and normalised text;
  the doctor's correction is kept separately in `transcript_corrected`.
- **packages/vue** — `useRecorder` picks a source at runtime: `MediaRecorder`
  in a normal browser, or the native bridge when `window.__DICTATION_BRIDGE__`
  exists (page inside a React Native WebView). `useDictation` adds upload and
  status polling. Components are thin and themable with `--dct-*` variables.
- **packages/react-native** — `useDictationRecorder` (expo-audio, AAC 16 kHz
  mono) for native screens, and `useDictationBridge` that implements the
  protocol for a `react-native-webview`: records on request and streams the
  file back to the page as base64 chunks, so the page uploads with its own
  session and the shell never needs web credentials.
- **packages/protocol** — the message contract shared by the two JS packages.

## Why a bridge instead of `getUserMedia` inside the WebView

`getUserMedia` works in WKWebView/Android WebView only with extra permission
plumbing, has no control over the audio session, and dies on interruptions.
Native recording through `expo-audio` is predictable, produces small AAC files
and keeps working when a call comes in. Pages opened outside the app keep
using `MediaRecorder`; the same Vue code serves both.

## Data flow for one dictation

1. Page: `start()` → mic permission → recording (level meter, timer).
2. Page: `finish()` → `Blob` (webm/opus from Chrome, mp4/aac from Safari or the
   native bridge) → `POST {mount}/` with `language`, `context[...]`,
   `recordable_type/id`.
3. Laravel: validates mime/size, authorises, stores the file on the configured
   disk under `{owner}/{uuid}.{ext}`, inserts `status=pending`, dispatches the job.
4. Worker: `processing` → engine call (prompt = host glossary terms +
   `context.field_label`) → `transcript_raw`, `transcript`, `segments`,
   `done` (or `failed` + `error`). Optional LLM clean-up runs here when enabled.
5. Page: polls `GET {mount}/{uuid}` until `done`, inserts `final_text` into the
   field; the recording stays listed on the owning object with playback,
   correction and delete.

## Languages

`bs`, `hr`, `sr` or `auto`. Whisper has little Bosnian training data, so the
engine decodes `bs` with the `hr` token by default (`ASR_DECODE_LANG_MAP=bs:hr`)
and reports the requested language back. Serbian Cyrillic output is
transliterated to Latin. The doctor's ekavica/ijekavica is never rewritten.
