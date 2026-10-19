import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingStatus,
} from 'expo-audio'
import { deleteAsync, getInfoAsync } from 'expo-file-system/legacy'
import { DEFAULT_MAX_DURATION_MS, ErrorCodes } from '@ditactic/dictation-protocol'
import { DICTATION_RECORDING_OPTIONS } from './recordingOptions'
import { dbToLevel } from './level'
import {
  DictationRecorderError,
  RECORDING_MIME,
  toDictationError,
  type DictationError,
  type RecorderState,
  type RecorderStatus,
  type RecordingResult,
} from './types'

export interface UseDictationRecorderOptions {
  /** Auto-stop limit. Defaults to the protocol default (10 minutes). */
  maxDurationMs?: number
  /** Called with the finished recording when the limit was reached. */
  onAutoStop?: (result: RecordingResult) => void
  /**
   * Called when the system ended the recording (app went to background, audio
   * session interrupted). `result` is null when nothing usable was recorded.
   */
  onInterrupted?: (result: RecordingResult | null, error: DictationError) => void
  /** How often duration/level are refreshed while recording. Default 250 ms. */
  pollIntervalMs?: number
  /** dBFS value that maps to level 0. Default -60. */
  levelFloorDb?: number
}

export interface DictationRecorder {
  state: RecorderState
  durationMs: number
  /** Input level 0..1 (0 while paused or idle). */
  level: number
  error: DictationError | null
  /**
   * Request permission, configure the audio session and start recording.
   * Rejects with a `DictationRecorderError` (`code` is a protocol error code);
   * `error` is set as well.
   */
  start(options?: { maxDurationMs?: number }): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  /** Stop and return the file. Rejects with `not_recording` when idle. */
  stop(): Promise<RecordingResult>
  /** Stop and delete the file. No-op when idle. */
  cancel(): Promise<void>
  /** Live values read synchronously (not subject to render timing). */
  getStatus(): RecorderStatus
  clearError(): void
}

const noop = () => undefined

async function fileSize(uri: string | null | undefined): Promise<number> {
  if (!uri) return 0
  try {
    const info = await getInfoAsync(uri)
    return info.exists && typeof info.size === 'number' ? info.size : 0
  } catch {
    return 0
  }
}

/**
 * Native dictation recorder on top of `expo-audio`: AAC/M4A, 16 kHz mono,
 * metering, auto-stop at `maxDurationMs`, clean stop when the app goes to the
 * background. Returns `{ uri, mime: 'audio/mp4', durationMs, size }`.
 */
