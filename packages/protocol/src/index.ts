/**
 * @ditactic/dictation-protocol
 *
 * The message contract between a web page (Vue recorder) and a React Native
 * shell that records audio natively on its behalf. Both sides import this
 * package so the two implementations cannot drift.
 *
 * Direction web -> native: JSON string via `window.ReactNativeWebView.postMessage`.
 * Direction native -> web: the shell calls `window.__dictationReceive(json)`
 * (injected by the shell itself) through `webViewRef.injectJavaScript`.
 */

export const PROTOCOL_VERSION = 1 as const

/** Global marker the native shell injects before the page loads. */
export const BRIDGE_GLOBAL = '__DICTATION_BRIDGE__' as const

/** Global receive function the native shell injects before the page loads. */
export const RECEIVE_GLOBAL = '__dictationReceive' as const

/** Base64 payload size per chunk. Keeps every injected script well below
 * the limits of Android WebView `evaluateJavascript` and iOS message ports. */
export const CHUNK_SIZE = 192 * 1024

/** Default auto-stop limit when the page does not request one. */
export const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000

export const ErrorCodes = {
  permissionDenied: 'permission_denied',
  busy: 'busy',
  interrupted: 'interrupted',
  tooLong: 'too_long',
  unsupported: 'unsupported',
  notRecording: 'not_recording',
  unknown: 'unknown',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export type RecorderState = 'recording' | 'paused' | 'stopped' | 'error'

export interface BridgeCapabilities {
  record: boolean
  maxDurationMs: number
  /** MIME type the native recorder produces, e.g. `audio/mp4`. */
  mime: string
}

export interface BridgeMarker {
  version: typeof PROTOCOL_VERSION
  capabilities: BridgeCapabilities
}

// ---------------------------------------------------------------------------
// Web -> native
// ---------------------------------------------------------------------------

export interface StartMessage {
  type: 'dictation:start'
  id: string
  maxDurationMs?: number
}

export interface StopMessage {
  type: 'dictation:stop'
  id: string
}

export interface CancelMessage {
  type: 'dictation:cancel'
  id: string
}

export interface PauseMessage {
  type: 'dictation:pause'
  id: string
}

export interface ResumeMessage {
  type: 'dictation:resume'
  id: string
}

export interface PingMessage {
  type: 'dictation:ping'
}

export type WebToNativeMessage =
  | StartMessage
  | StopMessage
  | CancelMessage
  | PauseMessage
  | ResumeMessage
  | PingMessage

// ---------------------------------------------------------------------------
// Native -> web
// ---------------------------------------------------------------------------

export interface ReadyMessage {
  type: 'dictation:ready'
  version: typeof PROTOCOL_VERSION
  capabilities: BridgeCapabilities
}

export interface StatusMessage {
  type: 'dictation:status'
  id: string
  state: RecorderState
  durationMs: number
  /** Input level 0..1 when metering is available. */
  level?: number
}

export interface FileBeginMessage {
  type: 'dictation:file-begin'
  id: string
  mime: string
  /** Size in bytes of the decoded file. */
  size: number
  chunks: number
  durationMs: number
}

export interface FileChunkMessage {
  type: 'dictation:file-chunk'
  id: string
  index: number
  /** Base64 slice of the file. */
  data: string
}

export interface FileEndMessage {
  type: 'dictation:file-end'
  id: string
}

export interface ErrorMessage {
  type: 'dictation:error'
  id?: string
  code: ErrorCode
  message?: string
}

export type NativeToWebMessage =
  | ReadyMessage
  | StatusMessage
  | FileBeginMessage
  | FileChunkMessage
  | FileEndMessage
  | ErrorMessage

export type AnyMessage = WebToNativeMessage | NativeToWebMessage

const WEB_TO_NATIVE_TYPES = new Set<string>([
  'dictation:start',
  'dictation:stop',
  'dictation:cancel',
  'dictation:pause',
  'dictation:resume',
  'dictation:ping',
])

const NATIVE_TO_WEB_TYPES = new Set<string>([
  'dictation:ready',
  'dictation:status',
  'dictation:file-begin',
  'dictation:file-chunk',
  'dictation:file-end',
  'dictation:error',
])

/** Parse a raw message string; returns null for anything that is not ours. */
export function parseMessage(raw: unknown): AnyMessage | null {
  if (typeof raw !== 'string') return null
  if (!raw.startsWith('{') || raw.indexOf('"dictation:') === -1) return null
  try {
    const parsed = JSON.parse(raw) as { type?: unknown }
    if (!parsed || typeof parsed.type !== 'string') return null
    if (!WEB_TO_NATIVE_TYPES.has(parsed.type) && !NATIVE_TO_WEB_TYPES.has(parsed.type)) return null
    return parsed as AnyMessage
  } catch {
    return null
  }
}

export function isWebToNative(message: AnyMessage): message is WebToNativeMessage {
  return WEB_TO_NATIVE_TYPES.has(message.type)
}

export function isNativeToWeb(message: AnyMessage): message is NativeToWebMessage {
  return NATIVE_TO_WEB_TYPES.has(message.type)
}

export function serialize(message: AnyMessage): string {
  return JSON.stringify(message)
}

/** Split a base64 string into protocol-sized chunks. */
export function chunkBase64(base64: string, chunkSize: number = CHUNK_SIZE): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < base64.length; offset += chunkSize) {
    chunks.push(base64.slice(offset, offset + chunkSize))
  }
  return chunks
}

