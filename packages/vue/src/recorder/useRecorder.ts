import { DEFAULT_MAX_DURATION_MS, ErrorCodes } from '@ditactic/dictation-protocol'
import { computed, getCurrentScope, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'
import type { RecorderError, RecorderResult, RecorderState, RecordingSource, SourceCallbacks, UseRecorderOptions } from '../types'
import { MediaRecorderSource } from './mediaRecorderSource'
import { NativeBridgeSource, hasNativeBridge } from './nativeBridgeSource'

export interface UseRecorderReturn {
  state: Ref<RecorderState>
  durationMs: Ref<number>
  /** Input level 0..1. */
  level: Ref<number>
  error: Ref<RecorderError | null>
  isNative: Ref<boolean>
  /** `requesting | recording | paused | stopping`. */
  isActive: ComputedRef<boolean>
  maxDurationMs: number
  /** Resolves `true` once recording; on failure sets `error` and resolves `false`. */
  start(): Promise<boolean>
  pause(): void
  resume(): void
  /** Stops and resolves with the audio. Resolves with the same result again after an auto-stop. */
  stop(): Promise<RecorderResult>
  /** Discards everything and goes back to `idle` (keeps `error`). */
  cancel(): void
  /** `cancel()` plus clearing `error`. */
  reset(): void
}

export function normalizeRecorderError(error: unknown): RecorderError {
  if (error && typeof error === 'object' && typeof (error as RecorderError).code === 'string') {
    const e = error as RecorderError
    return { code: e.code, message: e.message || e.code, cause: e.cause ?? error }
  }
  const message = (error as { message?: string } | null)?.message || String(error ?? 'Unknown error')
  return { code: ErrorCodes.unknown, message, cause: error }
}

const ACTIVE_STATES: RecorderState[] = ['requesting', 'recording', 'paused', 'stopping']
const TICK_MS = 200

function onBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault()
  event.returnValue = ''
}

/**
 * Unified recorder: `MediaRecorder` in the browser, the native bridge inside
 * a React Native WebView. Same API and state machine for both.
 */
