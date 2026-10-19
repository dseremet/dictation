# WebView bridge protocol (v1)

See `packages/protocol/README.md` for the message list; this page covers the
behavioural contract both sides must honour.

- The shell injects the marker **before** the page loads
  (`injectedJavaScriptBeforeContentLoaded`). A page that sees no marker uses
  `MediaRecorder`; a page must never assume the shell exists.
- Exactly one recording at a time. A second `dictation:start` while busy gets
  `dictation:error { code: 'busy' }` and does not disturb the running one.
- `dictation:status` is sent at least every second while recording.
- The shell auto-stops at `maxDurationMs` (page value, capped by the shell's
  capability) and still delivers the file.
- On app background or audio interruption the shell stops, delivers what it
  has, and follows with `dictation:error { code: 'interrupted' }` so the page
  can tell the user the recording was cut short.
- File delivery order is strict: `file-begin`, chunks `0..n-1`, `file-end`.
  Chunks are ≤ `CHUNK_SIZE` base64 characters. The page waits up to 30 s for
  `file-end` after `stop` before giving up.
- `dictation:cancel` discards the file; nothing is delivered.
- The page uploads the audio itself. The shell never sees the page's session.
