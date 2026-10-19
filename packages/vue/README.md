# @ditactic/dictation-vue

Vue 3 composables and components for medical dictation in Bosnian, Croatian and
Serbian. Records with `MediaRecorder` in the browser, or through the native
bridge (`@ditactic/dictation-protocol`) when the page runs inside a React Native
WebView; uploads the audio to `ditactic/dictation-laravel` and waits for the
transcript. No axios dependency: pass any HTTP adapter.

```bash
npm i @ditactic/dictation-vue
```

## Usage (Laravel + axios + Ziggy)

```vue
<script setup>
import axios from 'axios'
import { ref } from 'vue'
import { DictationButton, DictationRecordingList, axiosAdapter } from '@ditactic/dictation-vue'
import '@ditactic/dictation-vue/style.css'

const props = defineProps({ entryId: Number, recordings: Array })
const text = ref('')

const options = {
  http: axiosAdapter(axios),
  endpoints: {
    create: route('partner.carton.dictation.store'),
    show: (uuid) => route('partner.carton.dictation.show', uuid),
    update: (uuid) => route('partner.carton.dictation.update', uuid),
    destroy: (uuid) => route('partner.carton.dictation.destroy', uuid),
    audio: (uuid) => route('partner.carton.dictation.audio', uuid),
    retry: (uuid) => route('partner.carton.dictation.retry', uuid),
  },
  language: 'auto',                                        // 'auto' | 'bs' | 'hr' | 'sr'
  context: () => ({ question_key: 'anamneza', field_label: 'Anamneza' }),
  recordable: () => ({ type: 'carton_entry', id: props.entryId }),
}

function append(t) { text.value = text.value ? `${text.value}\n${t}` : t }
</script>

<template>
  <label>Anamneza <DictationButton :options="options" size="sm" @transcript="append($event.text)" /></label>
  <textarea v-model="text" rows="6" />
  <DictationRecordingList :recordings="recordings" :http="options.http" :endpoints="options.endpoints"
    @insert="append($event.text)" />
</template>
```

`axiosAdapter(axios)` sends cookies and the CSRF header exactly as your app
already does. Without axios use `fetchAdapter({ csrfToken: () => token })`,
or write your own `{ post, get, patch, delete }` returning `{ data }`.

## What you get

| Export | Purpose |
|---|---|
| `useRecorder(options)` | `state` (`idle → requesting → recording ⇄ paused → stopping → ready \| error`), `durationMs`, `level` (0..1), `isNative`, `start()`, `pause()`, `resume()`, `stop(): Promise<{ blob, mime, durationMs }>`, `cancel()`. Auto-stops at `maxDurationMs` (10 min), warns on `beforeunload` while recording. Picks `NativeBridgeSource` when `window.__DICTATION_BRIDGE__` exists, else `MediaRecorderSource` (`audio/webm;codecs=opus` → `audio/mp4` → `audio/ogg;codecs=opus`). |
| `useDictation(options)` | Recorder + upload + status: `phase` (`idle \| recording \| uploading \| transcribing \| done \| failed`), `recording` (API DTO), `transcript` (= `final_text`), `error`, `start()`, `finish()`, `cancel()`, `reset()`, `retry()`. Polls `show` with backoff 1.5 s → 5 s (10 min cap) or uses `subscribe(uuid, cb)` (Echo) when supplied. |
| `provideDictation(options)` / `injectDictation()` | Share one instance between a parent and `<DictationButton>` children. |
| `<DictationButton>` | Props `options`, `size` (`sm\|md\|lg`), `disabled`, `messages`, `showLabel`; slots `icon`, `failed-icon`; emits `transcript({ text, recording })`, `recording({ recording })`, `error`, `phase`. |
| `<DictationRecordingList>` | Props `recordings`, `http`, `endpoints`, `canEdit`, `messages`, `confirm`; native `<audio>` player, status pill, text, "Ubaci u polje" (`insert`), "Ispravi" (PATCH `transcript_corrected` → `updated`), "Obriši" (`deleted`), "Pokušaj ponovo" (`retried`). |
| `<DictationLevelMeter :level>` | Tiny input-level bars. |
| `axiosAdapter`, `fetchAdapter`, `defaultMessages`, `errorText`, `formatDuration` | Helpers. |

Upload payload (`POST endpoints.create`, multipart): `audio` (`recording.webm` / `.m4a` / `.ogg`),
`language`, `duration_ms`, `context[key]=value`, `recordable_type`, `recordable_id`.

Error codes (`error.code`): `permission_denied`, `unsupported`, `busy`,
`interrupted`, `too_long`, `empty`, `upload_failed`, `transcription_failed`,
`timeout`, `poll_failed`, `retry_failed`.

## Messages

Bosnian by default; override any key with the `messages` prop or option:
`start` Diktiraj · `stop` Završi · `recording` Snimanje… · `uploading` Slanje… ·
`transcribing` Prepisujem… · `failed` Prepis nije uspio · `retry` Pokušaj ponovo ·
`insert` Ubaci u polje · `correct` Ispravi · `save` Sačuvaj · `cancel` Odustani ·
`delete` Obriši · `confirmDelete` Obrisati snimak? · `permissionDenied` Pristup
mikrofonu je odbijen. · `unsupported` Snimanje nije podržano na ovom uređaju. ·
`pending` Čeka obradu · `processing` Obrada… (full list in `defaultMessages`).

## Theming

Import `@ditactic/dictation-vue/style.css` once. All class names start with
`dct-` and the colours come from CSS variables you set on any ancestor:

```css
.karton {
  --dct-accent: #0f766e;   /* buttons, pills, focus ring */
  --dct-danger: #b91c1c;   /* recording state, delete, errors */
  --dct-radius: 6px;
  --dct-font: inherit;
  /* optional */
  --dct-muted: #6b7280; --dct-border: #e5e7eb; --dct-warning: #b45309; --dct-success: #15803d;
  --dct-button-bg, --dct-button-color, --dct-button-border, --dct-recording-bg, --dct-recording-color,
  --dct-item-bg, --dct-input-bg, --dct-meter-on, --dct-meter-off
}
```

Useful hooks: `.dct-button-wrap[data-phase="recording"]`, `.dct-item--failed`,
`.dct-pill--processing`, `.dct-btn--insert`.

## Native bridge

Inside the Medi mobile app the React Native shell injects
`window.__DICTATION_BRIDGE__` before the page loads (see
`@ditactic/dictation-react-native`). `useRecorder` then posts `dictation:start`
/ `stop` / `cancel` through `window.ReactNativeWebView.postMessage`, listens for
`CustomEvent('dictation')` on `window`, reassembles the base64 chunks and hands
back a `Blob` — the page uploads it with its own session, exactly like the
browser path. Nothing changes in your component code.

## Development

```bash
npm test -w packages/vue     # Vitest + jsdom
npm run build -w packages/vue
```

MIT
