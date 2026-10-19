import type { ErrorCode } from '@ditactic/dictation-protocol'

/** MIME type produced by the native recorder (AAC in an MP4/M4A container). */
export const RECORDING_MIME = 'audio/mp4' as const

export type RecorderState = 'idle' | 'recording' | 'paused' | 'stopping'

export interface RecordingResult {
  /** Local file URI (`file://...`) of the finished recording. */
  uri: string
  mime: typeof RECORDING_MIME
  durationMs: number
  /** Size in bytes, 0 when it could not be determined. */
  size: number
  /** True when the recording was ended by the system (app went to background,
   * audio session interrupted) rather than by `stop()`. */
  interrupted?: boolean
}

export interface DictationError {
  code: ErrorCode
  message: string
  /** Present when a recording was finished by the system and audio exists. */
  result?: RecordingResult
}

export interface RecorderStatus {
  state: RecorderState
  durationMs: number
  /** Input level 0..1. */
  level: number
}

/**
 * Imperative recorder surface the bridge controller drives. The React hook
 * `useDictationRecorder` is adapted onto this in `useDictationBridge`; tests
 * pass a fake.
 */
export interface BridgeRecorder {
  start(options?: { maxDurationMs?: number }): Promise<void>
  pause(): Promise<void> | void
  resume(): Promise<void> | void
  stop(): Promise<RecordingResult>
  getStatus(): RecorderStatus
}

/** Minimal axios-like client used by `uploadRecording`. */
export interface HttpClient {
  post(url: string, data: unknown, config?: Record<string, unknown>): Promise<{ data?: unknown } | unknown>
}

export class DictationRecorderError extends Error implements DictationError {
  code: ErrorCode
  result?: RecordingResult

  constructor(code: ErrorCode, message: string, result?: RecordingResult) {
    super(message)
    this.name = 'DictationRecorderError'
    this.code = code
    this.result = result
  }
}

export function toDictationError(error: unknown, fallback: ErrorCode = 'unknown'): DictationError {
  if (error instanceof DictationRecorderError) {
    return { code: error.code, message: error.message, result: error.result }
  }
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    const e = error as { code: string; message?: string }
    return { code: e.code as ErrorCode, message: e.message || e.code }
  }
  return { code: fallback, message: error instanceof Error ? error.message : String(error) }
}
