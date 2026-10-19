import {
  BRIDGE_GLOBAL,
  ChunkAssembler,
  ErrorCodes,
  base64ToBlob,
  isNativeToWeb,
  parseMessage,
  serialize,
  type AnyMessage,
  type BridgeMarker,
  type NativeToWebMessage,
  type WebToNativeMessage,
} from '@ditactic/dictation-protocol'
import type { NativeBridgeSourceOptions, RecorderError, RecorderResult, RecordingSource, SourceCallbacks } from '../types'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: RecorderError) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: RecorderError) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function getBridgeMarker(): BridgeMarker | null {
  if (typeof window === 'undefined') return null
  const marker = (window as unknown as Record<string, unknown>)[BRIDGE_GLOBAL] as BridgeMarker | undefined
  return marker && typeof marker === 'object' ? marker : null
}

/** True when the page runs inside a React Native WebView that injected the bridge. */
export function hasNativeBridge(): boolean {
  const marker = getBridgeMarker()
  return !!marker && marker.capabilities?.record !== false
}

function postToNative(message: WebToNativeMessage): void {
  const rn = (window as unknown as { ReactNativeWebView?: { postMessage?: (data: string) => void } }).ReactNativeWebView
  if (!rn || typeof rn.postMessage !== 'function') {
    throw { code: ErrorCodes.unsupported, message: 'ReactNativeWebView.postMessage is not available' } satisfies RecorderError
  }
  rn.postMessage(serialize(message))
}

function toMessage(detail: unknown): NativeToWebMessage | null {
  let message: AnyMessage | null = null
  if (typeof detail === 'string') {
    message = parseMessage(detail)
  } else if (detail && typeof detail === 'object' && typeof (detail as { type?: unknown }).type === 'string') {
    message = detail as AnyMessage
  }
  return message && isNativeToWeb(message) ? message : null
}

function makeId(): string {
  return `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Records through the React Native shell: posts `dictation:*` messages with
 * `window.ReactNativeWebView.postMessage` and listens for the shell's answers
 * as `CustomEvent('dictation')` on `window`.
 */
export class NativeBridgeSource implements RecordingSource {
  readonly isNative = true

  private id = ''
  private listener: ((event: Event) => void) | null = null
  private readonly assembler = new ChunkAssembler()
  private pendingStart: Deferred<void> | null = null
  private pendingStop: Deferred<RecorderResult> | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private durationMs = 0
  private active = false

  constructor(
    private readonly callbacks: SourceCallbacks,
    private readonly options: NativeBridgeSourceOptions = {},
  ) {}

  get recordingId(): string {
    return this.id
  }

  start(options: { maxDurationMs: number }): Promise<void> {
    this.id = makeId()
    this.durationMs = 0
    this.assembler.reset()
    this.attach()
    this.active = true

    const pending = deferred<void>()
    this.pendingStart = pending
    this.startTimer = setTimeout(() => {
      this.failPending({ code: ErrorCodes.unknown, message: 'Native recorder did not start' })
    }, this.options.startTimeoutMs ?? 30_000)

    try {
      postToNative({ type: 'dictation:start', id: this.id, maxDurationMs: options.maxDurationMs })
    } catch (error) {
      this.failPending(error as RecorderError)
    }
    return pending.promise
  }

  pause(): void {
    if (!this.active) return
    try {
      postToNative({ type: 'dictation:pause', id: this.id })
    } catch {
      /* ignore */
    }
  }

  resume(): void {
    if (!this.active) return
    try {
      postToNative({ type: 'dictation:resume', id: this.id })
    } catch {
      /* ignore */
    }
  }

  stop(): Promise<RecorderResult> {
    if (this.pendingStop) return this.pendingStop.promise
    if (!this.active) {
      return Promise.reject({ code: ErrorCodes.notRecording, message: 'Not recording' } satisfies RecorderError)
    }
    const pending = deferred<RecorderResult>()
    this.pendingStop = pending
    this.stopTimer = setTimeout(() => {
      this.failPending({ code: ErrorCodes.interrupted, message: 'Native recorder did not deliver the file in time' })
    }, this.options.stopTimeoutMs ?? 30_000)
    try {
      postToNative({ type: 'dictation:stop', id: this.id })
    } catch (error) {
      this.failPending(error as RecorderError)
    }
    return pending.promise
  }

  cancel(): void {
    const wasActive = this.active
    const id = this.id
    this.failPending({ code: ErrorCodes.interrupted, message: 'Recording cancelled' }, false)
    this.teardown()
    if (wasActive) {
      try {
        postToNative({ type: 'dictation:cancel', id })
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------------

  private attach(): void {
    if (this.listener || typeof window === 'undefined') return
    this.listener = (event: Event) => this.handle((event as CustomEvent).detail)
    window.addEventListener('dictation', this.listener)
  }

  private teardown(): void {
    if (this.listener && typeof window !== 'undefined') window.removeEventListener('dictation', this.listener)
    this.listener = null
    this.active = false
    this.assembler.reset()
    this.callbacks.onLevel(0)
  }

  private clearTimers(): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.startTimer = null
    this.stopTimer = null
  }

  /** Reject whatever is pending; report through `onError` when nothing waits. */
  private failPending(error: RecorderError, notify = true): void {
    this.clearTimers()
    const start = this.pendingStart
    const stop = this.pendingStop
    this.pendingStart = null
    this.pendingStop = null
    if (start) start.reject(error)
    if (stop) stop.reject(error)
    if (!start && !stop && notify && this.active) this.callbacks.onError(error)
    if (notify) this.teardown()
  }

  private handle(detail: unknown): void {
    const message = toMessage(detail)
    if (!message) return
    if ('id' in message && message.id && message.id !== this.id) return

    switch (message.type) {
      case 'dictation:status': {
        this.durationMs = message.durationMs
        if (typeof message.level === 'number') this.callbacks.onLevel(message.level)
        if (message.state === 'recording' || message.state === 'paused') {
          this.callbacks.onStatus({ durationMs: message.durationMs, state: message.state })
        } else {
          this.callbacks.onStatus({ durationMs: message.durationMs })
        }
        if (message.state === 'recording' && this.pendingStart) {
          if (this.startTimer) clearTimeout(this.startTimer)
          this.startTimer = null
          const pending = this.pendingStart
          this.pendingStart = null
          pending.resolve()
        } else if (message.state === 'error') {
          this.failPending({ code: ErrorCodes.unknown, message: 'Native recorder reported an error' })
        }
        break
      }
      case 'dictation:file-begin':
      case 'dictation:file-chunk':
      case 'dictation:file-end': {
        try {
          const file = this.assembler.push(message)
          if (!file) return
          const blob = base64ToBlob(file.base64, file.mime)
          const result: RecorderResult = { blob, mime: file.mime, durationMs: file.durationMs || this.durationMs }
          this.clearTimers()
          const pending = this.pendingStop
          this.pendingStop = null
          this.teardown()
          if (pending) pending.resolve(result)
        } catch (error) {
          this.failPending({ code: ErrorCodes.interrupted, message: (error as Error).message || 'Incomplete file', cause: error })
        }
        break
      }
      case 'dictation:error':
        this.failPending({ code: message.code, message: message.message || message.code })
        break
      default:
        break
    }
  }
}