export function useRecorder(options: UseRecorderOptions = {}): UseRecorderReturn {
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
  const warnBeforeUnload = options.warnBeforeUnload ?? true

  const state = ref<RecorderState>('idle')
  const durationMs = ref(0)
  const level = ref(0)
  const error = ref<RecorderError | null>(null)
  const isNative = ref(false)
  const isActive = computed(() => ACTIVE_STATES.includes(state.value))

  let source: RecordingSource | null = null
  let result: RecorderResult | null = null
  let stopping: Promise<RecorderResult> | null = null
  let session = 0
  let ticker: ReturnType<typeof setInterval> | null = null
  let startedAt = 0
  let pausedAt = 0
  let pausedTotal = 0
  let unloadGuard = false

  const callbacks: SourceCallbacks = {
    onLevel(value) {
      level.value = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
    },
    onStatus(status) {
      if (typeof status.durationMs === 'number' && state.value === 'recording') {
        // Re-sync the local clock to the authoritative native duration.
        startedAt = Date.now() - status.durationMs - pausedTotal
        durationMs.value = status.durationMs
      }
      if (status.state === 'paused' && state.value === 'recording') {
        pausedAt = Date.now()
        state.value = 'paused'
      } else if (status.state === 'recording' && state.value === 'paused') {
        pausedTotal += Date.now() - pausedAt
        state.value = 'recording'
      }
    },
    onError(err) {
      fail(err)
    },
  }

  function createSource(): RecordingSource {
    const kind = options.source ?? 'auto'
    if (typeof kind === 'function') return kind(callbacks, options)
    const native = kind === 'native' || (kind === 'auto' && hasNativeBridge())
    if (native) return new NativeBridgeSource(callbacks, options.native)
    return new MediaRecorderSource(callbacks, {
      mimeTypes: options.mimeTypes,
      timesliceMs: options.timesliceMs,
      constraints: options.constraints,
    })
  }

  function setUnloadGuard(on: boolean): void {
    if (!warnBeforeUnload || typeof window === 'undefined' || on === unloadGuard) return
    unloadGuard = on
    if (on) window.addEventListener('beforeunload', onBeforeUnload)
    else window.removeEventListener('beforeunload', onBeforeUnload)
  }

  function stopTicking(): void {
    if (ticker) clearInterval(ticker)
    ticker = null
  }

  function tick(): void {
    if (state.value !== 'recording') return
    const elapsed = Math.max(0, Date.now() - startedAt - pausedTotal)
    durationMs.value = elapsed
    if (maxDurationMs > 0 && elapsed >= maxDurationMs) {
      stop().catch(() => undefined)
    }
  }

  function startTicking(): void {
    stopTicking()
    ticker = setInterval(tick, TICK_MS)
  }

  function releaseSource(): void {
    const current = source
    source = null
    if (current) {
      try {
        current.cancel()
      } catch {
        /* ignore */
      }
    }
  }

  function fail(err: unknown): void {
    error.value = normalizeRecorderError(err)
    state.value = 'error'
    stopTicking()
    setUnloadGuard(false)
    level.value = 0
    releaseSource()
  }

  async function start(): Promise<boolean> {
    if (isActive.value) return state.value === 'recording' || state.value === 'paused'
    const my = ++session
    error.value = null
    result = null
    stopping = null
    durationMs.value = 0
    level.value = 0
    pausedTotal = 0
    state.value = 'requesting'

    try {
      source = createSource()
      isNative.value = source.isNative
      await source.start({ maxDurationMs })
    } catch (err) {
      if (my !== session) return false
      fail(err)
      return false
    }
    if (my !== session) return false

    startedAt = Date.now()
    state.value = 'recording'
    startTicking()
    setUnloadGuard(true)
    return true
  }

  function pause(): void {
    if (state.value !== 'recording' || !source) return
    source.pause()
    pausedAt = Date.now()
    state.value = 'paused'
  }

  function resume(): void {
    if (state.value !== 'paused' || !source) return
    source.resume()
    pausedTotal += Date.now() - pausedAt
    state.value = 'recording'
  }

  function stop(): Promise<RecorderResult> {
    if (state.value === 'ready' && result) return Promise.resolve(result)
    if (stopping) return stopping
    if (!source || (state.value !== 'recording' && state.value !== 'paused')) {
      return Promise.reject({ code: ErrorCodes.notRecording, message: 'Not recording' } satisfies RecorderError)
    }
    const my = session
    const current = source
    if (state.value === 'paused') pausedTotal += Date.now() - pausedAt
    const localDuration = Math.max(0, Date.now() - startedAt - pausedTotal)
    state.value = 'stopping'
    stopTicking()
    setUnloadGuard(false)

    stopping = current
      .stop()
      .then((raw) => {
        if (my !== session) {
          throw { code: ErrorCodes.interrupted, message: 'Recording cancelled' } satisfies RecorderError
        }
        const final: RecorderResult = {
          blob: raw.blob,
          mime: raw.mime || raw.blob.type,
          durationMs: raw.durationMs > 0 ? raw.durationMs : localDuration,
        }
        result = final
        durationMs.value = final.durationMs
        level.value = 0
        source = null
        state.value = 'ready'
        return final
      })
      .catch((err: unknown) => {
        const normalized = normalizeRecorderError(err)
        if (my === session) fail(normalized)
        throw normalized
      })
      .finally(() => {
        stopping = null
      })
    return stopping
  }

  function cancel(): void {
    session += 1
    stopTicking()
    setUnloadGuard(false)
    releaseSource()
    result = null
    stopping = null
    durationMs.value = 0
    level.value = 0
    state.value = 'idle'
  }

  function reset(): void {
    cancel()
    error.value = null
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      cancel()
    })
  }

  return { state, durationMs, level, error, isNative, isActive, maxDurationMs, start, pause, resume, stop, cancel, reset }
}