/**
 * Collects `file-begin`/`file-chunk`/`file-end` messages for one recording and
 * exposes the reassembled base64 once complete. Pure JS, usable on both sides
 * and in tests.
 */
export class ChunkAssembler {
  private begin: FileBeginMessage | null = null
  private parts: (string | undefined)[] = []
  private received = 0

  reset(): void {
    this.begin = null
    this.parts = []
    this.received = 0
  }

  /** Feed a message; returns the complete file once `file-end` closes it. */
  push(message: NativeToWebMessage): { mime: string; size: number; durationMs: number; base64: string } | null {
    if (message.type === 'dictation:file-begin') {
      this.begin = message
      this.parts = new Array(message.chunks)
      this.received = 0
      return null
    }
    if (message.type === 'dictation:file-chunk') {
      if (!this.begin || message.id !== this.begin.id) return null
      if (this.parts[message.index] === undefined) this.received += 1
      this.parts[message.index] = message.data
      return null
    }
    if (message.type === 'dictation:file-end') {
      if (!this.begin || message.id !== this.begin.id) return null
      if (this.received !== this.begin.chunks) {
        throw new Error(`dictation: incomplete file, got ${this.received}/${this.begin.chunks} chunks`)
      }
      const result = {
        mime: this.begin.mime,
        size: this.begin.size,
        durationMs: this.begin.durationMs,
        base64: this.parts.join(''),
      }
      this.reset()
      return result
    }
    return null
  }
}

/** Decode base64 into a Blob in a browser. */
export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/**
 * JavaScript the native shell injects before the page loads. It publishes
 * the bridge marker and a receive function that dispatches messages to any
 * page-side listener registered via `window.addEventListener('dictation', ...)`.
 */
export function buildInjectedScript(capabilities: BridgeCapabilities): string {
  const marker: BridgeMarker = { version: PROTOCOL_VERSION, capabilities }
  return `(function(){
  if (window.${BRIDGE_GLOBAL}) return;
  window.${BRIDGE_GLOBAL} = ${JSON.stringify(marker)};
  window.${RECEIVE_GLOBAL} = function (json) {
    try {
      var detail = typeof json === 'string' ? JSON.parse(json) : json;
      window.dispatchEvent(new CustomEvent('dictation', { detail: detail }));
    } catch (e) {}
  };
})(); true;`
}

/** Build the script that delivers one message to the page. */
export function buildDeliveryScript(message: NativeToWebMessage): string {
  return `window.${RECEIVE_GLOBAL} && window.${RECEIVE_GLOBAL}(${JSON.stringify(serialize(message))}); true;`
}
