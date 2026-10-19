import { computed, getCurrentScope, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import { describeError, unwrapRecording } from './http'
import { normalizeRecorderError, useRecorder, type UseRecorderReturn } from './recorder/useRecorder'
import type { DictationError, DictationPhase, RecorderResult, Recording, UseDictationOptions } from './types'

export interface UseDictationReturn {
  phase: Ref<DictationPhase>
  recording: Ref<Recording | null>
  /** `final_text` of the finished recording (corrected ?? transcript ?? raw). */
  transcript: Ref<string>
  error: Ref<DictationError | null>
  recorder: UseRecorderReturn
  durationMs: Ref<number>
  level: Ref<number>
  isNative: Ref<boolean>
  /** `uploading | transcribing`. */
  isBusy: ComputedRef<boolean>
  options: UseDictationOptions
  /** Start recording. Resolves `false` when the microphone could not be opened. */
  start(): Promise<boolean>
  /** Stop → upload → wait for the transcript. Resolves with the final recording or `null`. */
  finish(): Promise<Recording | null>
  /** Discard the current recording / stop waiting. */
  cancel(): void
  /** `cancel()` plus clearing `transcript` and `error`. */
  reset(): void
  /** After `failed`: POST retry when the server has the recording, otherwise record again. */
  retry(): Promise<boolean>
}

const EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
}

/** `audio/webm;codecs=opus` → `webm`, `audio/mp4` → `m4a`, unknown → `webm`. */
export function extensionForMime(mime: string | null | undefined): string {
  const base = (mime ?? '').split(';')[0].trim().toLowerCase()
  return EXTENSIONS[base] ?? 'webm'
}

export function isTerminalStatus(recording: Recording | null | undefined): boolean {
  return !!recording && (recording.status === 'done' || recording.status === 'failed')
}

export function finalTextOf(recording: Recording | null | undefined): string {
  if (!recording) return ''
  return recording.final_text ?? recording.transcript_corrected ?? recording.transcript ?? recording.transcript_raw ?? ''
}

