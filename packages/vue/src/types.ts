import type { ErrorCode } from '@ditactic/dictation-protocol'

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopping' | 'ready' | 'error'

export type RecorderErrorCode = ErrorCode | 'empty'

export interface RecorderError {
  code: RecorderErrorCode | string
  message: string
  cause?: unknown
}

export interface RecorderResult {
  blob: Blob
  mime: string
  durationMs: number
}

export interface SourceStatus {
  durationMs?: number
  state?: 'recording' | 'paused'
}

/** Callbacks a recording source uses to report back into `useRecorder`. */
export interface SourceCallbacks {
  onLevel(level: number): void
  onStatus(status: SourceStatus): void
  onError(error: RecorderError): void
}

export interface SourceStartOptions {
  maxDurationMs: number
}

/** One way of producing audio: `MediaRecorder` in the browser or the native bridge. */
export interface RecordingSource {
  readonly isNative: boolean
  start(options: SourceStartOptions): Promise<void>
  pause(): void
  resume(): void
  stop(): Promise<RecorderResult>
  cancel(): void
}

export type SourceFactory = (callbacks: SourceCallbacks, options: UseRecorderOptions) => RecordingSource

export interface MediaRecorderSourceOptions {
  /** Ordered MIME preference; the first one `MediaRecorder.isTypeSupported` accepts wins. */
  mimeTypes?: string[]
  /** `MediaRecorder.start(timeslice)`; default 1000 ms. */
  timesliceMs?: number
  /** Extra `getUserMedia` audio constraints merged over the defaults. */
  constraints?: MediaTrackConstraints
}

export interface NativeBridgeSourceOptions {
  /** How long to wait for the first `recording` status after `dictation:start`. Default 30 s. */
  startTimeoutMs?: number
  /** How long to wait for `file-end` after `dictation:stop`. Default 30 s. */
  stopTimeoutMs?: number
}

export interface UseRecorderOptions extends MediaRecorderSourceOptions {
  /** Auto-stop after this many ms (default 10 min, `0` disables). */
  maxDurationMs?: number
  /** `auto` picks the native bridge when `window.__DICTATION_BRIDGE__` exists. */
  source?: 'auto' | 'media' | 'native' | SourceFactory
  native?: NativeBridgeSourceOptions
  /** Show the browser "leave page?" prompt while recording. Default true. */
  warnBeforeUnload?: boolean
}

// ---------------------------------------------------------------------------
// HTTP adapter
// ---------------------------------------------------------------------------

export interface HttpResponse<T = unknown> {
  data: T
}

export interface HttpRequestOptions {
  headers?: Record<string, string>
}

/** Minimal HTTP contract; see `axiosAdapter` and `fetchAdapter`. */
export interface HttpAdapter {
  post<T = unknown>(url: string, body?: FormData | Record<string, unknown> | null, options?: HttpRequestOptions): Promise<HttpResponse<T>>
  get<T = unknown>(url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>>
  patch<T = unknown>(url: string, body: Record<string, unknown>, options?: HttpRequestOptions): Promise<HttpResponse<T>>
  delete<T = unknown>(url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>>
}

// ---------------------------------------------------------------------------
// API DTOs (ditactic/dictation-laravel RecordingResource)
// ---------------------------------------------------------------------------

export type RecordingStatus = 'pending' | 'processing' | 'done' | 'failed'

export interface Recording {
  uuid: string
  status: RecordingStatus
  language?: string | null
  detected_language?: string | null
  duration_ms?: number | null
  transcript?: string | null
  transcript_raw?: string | null
  transcript_corrected?: string | null
  final_text?: string | null
  context?: Record<string, unknown> | null
  warnings?: string[] | null
  created_at?: string | null
  audio_url?: string | null
  error?: string | null
}

export interface DictationEndpoints {
  create: string
  show: (uuid: string) => string
  update: (uuid: string) => string
  destroy: (uuid: string) => string
  audio: (uuid: string) => string
  retry?: (uuid: string) => string
  index?: string
}

export interface RecordableRef {
  type: string
  id: string | number
}

export type DictationPhase = 'idle' | 'recording' | 'uploading' | 'transcribing' | 'done' | 'failed'

export type DictationErrorCode =
  | RecorderErrorCode
  | 'upload_failed'
  | 'transcription_failed'
  | 'poll_failed'
  | 'retry_failed'
  | 'timeout'

export interface DictationError {
  code: DictationErrorCode | string
  message: string
  cause?: unknown
}

export interface DictationMessages {
  start: string
  stop: string
  requesting: string
  recording: string
  paused: string
  uploading: string
  transcribing: string
  done: string
  failed: string
  retry: string
  insert: string
  correct: string
  save: string
  cancel: string
  delete: string
  confirmDelete: string
  permissionDenied: string
  unsupported: string
  busy: string
  interrupted: string
  tooLong: string
  empty: string
  uploadFailed: string
  timeout: string
  pending: string
  processing: string
  noRecordings: string
  recordingLabel: string
}

export interface UseDictationOptions {
  http: HttpAdapter
  endpoints: DictationEndpoints
  /** `auto` | `bs` | `hr` | `sr`; default `auto`. */
  language?: string | (() => string)
  /** Extra fields sent as `context[key]=value`, e.g. `{ question_key, field_label }`. */
  context?: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>)
  /** Owner object the recording is attached to (`recordable_type`, `recordable_id`). */
  recordable?: () => RecordableRef | null | undefined | Promise<RecordableRef | null | undefined>
  /** First poll delay; grows ×1.5 up to 5 s. Default 1500 ms. */
  pollIntervalMs?: number
  /** Give up waiting for the transcript after this long. Default 10 min. */
  maxPollMs?: number
  /** Push channel (e.g. Laravel Echo). Polling continues slowly as a fallback. */
  subscribe?: (uuid: string, callback: (recording: Recording) => void) => () => void
  recorder?: UseRecorderOptions
  /** Bosnian defaults; override any key. */
  messages?: Partial<DictationMessages>
}
