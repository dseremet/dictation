import { vi } from 'vitest'
import type { HttpAdapter, Recording, RecorderResult, SourceCallbacks, SourceFactory } from '../../src/types'

/** Minimal MediaRecorder stand-in that delivers one blob on stop. */
export class FakeMediaRecorder extends EventTarget {
  static supported: string[] = ['audio/webm;codecs=opus']
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported(mime: string): boolean {
    return FakeMediaRecorder.supported.includes(mime)
  }

  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  mimeType: string
  timeslice?: number
  payload = 'fake-audio-bytes'

  constructor(
    public stream: unknown,
    options?: { mimeType?: string },
  ) {
    super()
    this.mimeType = options?.mimeType ?? 'audio/webm'
    FakeMediaRecorder.instances.push(this)
  }

  start(timeslice?: number): void {
    this.state = 'recording'
    this.timeslice = timeslice
  }

  pause(): void {
    this.state = 'paused'
  }

  resume(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    const event = new Event('dataavailable') as Event & { data: Blob }
    event.data = new Blob([this.payload], { type: this.mimeType })
    this.dispatchEvent(event)
    this.dispatchEvent(new Event('stop'))
  }
}

export function installFakeMedia(getUserMedia?: (...args: unknown[]) => Promise<unknown>) {
  FakeMediaRecorder.instances = []
  const tracks = [{ kind: 'audio', stop: vi.fn() }]
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks }
  const gum = getUserMedia ?? vi.fn().mockResolvedValue(stream)
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: gum },
    configurable: true,
    writable: true,
  })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  return { stream, tracks, gum }
}

export function uninstallFakeMedia(): void {
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true, writable: true })
}

/** A recording source that never touches the DOM; used for useDictation / component tests. */
export function createFakeSource(result: Partial<RecorderResult> = {}) {
  const blob = result.blob ?? new Blob(['xyz'], { type: 'audio/webm' })
  const calls = { start: 0, stop: 0, cancel: 0, pause: 0, resume: 0 }
  let callbacks: SourceCallbacks | null = null
  let startBehaviour: (() => Promise<void>) | null = null
  const factory: SourceFactory = (cbs) => {
    callbacks = cbs
    return {
      isNative: false,
      async start() {
        calls.start += 1
        if (startBehaviour) await startBehaviour()
      },
      pause() {
        calls.pause += 1
      },
      resume() {
        calls.resume += 1
      },
      async stop() {
        calls.stop += 1
        return { blob, mime: result.mime ?? blob.type, durationMs: result.durationMs ?? 4200 }
      },
      cancel() {
        calls.cancel += 1
      },
    }
  }
  return {
    factory,
    calls,
    get callbacks() {
      return callbacks
    },
    failStartWith(error: unknown) {
      startBehaviour = () => Promise.reject(error)
    },
  }
}

export function makeRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    uuid: 'r-1',
    status: 'done',
    language: 'auto',
    detected_language: 'hr',
    duration_ms: 4200,
    transcript: 'Pacijent se žali na bol.',
    transcript_raw: 'pacijent se zali na bol',
    transcript_corrected: null,
    final_text: 'Pacijent se žali na bol.',
    context: { question_key: 'anamneza' },
    warnings: [],
    created_at: '2026-10-18T10:00:00Z',
    audio_url: '/karton/diktat/r-1/audio',
    error: null,
    ...overrides,
  }
}

/** Scripted http adapter: `get` answers come from a queue (last one repeats). */
export function createFakeHttp(options: { post?: unknown; gets?: unknown[]; patch?: unknown; delete?: unknown } = {}) {
  const gets = [...(options.gets ?? [])]
  const calls: { method: string; url: string; body?: unknown }[] = []
  const http: HttpAdapter = {
    post: vi.fn(async (url: string, body?: unknown) => {
      calls.push({ method: 'post', url, body })
      return { data: options.post as never }
    }),
    get: vi.fn(async (url: string) => {
      calls.push({ method: 'get', url })
      const next = gets.length > 1 ? gets.shift() : gets[0]
      if (next instanceof Error) throw next
      return { data: next as never }
    }),
    patch: vi.fn(async (url: string, body: Record<string, unknown>) => {
      calls.push({ method: 'patch', url, body })
      return { data: (typeof options.patch === 'function' ? options.patch(body) : options.patch) as never }
    }),
    delete: vi.fn(async (url: string) => {
      calls.push({ method: 'delete', url })
      return { data: options.delete as never }
    }),
  }
  return { http, calls }
}

export const endpoints = {
  create: '/dict',
  show: (uuid: string) => `/dict/${uuid}`,
  update: (uuid: string) => `/dict/${uuid}`,
  destroy: (uuid: string) => `/dict/${uuid}`,
  audio: (uuid: string) => `/dict/${uuid}/audio`,
  retry: (uuid: string) => `/dict/${uuid}/retry`,
}

export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}
