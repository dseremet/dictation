# @ditactic/dictation-react-native

Native dictation for Expo / React Native apps, part of
[dseremet/dictation](https://github.com/dseremet/dictation):

- `useDictationRecorder()` records speech with `expo-audio` (AAC/M4A, 16 kHz mono,
  32 kbps, metering, auto-stop, clean stop when the app goes to the background).
- `useDictationBridge()` lets a `@ditactic/dictation-vue` page running inside a
  `react-native-webview` record through the device microphone and receive the
  audio as base64 chunks (protocol from `@ditactic/dictation-protocol`).
- `uploadRecording()` posts a recording as multipart form data from a native screen.
- `<DictationButton>` is a minimal themable mic toggle for native screens.

Ships TypeScript sources (`src/`) and a CommonJS build with declarations
(`dist/`, `main`). Metro consumes either; plain `jest` and Node can `require`
the build without extra transforms.

## Install

```sh
npx expo install expo-audio expo-file-system
npm install @ditactic/dictation-react-native @ditactic/dictation-protocol
# only for the WebView bridge:
npx expo install react-native-webview
```

Peer dependencies: `react`, `react-native`, `expo-audio` (SDK 54 line, `~1.0`),
`expo-file-system` (SDK 54 line, `~19.0`; the package imports the legacy API
from `expo-file-system/legacy` for `readAsStringAsync(uri, { encoding: 'base64' })`,
`getInfoAsync` and `deleteAsync`, so no code depends on the new `File` class),
and optionally `react-native-webview` (`>=13`).

### Permissions

`app.json` / `app.config.js`:

```js
plugins: [
  ['expo-audio', { microphonePermission: 'Medi koristi mikrofon za diktiranje nalaza u karton.' }],
],
android: {
  permissions: ['android.permission.RECORD_AUDIO'],
},
```

The plugin writes `NSMicrophoneUsageDescription` on iOS. Any change here needs a
native rebuild (`npx expo prebuild --clean` and a new dev client / EAS build).

Apps that are generated from a core project (whitelabel builds that copy
`package.json` / `app.config.js` from a base) must add the same dependencies,
the plugin entry and the Android permission in each generated app, otherwise
the native modules are missing at runtime.

## WebView bridge

```tsx
import { useRef } from 'react'
import { WebView } from 'react-native-webview'
import { useDictationBridge } from '@ditactic/dictation-react-native'

export function DashboardWebView({ url }: { url: string }) {
  const webViewRef = useRef<WebView>(null)
  const bridge = useDictationBridge({
    webViewRef,
    maxDurationMs: 10 * 60 * 1000,
    onMessage: (event) => handleOtherMessages(event),   // non-dictation messages
    onEvent: (e) => __DEV__ && console.log('dictation', e.direction, e.message.type),
  })

  return (
    <WebView
      ref={webViewRef}
      source={{ uri: url }}
      injectedJavaScriptBeforeContentLoaded={bridge.injectedJavaScriptBeforeContentLoaded}
      onMessage={bridge.onMessage}
      onLoadEnd={bridge.onLoadEnd}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      mediaCapturePermissionGrantType="grant"
    />
  )
}
```

What it does:

- Injects `window.__DICTATION_BRIDGE__ = { version, capabilities }` before the
  page runs, so the Vue recorder picks the native source instead of
  `MediaRecorder`.
- Answers `dictation:ping` and every page load with `dictation:ready`.
- `dictation:start` → asks for microphone permission, starts recording, sends
  `dictation:status { state, durationMs, level }` every 500 ms. A second start
  while busy gets `dictation:error { code: 'busy' }`; a denied permission gets
  `permission_denied`.
- `dictation:stop` → `dictation:status { state: 'stopped' }`, then
  `file-begin { mime: 'audio/mp4', size, chunks, durationMs }`, the base64
  `file-chunk`s (192 KB each, one per tick so the UI thread stays responsive),
  `file-end`, and the temp file is deleted. The page uploads with its own session.
- `dictation:cancel` → stops and deletes, nothing is delivered.
- At `maxDurationMs` (the page may request less, never more) the recorder stops
  on its own: the file is delivered as above and **then** an advisory
  `dictation:error { code: 'too_long' }` tells the page why it ended.
- App to background or an audio-session interruption: whatever was recorded is
  delivered, followed by an advisory `dictation:error { code: 'interrupted' }`;
  if nothing usable exists only the error is sent.
- Messages that are not dictation messages go to your `onMessage`, so the
  WebView channel stays usable for everything else. `onLoadEnd` is forwarded too.

`allowsInlineMediaPlayback` and `mediaPlaybackRequiresUserAction={false}` are
for playing the recordings back inside the page (`<audio>` elements).
`mediaCapturePermissionGrantType="grant"` keeps `getUserMedia` working as a
fallback on pages that are opened without the bridge.

The hook also returns `isRecording`, `state`, `durationMs`, `level`, the
underlying `recorder` and the `controller` (for example to show a recording
indicator in the native chrome).

## Native screens

```tsx
import axios from 'axios'
import { DictationButton, uploadRecording } from '@ditactic/dictation-react-native'

<DictationButton
  colors={{ idle: '#1f6feb', recording: '#d1242f', text: '#fff' }}
  labels={{ start: 'Diktiraj', stop: 'Završi' }}
  onResult={async ({ uri, mime, durationMs }) => {
    const recording = await uploadRecording({
      http: axios,                       // anything with post(url, data, config) -> { data }
      url: `${API}/karton/diktat`,
      uri,
      mime,
      fields: {
        language: 'auto',
        duration_ms: durationMs,
        recordable_type: 'carton_entry',
        recordable_id: entryId,
        context: { question_key: 'anamneza', field_label: 'Anamneza' }, // -> context[question_key]
      },
      timeoutMs: 120000,
    })
    poll(recording.uuid)
  }}
  onError={(e) => Alert.alert('Diktat', e.message)}
/>
```

Or drive the recorder yourself:

```tsx
const rec = useDictationRecorder({
  maxDurationMs: 5 * 60 * 1000,
  onAutoStop: (result) => upload(result),
  onInterrupted: (result, error) => (result ? upload(result) : showError(error)),
})

rec.state        // 'idle' | 'recording' | 'paused' | 'stopping'
rec.durationMs   // refreshed every 250 ms
rec.level        // 0..1 from metering (-60 dBFS floor .. 0 dBFS)
rec.error        // { code, message, result? } or null
await rec.start()                 // rejects with { code: 'permission_denied' | 'busy' | 'unsupported' }
await rec.pause(); await rec.resume()
const { uri, mime, durationMs, size } = await rec.stop()  // mime is 'audio/mp4'
await rec.cancel()                // stop + delete
```

`start()` calls `requestRecordingPermissionsAsync()`, sets the audio mode to
`{ allowsRecording: true, playsInSilentMode: true }`, prepares and records.
`stop()` resets `allowsRecording` to `false`. When the app goes to the
background the recording is stopped, the result is flagged `interrupted: true`
and `error.code` is `interrupted`.

`uploadRecording` sends the file under the `audio` field as
`{ uri, name: 'recording.m4a', type: mime }` with `Content-Type: multipart/form-data`
and a 120 s timeout by default; nested `fields` become PHP bracket notation.
It returns `response.data`.

## Testing without a device

The protocol handling is a plain function, `createBridgeController({ recorder,
deliver, readBase64, deleteFile, maxDurationMs })`, so it can be unit-tested
with fakes; the hooks only wrap it. The package's own tests run on plain `jest`
with `react-native`, `expo-audio` and `expo-file-system/legacy` replaced by the
fakes in `__mocks__/`.

```sh
npm test -w packages/react-native
npm run build -w packages/react-native
```

## License

MIT