export function useDictation(options: UseDictationOptions): UseDictationReturn {
  const pollIntervalMs = options.pollIntervalMs ?? 1500
  const maxPollMs = options.maxPollMs ?? 10 * 60 * 1000
  const recorder = useRecorder(options.recorder)

  const phase = ref<DictationPhase>('idle')
  const recording = ref<Recording | null>(null)
  const transcript = ref('')
  const error = ref<DictationError | null>(null)
  const isBusy = computed(() => phase.value === 'uploading' || phase.value === 'transcribing')

  let session = 0
  let unsubscribe: (() => void) | null = null
  let finishing: Promise<Recording | null> | null = null
  /** Resolves the in-flight `waitForResult()` early (used by cancel/reset). */
  let abortWait: (() => void) | null = null

  function clearSubscription(): void {
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch {
        /* ignore */
      }
    }
    unsubscribe = null
  }

  function setFailed(err: DictationError): void {
    error.value = err
    phase.value = 'failed'
  }

  function settle(final: Recording): void {
    recording.value = final
    if (final.status === 'done') {
      transcript.value = finalTextOf(final)
      error.value = null
      phase.value = 'done'
    } else {
      setFailed({ code: 'transcription_failed', message: final.error || 'Transcription failed' })
    }
  }

  // Auto-stop (max duration) and recorder errors while recording.
  watch(recorder.state, (state) => {
    if (phase.value !== 'recording') return
    if (state === 'ready' && !finishing) void finish()
    if (state === 'error' && recorder.error.value) setFailed(recorder.error.value)
  })

  async function resolveLanguage(): Promise<string> {
    const lang = options.language
    const value = typeof lang === 'function' ? lang() : lang
    return value || 'auto'
  }

  async function buildFormData(file: RecorderResult): Promise<FormData> {
    const form = new FormData()
    form.append('audio', file.blob, `recording.${extensionForMime(file.mime)}`)
    form.append('language', await resolveLanguage())
    form.append('duration_ms', String(Math.max(0, Math.round(file.durationMs))))

    const context = typeof options.context === 'function' ? await options.context() : options.context
    for (const [key, value] of Object.entries(context ?? {})) {
      if (value === undefined || value === null) continue
      form.append(`context[${key}]`, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }

    const recordable = options.recordable ? await options.recordable() : null
    if (recordable && recordable.type && recordable.id !== undefined && recordable.id !== null) {
      form.append('recordable_type', String(recordable.type))
      form.append('recordable_id', String(recordable.id))
    }
    return form
  }

  function waitForResult(uuid: string, my: number): Promise<Recording | null> {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      const usingPush = typeof options.subscribe === 'function'
      const base = usingPush ? Math.max(pollIntervalMs, 10_000) : pollIntervalMs
      const cap = usingPush ? 30_000 : 5_000
      let delay = base
      let timer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      let inflight = false
      let failures = 0

      const conclude = (final: Recording | null, err?: DictationError) => {
        if (settled) return
        settled = true
        abortWait = null
        if (timer) clearTimeout(timer)
        clearSubscription()
        if (my !== session) {
          resolve(null)
          return
        }
        if (final) settle(final)
        else if (err) setFailed(err)
        resolve(final)
      }

      const handle = (payload: unknown) => {
        if (settled || my !== session) return
        const next = unwrapRecording<Recording>(payload)
        if (!next || next.uuid !== uuid) return
        recording.value = next
        if (isTerminalStatus(next)) conclude(next)
      }

      const poll = async () => {
        if (settled || inflight) return
        if (my !== session) {
          conclude(null)
          return
        }
        if (Date.now() - startedAt > maxPollMs) {
          conclude(null, { code: 'timeout', message: 'Transcription timed out' })
          return
        }
        inflight = true
        try {
          const response = await options.http.get(options.endpoints.show(uuid))
          failures = 0
          handle(response.data)
        } catch (err) {
          failures += 1
          if (failures >= 5) {
            conclude(null, { code: 'poll_failed', message: describeError(err, 'Status check failed'), cause: err })
          }
        } finally {
          inflight = false
        }
        if (!settled) {
          delay = Math.min(delay * 1.5, cap)
          timer = setTimeout(poll, delay)
        }
      }

      if (usingPush) {
        try {
          unsubscribe = options.subscribe!(uuid, handle)
        } catch {
          unsubscribe = null
        }
      }
      abortWait = () => conclude(null)
      timer = setTimeout(poll, delay)
    })
  }

  async function start(): Promise<boolean> {
    if (phase.value === 'recording' || isBusy.value) return phase.value === 'recording'
    const my = ++session
    clearSubscription()
    error.value = null
    recording.value = null
    transcript.value = ''
    phase.value = 'recording'

    const ok = await recorder.start()
    if (my !== session) return false
    if (!ok) {
      setFailed(recorder.error.value ?? { code: 'unknown', message: 'Recorder failed to start' })
      return false
    }
    return true
  }

  function finish(): Promise<Recording | null> {
    if (finishing) return finishing
    if (phase.value !== 'recording') return Promise.resolve(recording.value)
    const my = session

    finishing = (async (): Promise<Recording | null> => {
      let file: RecorderResult
      try {
        file = await recorder.stop()
      } catch (err) {
        if (my === session) setFailed(normalizeRecorderError(err))
        return null
      }
      if (my !== session) return null
      if (!file.blob || file.blob.size === 0) {
        setFailed({ code: 'empty', message: 'Empty recording' })
        return null
      }

      phase.value = 'uploading'
      let created: Recording | null
      try {
        const form = await buildFormData(file)
        const response = await options.http.post(options.endpoints.create, form, { headers: { Accept: 'application/json' } })
        created = unwrapRecording<Recording>(response.data)
        if (!created) throw new Error('Unexpected response from the upload endpoint')
      } catch (err) {
        if (my === session) setFailed({ code: 'upload_failed', message: describeError(err, 'Upload failed'), cause: err })
        return null
      }
      if (my !== session) return null

      recording.value = created
      if (isTerminalStatus(created)) {
        settle(created)
        return created
      }
      phase.value = 'transcribing'
      return waitForResult(created.uuid, my)
    })().finally(() => {
      finishing = null
    })

    return finishing
  }

  function cancel(): void {
    session += 1
    if (abortWait) abortWait()
    clearSubscription()
    finishing = null
    recorder.cancel()
    recording.value = null
    phase.value = 'idle'
  }

  function reset(): void {
    cancel()
    recorder.reset()
    transcript.value = ''
    error.value = null
  }

  async function retry(): Promise<boolean> {
    if (phase.value !== 'failed') return start()
    const current = recording.value
    if (current && options.endpoints.retry) {
      const my = ++session
      error.value = null
      phase.value = 'transcribing'
      try {
        const response = await options.http.post(options.endpoints.retry(current.uuid), null, { headers: { Accept: 'application/json' } })
        if (my !== session) return false
        const updated = unwrapRecording<Recording>(response.data) ?? { ...current, status: 'pending' as const, error: null }
        recording.value = updated
        if (isTerminalStatus(updated)) {
          settle(updated)
          return updated.status === 'done'
        }
        const final = await waitForResult(updated.uuid, my)
        return final?.status === 'done'
      } catch (err) {
        if (my === session) setFailed({ code: 'retry_failed', message: describeError(err, 'Retry failed'), cause: err })
        return false
      }
    }
    reset()
    return start()
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      session += 1
      if (abortWait) abortWait()
      clearSubscription()
    })
  }

  return {
    phase,
    recording,
    transcript,
    error,
    recorder,
    durationMs: recorder.durationMs,
    level: recorder.level,
    isNative: recorder.isNative,
    isBusy,
    options,
    start,
    finish,
    cancel,
    reset,
    retry,
  }
}
