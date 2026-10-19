import {
  DEFAULT_MAX_DURATION_MS,
  ErrorCodes,
  PROTOCOL_VERSION,
  chunkBase64,
  isWebToNative,
  parseMessage,
  type ErrorCode,
  type NativeToWebMessage,
  type WebToNativeMessage,
} from '@ditactic/dictation-protocol'
import { base64ByteLength } from './level'
import { RECORDING_MIME, toDictationError, type BridgeRecorder, type RecordingResult } from './types'

export interface BridgeControllerOptions {
  recorder: BridgeRecorder
  /** Deliver one message to the page (the hook injects `buildDeliveryScript`). */
  deliver: (message: NativeToWebMessage) => void
  /** Read a local file as base64 (`expo-file-system/legacy` `readAsStringAsync`). */
  readBase64: (uri: string) => Promise<string>
  /** Delete a local file; errors are swallowed. */
  deleteFile: (uri: string) => Promise<void>
  /** Hard limit advertised to the page; a page may request less, never more. */
  maxDurationMs?: number
  mime?: string
  /** How often `dictation:status` is sent while recording. */
  statusIntervalMs?: number
  /** Base64 characters per `file-chunk`; defaults to the protocol `CHUNK_SIZE`. */
  chunkSize?: number
  /** Called for every message in both directions (logging / debugging). */
  onEvent?: (event: BridgeEvent) => void
  /** Yield between chunks so the UI thread stays responsive. Overridable in tests. */
  yieldToUi?: () => Promise<void>
}

export type BridgeEvent =
  | { direction: 'in'; message: WebToNativeMessage }
  | { direction: 'out'; message: NativeToWebMessage }