export function useDictationRecorder(options: UseDictationRecorderOptions = {}): DictationRecorder {
  const {
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
    onAutoStop,
    onInterrupted,
    pollIntervalMs = 250,
    levelFloorDb = -60,
  } = options

  const [state, setState] = useState<RecorderState>('idle')
  const [durationMs, setDurationMs] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<DictationError | null>(null)

  const stateRef = useRef<RecorderState>('idle')
  const durationRef = useRef(0)
  const levelRef = useRef(0)
  const limitRef = useRef(maxDurationMs)
  const startingRef = useRef(false)
  const stopPromiseRef = useRef<Promise<RecordingResult> | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const callbacksRef = useRef({ onAutoStop, onInterrupted })
  callbacksRef.current = { onAutoStop, onInterrupted }
  const statusListenerRef = useRef<(status: RecordingStatus) => void>(noop)
  const pollIntervalRef = useRef(pollIntervalMs)
  pollIntervalRef.current = pollIntervalMs

  // expo-audio subscribes the listener once per recorder instance, so it must
  // go through a ref to see the current closure.
  const recorder = useAudioRecorder(DICTATION_RECORDING_OPTIONS, (status) => statusListenerRef.current(status))
  const recorderRef = useRef(recorder)
  recorderRef.current = recorder

  const updateState = useCallback((next: RecorderState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const finishRecording = useCallback((): Promise<RecordingResult> => {
    if (stopPromiseRef.current) return stopPromiseRef.current
    const run = async (): Promise<RecordingResult> => {
      stopPolling()
      updateState('stopping')
      const current = recorderRef.current
      let statusDuration = durationRef.current
      let statusUrl: string | null = null
      try {
        const status = current.getStatus()
        if (typeof status.durationMillis === 'number' && status.durationMillis > 0) statusDuration = status.durationMillis
        statusUrl = status.url
      } catch {
        // getStatus can throw once the native object is gone; keep last values.
      }
      try {
        await current.stop()
      } finally {
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(noop)
      }
      const uri = current.uri ?? statusUrl
      if (!uri) {
        throw new DictationRecorderError(ErrorCodes.unknown, 'Recorder produced no file.')
      }
      const size = await fileSize(uri)
      return { uri, mime: RECORDING_MIME, durationMs: statusDuration, size }
    }
    const promise = run().finally(() => {
      stopPromiseRef.current = null
      durationRef.current = 0
      levelRef.current = 0
      setLevel(0)
      updateState('idle')
    })
    stopPromiseRef.current = promise
    return promise
  }, [stopPolling, updateState])

  const handleAutoStop = useCallback(async () => {
    try {
      const result = await finishRecording()
      setError({ code: ErrorCodes.tooLong, message: 'Maximum recording duration reached.', result })
      callbacksRef.current.onAutoStop?.(result)
    } catch (e) {
      setError(toDictationError(e))
    }
  }, [finishRecording])

  const handleInterrupted = useCallback(
    async (message: string) => {
      const current = stateRef.current
      if (current !== 'recording' && current !== 'paused') return
      let result: RecordingResult | null = null
      try {
        result = { ...(await finishRecording()), interrupted: true }
      } catch {
        result = null
      }
      const err: DictationError = { code: ErrorCodes.interrupted, message, result: result ?? undefined }
      setError(err)
      callbacksRef.current.onInterrupted?.(result, err)
    },
    [finishRecording],
  )

  const startPolling = useCallback(() => {
    stopPolling()
    pollTimerRef.current = setInterval(() => {
      if (stateRef.current !== 'recording' && stateRef.current !== 'paused') {
        stopPolling()
        return
      }
      let status
      try {
        status = recorderRef.current.getStatus()
      } catch {
        return
      }
      if (typeof status.durationMillis === 'number') {
        durationRef.current = status.durationMillis
        setDurationMs(status.durationMillis)
      }
      const nextLevel = stateRef.current === 'recording' ? dbToLevel(status.metering, levelFloorDb) : 0
      levelRef.current = nextLevel
      setLevel(nextLevel)
      if (stateRef.current === 'recording' && durationRef.current >= limitRef.current) {
        void handleAutoStop()
      }
    }, pollIntervalRef.current)
  }, [handleAutoStop, levelFloorDb, stopPolling])

  statusListenerRef.current = (status: RecordingStatus) => {
    const active = stateRef.current === 'recording' || stateRef.current === 'paused'
    if (!active || stopPromiseRef.current) return
    if (status.hasError) {
      void handleInterrupted(`Recorder error: ${status.error ?? 'unknown'}`)
    } else if (status.isFinished) {
      void handleInterrupted('Recording was ended by the system.')
    }
  }

  const start = useCallback(
    async (startOptions?: { maxDurationMs?: number }) => {
      if (stateRef.current !== 'idle' || startingRef.current || stopPromiseRef.current) {
        const busy = new DictationRecorderError(ErrorCodes.busy, 'A recording is already in progress.')
        setError(toDictationError(busy))
        throw busy
      }
      startingRef.current = true
      try {
        const permission = await requestRecordingPermissionsAsync()
        if (!permission.granted) {
          throw new DictationRecorderError(ErrorCodes.permissionDenied, 'Microphone permission was not granted.')
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
        const current = recorderRef.current
        try {
          await current.prepareToRecordAsync()
          current.record()
        } catch (e) {
          await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(noop)
          throw new DictationRecorderError(
            ErrorCodes.unsupported,
            `Could not start the recorder: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
        limitRef.current =
          startOptions?.maxDurationMs && startOptions.maxDurationMs > 0
            ? Math.min(startOptions.maxDurationMs, maxDurationMs)
            : maxDurationMs
        durationRef.current = 0
        levelRef.current = 0
        setDurationMs(0)
        setLevel(0)
        setError(null)
        updateState('recording')
        startPolling()
      } catch (e) {
        const err = e instanceof DictationRecorderError ? e : new DictationRecorderError(ErrorCodes.unknown, String(e))
        setError(toDictationError(err))
        throw err
      } finally {
        startingRef.current = false
      }
    },
    [maxDurationMs, startPolling, updateState],
  )

  const pause = useCallback(async () => {
    if (stateRef.current !== 'recording') return
    recorderRef.current.pause()
    levelRef.current = 0
    setLevel(0)
    updateState('paused')
  }, [updateState])

  const resume = useCallback(async () => {
    if (stateRef.current !== 'paused') return
    recorderRef.current.record()
    updateState('recording')
  }, [updateState])

  const stop = useCallback(async (): Promise<RecordingResult> => {
    if (stopPromiseRef.current) return stopPromiseRef.current
    if (stateRef.current !== 'recording' && stateRef.current !== 'paused') {
      throw new DictationRecorderError(ErrorCodes.notRecording, 'No recording in progress.')
    }
    try {
      return await finishRecording()
    } catch (e) {
      setError(toDictationError(e))
      throw e
    }
  }, [finishRecording])

  const cancel = useCallback(async () => {
    if (stateRef.current === 'idle' && !stopPromiseRef.current) return
    try {
      const result = await finishRecording()
      await deleteAsync(result.uri, { idempotent: true }).catch(noop)
    } catch {
      // Nothing to discard.
    }
  }, [finishRecording])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background') void handleInterrupted('App moved to the background.')
    })
    return () => subscription.remove()
  }, [handleInterrupted])

  useEffect(() => {
    return () => {
      stopPolling()
      if (stateRef.current === 'recording' || stateRef.current === 'paused') {
        const current = recorderRef.current
        Promise.resolve()
          .then(() => current.stop())
          .then(() => (current.uri ? deleteAsync(current.uri, { idempotent: true }) : undefined))
          .catch(noop)
          .finally(() => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(noop))
      }
    }
  }, [stopPolling])

  const getStatus = useCallback(
    (): RecorderStatus => ({ state: stateRef.current, durationMs: durationRef.current, level: levelRef.current }),
    [],
  )
  const clearError = useCallback(() => setError(null), [])

  return useMemo(
    () => ({ state, durationMs, level, error, start, pause, resume, stop, cancel, getStatus, clearError }),
    [state, durationMs, level, error, start, pause, resume, stop, cancel, getStatus, clearError],
  )
}
