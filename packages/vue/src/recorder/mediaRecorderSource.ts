import { ErrorCodes } from '@ditactic/dictation-protocol'
import type { MediaRecorderSourceOptions, RecorderError, RecorderResult, RecordingSource, SourceCallbacks } from '../types'

/** Ordered preference. Chrome/Firefox → webm/opus, Safari → mp4, then ogg. */
export const DEFAULT_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/wav',
]

type MediaRecorderCtor = typeof MediaRecorder

function recorderCtor(): MediaRecorderCtor | undefined {
  return (globalThis as { MediaRecorder?: MediaRecorderCtor }).MediaRecorder
}

/** First MIME type the browser's `MediaRecorder` accepts, or `undefined` for the browser default. */
export function pickMimeType(candidates: string[] = DEFAULT_MIME_TYPES): string | undefined {
  const ctor = recorderCtor()
  if (!ctor || typeof ctor.isTypeSupported !== 'function') return undefined
  return candidates.find((mime) => {
    try {
      return ctor.isTypeSupported(mime)
    } catch {
      return false
    }
  })
}

export function isMediaRecorderSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof recorderCtor() === 'function'
  )
}

/** Map `getUserMedia`/`MediaRecorder` DOMExceptions to protocol error codes. */
export function mapMediaError(error: unknown): RecorderError {
  const name = (error as { name?: string } | null)?.name ?? ''
  const message = (error as { message?: string } | null)?.message || name || 'Microphone error'
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return { code: ErrorCodes.permissionDenied, message, cause: error }
    case 'NotFoundError':
    case 'NotSupportedError':
    case 'OverconstrainedError':
    case 'TypeError':
      return { code: ErrorCodes.unsupported, message, cause: error }
    case 'NotReadableError':
    case 'TrackStartError':
      return { code: ErrorCodes.busy, message, cause: error }
    case 'AbortError':
      return { code: ErrorCodes.interrupted, message, cause: error }
    default:
      if (error && typeof error === 'object' && typeof (error as RecorderError).code === 'string') return error as RecorderError
      return { code: ErrorCodes.unknown, message, cause: error }
  }
}

/** Records with the browser `MediaRecorder` API plus an `AnalyserNode` level meter. */
export class MediaRecorderSource implements RecordingSource {
  readonly isNative = false

  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private mime = ''
  private audioContext: AudioContext | null = null
  private raf = 0
  private stopping: Promise<RecorderResult> | null = null
  private startedAt = 0
  private pausedAt = 0
  private pausedTotal = 0

  constructor(
    private readonly callbacks: SourceCallbacks,
    private readonly options: MediaRecorderSourceOptions = {},
  ) {}

  async start(): Promise<void> {
    if (!isMediaRecorderSupported()) {
      throw { code: ErrorCodes.unsupported, message: 'MediaRecorder or getUserMedia is not available' } satisfies RecorderError
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1, ...(this.options.constraints ?? {}) },
      })
    } catch (error) {
      throw mapMediaError(error)
    }

    const Ctor = recorderCtor() as MediaRecorderCtor
    const mime = pickMimeType(this.options.mimeTypes)
    try {
      this.recorder = mime ? new Ctor(this.stream, { mimeType: mime }) : new Ctor(this.stream)
    } catch (error) {
      this.releaseStream()
      throw mapMediaError(error)
    }

    this.mime = this.recorder.mimeType || mime || ''
    this.chunks = []
    this.stopping = null
    this.recorder.addEventListener('dataavailable', (event) => {
      const data = (event as BlobEvent).data
      if (data && data.size > 0) this.chunks.push(data)
    })
    this.recorder.addEventListener('error', (event) => {
      const err = (event as { error?: { message?: string } }).error
      this.callbacks.onError({ code: ErrorCodes.unknown, message: err?.message || 'MediaRecorder error', cause: err })
    })

    this.recorder.start(this.options.timesliceMs ?? 1000)
    this.startedAt = Date.now()
    this.pausedTotal = 0
    this.startMeter()
  }

  pause(): void {
    if (this.recorder && this.recorder.state === 'recording') {
      this.recorder.pause()
      this.pausedAt = Date.now()
    }
  }

  resume(): void {
    if (this.recorder && this.recorder.state === 'paused') {
      this.recorder.resume()
      this.pausedTotal += Date.now() - this.pausedAt
    }
  }

  stop(): Promise<RecorderResult> {
    if (this.stopping) return this.stopping
    const recorder = this.recorder
    if (!recorder) {
      return Promise.reject({ code: ErrorCodes.notRecording, message: 'Not recording' } satisfies RecorderError)
    }
    if (recorder.state === 'paused') this.pausedTotal += Date.now() - this.pausedAt
    const durationMs = Math.max(0, Date.now() - this.startedAt - this.pausedTotal)

    this.stopping = new Promise<RecorderResult>((resolve) => {
      const finish = () => {
        const type = this.mime || this.chunks[0]?.type || ''
        const blob = new Blob(this.chunks, type ? { type } : undefined)
        this.cleanup()
        resolve({ blob, mime: blob.type || type, durationMs })
      }
      if (recorder.state === 'inactive') {
        finish()
        return
      }
      recorder.addEventListener('stop', finish, { once: true })
      try {
        recorder.stop()
      } catch {
        finish()
      }
    })
    return this.stopping
  }

  cancel(): void {
    const recorder = this.recorder
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        /* ignore */
      }
    }
    this.cleanup()
    this.chunks = []
  }

  private startMeter(): void {
    const Ctx =
      (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ||
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx || !this.stream || typeof requestAnimationFrame !== 'function') return
    try {
      const context = new Ctx()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      context.createMediaStreamSource(this.stream).connect(analyser)
      const buffer = new Uint8Array(analyser.fftSize)
      this.audioContext = context
      const tick = () => {
        if (!this.audioContext) return
        analyser.getByteTimeDomainData(buffer)
        let sum = 0
        for (let i = 0; i < buffer.length; i += 1) {
          const v = (buffer[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / buffer.length)
        this.callbacks.onLevel(Math.min(1, rms * 4))
        this.raf = requestAnimationFrame(tick)
      }
      this.raf = requestAnimationFrame(tick)
    } catch {
      this.audioContext = null
    }
  }

  private releaseStream(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop()
        } catch {
          /* ignore */
        }
      }
    }
    this.stream = null
  }

  private cleanup(): void {
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf)
    this.raf = 0
    if (this.audioContext) {
      const ctx = this.audioContext
      this.audioContext = null
      try {
        void ctx.close().catch(() => undefined)
      } catch {
        /* ignore */
      }
    }
    this.releaseStream()
    this.recorder = null
    this.callbacks.onLevel(0)
  }
}