export interface BridgeController {
  /** Handle a raw WebView message. Returns false when it is not a dictation message. */
  handleMessage(raw: unknown): boolean
  /** Call when the page finished loading: sends `dictation:ready`. */
  onPageLoaded(): void
  sendReady(): void
  /** The recorder stopped by itself (limit reached or system interruption). */
  notifyStopped(result: RecordingResult, reason: 'too_long' | 'interrupted'): Promise<void>
  /** A recorder error happened outside of a request (e.g. interruption with no audio). */
  notifyError(code: ErrorCode, message: string): void
  isBusy(): boolean
  /** Id of the active recording session, if any. */
  activeId(): string | null
  /** Stop timers; discards an active recording without delivering it. */
  dispose(): Promise<void>
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Protocol handling for the native side of the bridge, independent of React
 * and of expo so it can be unit-tested with fakes. `useDictationBridge` wraps it.
 */
export function createBridgeController(options: BridgeControllerOptions): BridgeController {
  const {
    recorder,
    deliver,
    readBase64,
    deleteFile,
    onEvent,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
    mime = RECORDING_MIME,
    statusIntervalMs = 500,
    chunkSize,
    yieldToUi = defaultYield,
  } = options

  let active: { id: string } | null = null
  // 'starting' guards double start before the recorder resolved; 'finishing'
  // covers stop + delivery, during which stop/cancel are ignored.
  let phase: 'idle' | 'starting' | 'recording' | 'finishing' = 'idle'
  let statusTimer: ReturnType<typeof setInterval> | null = null
  let disposed = false

  function send(message: NativeToWebMessage): void {
    if (disposed) return
    onEvent?.({ direction: 'out', message })
    try {
      deliver(message)
    } catch {
      // The WebView may have unmounted; nothing else to do.
    }
  }

  function sendError(code: ErrorCode, message: string, id?: string): void {
    send({ type: 'dictation:error', id, code, message })
  }

  function sendReady(): void {
    send({
      type: 'dictation:ready',
      version: PROTOCOL_VERSION,
      capabilities: { record: true, maxDurationMs, mime },
    })
  }

  function sendStatus(id: string): void {
    const status = recorder.getStatus()
    const state = status.state === 'paused' ? 'paused' : 'recording'
    send({ type: 'dictation:status', id, state, durationMs: status.durationMs, level: status.level })
  }

  function startStatusTimer(id: string): void {
    stopStatusTimer()
    statusTimer = setInterval(() => {
      if (phase !== 'recording' || !active || active.id !== id) {
        stopStatusTimer()
        return
      }
      sendStatus(id)
    }, statusIntervalMs)
  }

  function stopStatusTimer(): void {
    if (statusTimer) {
      clearInterval(statusTimer)
      statusTimer = null
    }
  }

  async function removeFile(uri: string | undefined): Promise<void> {
    if (!uri) return
    try {
      await deleteFile(uri)
    } catch {
      // Temp file cleanup is best effort.
    }
  }

  async function deliverFile(id: string, result: RecordingResult): Promise<void> {
    let base64: string
    try {
      base64 = await readBase64(result.uri)
    } catch (error) {
      sendError(ErrorCodes.unknown, `Could not read recording: ${(error as Error)?.message ?? error}`, id)
      await removeFile(result.uri)
      return
    }
    const chunks = chunkBase64(base64, chunkSize)
    const size = result.size > 0 ? result.size : base64ByteLength(base64)
    send({ type: 'dictation:file-begin', id, mime, size, chunks: chunks.length, durationMs: result.durationMs })
    for (let index = 0; index < chunks.length; index += 1) {
      if (disposed) return
      send({ type: 'dictation:file-chunk', id, index, data: chunks[index] })
      await yieldToUi()
    }
    send({ type: 'dictation:file-end', id })
    await removeFile(result.uri)
  }

  async function handleStart(message: Extract<WebToNativeMessage, { type: 'dictation:start' }>): Promise<void> {
    if (active || phase !== 'idle') {
      sendError(ErrorCodes.busy, 'A recording is already in progress.', message.id)
      return
    }
    active = { id: message.id }
    phase = 'starting'
    const requested = typeof message.maxDurationMs === 'number' && message.maxDurationMs > 0 ? message.maxDurationMs : maxDurationMs
    try {
      await recorder.start({ maxDurationMs: Math.min(requested, maxDurationMs) })
    } catch (error) {
      const err = toDictationError(error)
      active = null
      phase = 'idle'
      sendError(err.code, err.message, message.id)
      return
    }
    if (disposed) return
    phase = 'recording'
    sendStatus(message.id)
    startStatusTimer(message.id)
  }

  async function handleStop(id: string): Promise<void> {
    if (!active || active.id !== id || phase !== 'recording') {
      sendError(ErrorCodes.notRecording, 'No recording with this id is in progress.', id)
      return
    }
    phase = 'finishing'
    stopStatusTimer()
    let result: RecordingResult
    try {
      result = await recorder.stop()
    } catch (error) {
      const err = toDictationError(error)
      active = null
      phase = 'idle'
      sendError(err.code, err.message, id)
      return
    }
    send({ type: 'dictation:status', id, state: 'stopped', durationMs: result.durationMs, level: 0 })
    await deliverFile(id, result)
    active = null
    phase = 'idle'
  }

  async function handleCancel(id: string): Promise<void> {
    if (!active || active.id !== id) {
      sendError(ErrorCodes.notRecording, 'No recording with this id is in progress.', id)
      return
    }
    if (phase !== 'recording') return
    phase = 'finishing'
    stopStatusTimer()
    try {
      const result = await recorder.stop()
      await removeFile(result.uri)
    } catch {
      // Nothing recorded; nothing to clean up.
    }
    send({ type: 'dictation:status', id, state: 'stopped', durationMs: 0, level: 0 })
    active = null
    phase = 'idle'
  }

  async function handlePauseResume(message: WebToNativeMessage & { id: string }, action: 'pause' | 'resume'): Promise<void> {
    if (!active || active.id !== message.id || phase !== 'recording') {
      sendError(ErrorCodes.notRecording, 'No recording with this id is in progress.', message.id)
      return
    }
    try {
      await (action === 'pause' ? recorder.pause() : recorder.resume())
    } catch (error) {
      const err = toDictationError(error)
      sendError(err.code, err.message, message.id)
      return
    }
    sendStatus(message.id)
  }

  function handleMessage(raw: unknown): boolean {
    const message = parseMessage(raw)
    if (!message || !isWebToNative(message)) return false
    onEvent?.({ direction: 'in', message })
    switch (message.type) {
      case 'dictation:ping':
        sendReady()
        break
      case 'dictation:start':
        void handleStart(message)
        break
      case 'dictation:stop':
        void handleStop(message.id)
        break
      case 'dictation:cancel':
        void handleCancel(message.id)
        break
      case 'dictation:pause':
        void handlePauseResume(message, 'pause')
        break
      case 'dictation:resume':
        void handlePauseResume(message, 'resume')
        break
      default:
        return false
    }
    return true
  }

  async function notifyStopped(result: RecordingResult, reason: 'too_long' | 'interrupted'): Promise<void> {
    if (!active || phase === 'finishing' || phase === 'idle') {
      // Nothing the page is waiting for; just make sure the file does not linger.
      if (!active) await removeFile(result.uri)
      return
    }
    const { id } = active
    phase = 'finishing'
    stopStatusTimer()
    send({ type: 'dictation:status', id, state: 'stopped', durationMs: result.durationMs, level: 0 })
    await deliverFile(id, result)
    // Advisory: the page already has the audio; this tells it why recording ended.
    sendError(
      reason === 'too_long' ? ErrorCodes.tooLong : ErrorCodes.interrupted,
      reason === 'too_long'
        ? 'Maximum recording duration reached; the recording was stopped automatically.'
        : 'Recording was interrupted by the system; the audio recorded so far was delivered.',
      id,
    )
    active = null
    phase = 'idle'
  }

  function notifyError(code: ErrorCode, message: string): void {
    const id = active?.id
    stopStatusTimer()
    active = null
    phase = 'idle'
    sendError(code, message, id)
  }

  async function dispose(): Promise<void> {
    disposed = true
    stopStatusTimer()
    if (active && phase === 'recording') {
      try {
        const result = await recorder.stop()
        await removeFile(result.uri)
      } catch {
        // ignore
      }
    }
    active = null
    phase = 'idle'
  }

  return {
    handleMessage,
    onPageLoaded: sendReady,
    sendReady,
    notifyStopped,
    notifyError,
    isBusy: () => active !== null,
    activeId: () => active?.id ?? null,
    dispose,
  }
}
