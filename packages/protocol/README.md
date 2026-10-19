# @ditactic/dictation-protocol

The message contract between a web page that wants to record audio and a
React Native shell that records it natively. Used by
`@ditactic/dictation-vue` (page side) and `@ditactic/dictation-react-native`
(shell side). Zero dependencies.

## Flow

1. The shell injects `buildInjectedScript(capabilities)` before the page loads.
   The page sees `window.__DICTATION_BRIDGE__ = { version, capabilities }` and
   chooses the native recorder instead of `MediaRecorder`.
2. Page → shell (via `window.ReactNativeWebView.postMessage(json)`):
   `dictation:start`, `dictation:pause`, `dictation:resume`, `dictation:stop`,
   `dictation:cancel`, `dictation:ping`.
3. Shell → page (via `webViewRef.injectJavaScript(buildDeliveryScript(msg))`,
   which calls `window.__dictationReceive(json)` and dispatches a
   `CustomEvent('dictation', { detail })` on `window`):
   `dictation:ready`, `dictation:status`, `dictation:file-begin`,
   `dictation:file-chunk` (base64, `CHUNK_SIZE` per chunk), `dictation:file-end`,
   `dictation:error`.
4. The page reassembles the chunks with `ChunkAssembler`, turns them into a
   `Blob` with `base64ToBlob` and uploads with its own session. The shell never
   needs the page's credentials.

Error codes: `permission_denied`, `busy`, `interrupted`, `too_long`,
`unsupported`, `not_recording`, `unknown`.
