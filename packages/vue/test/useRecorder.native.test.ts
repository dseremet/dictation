import { BRIDGE_GLOBAL, chunkBase64 } from '@ditactic/dictation-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasNativeBridge } from '../src/recorder/nativeBridgeSource'
import { useRecorder } from '../src/recorder/useRecorder'

function dispatch(detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent('dictation', { detail }))
}

function posted(postMessage: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return postMessage.mock.calls.map(([raw]) => JSON.parse(raw as string))
}

describe('useRecorder with the native bridge', () => {
  let postMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    postMessage = vi.fn()
    ;(window as unknown as Record<string, unknown>)[BRIDGE_GLOBAL] = {
      version: 1,
      capabilities: { record: true, maxDurationMs: 600000, mime: 'audio/mp4' },
    }
    ;(window as unknown as Record<string, unknown>).ReactNativeWebView = { postMessage }
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as Record<string, unknown>)[BRIDGE_GLOBAL]
    delete (window as unknown as Record<string, unknown>).ReactNativeWebView
  })

  it('is chosen automatically when the marker exists', () => {
    expect(hasNativeBridge()).toBe(true)
  })

  it('posts start, tracks status and reassembles the chunked file on stop', async () => {
    const rec = useRecorder()
    const starting = rec.start()
    expect(rec.state.value).toBe('requesting')
    expect(rec.isNative.value).toBe(true)

    const start = posted(postMessage)[0]
    expect(start.type).toBe('dictation:start')
    expect(start.maxDurationMs).toBe(600000)
    const id = start.id as string

    dispatch({ type: 'dictation:status', id, state: 'recording', durationMs: 0, level: 0.1 })
    await expect(starting).resolves.toBe(true)
    expect(rec.state.value).toBe('recording')

    dispatch({ type: 'dictation:status', id, state: 'recording', durationMs: 2500, level: 0.6 })
    expect(rec.durationMs.value).toBe(2500)
    expect(rec.level.value).toBe(0.6)
    vi.advanceTimersByTime(1000)
    expect(rec.durationMs.value).toBeGreaterThanOrEqual(3400)

    // A status for another recording id is ignored.
    dispatch({ type: 'dictation:status', id: 'other', state: 'recording', durationMs: 99999, level: 1 })
    expect(rec.durationMs.value).toBeLessThan(5000)

    const stopping = rec.stop()
    expect(rec.state.value).toBe('stopping')
    expect(posted(postMessage).at(-1)).toEqual({ type: 'dictation:stop', id })

    const bytes = new Uint8Array(500).map((_, i) => i % 251)
    const base64 = btoa(String.fromCharCode(...bytes))
    const chunks = chunkBase64(base64, 100)
    dispatch({ type: 'dictation:file-begin', id, mime: 'audio/mp4', size: bytes.length, chunks: chunks.length, durationMs: 3600 })
    chunks.forEach((data, index) => dispatch({ type: 'dictation:file-chunk', id, index, data }))
    dispatch({ type: 'dictation:file-end', id })

    const result = await stopping
    expect(rec.state.value).toBe('ready')
    expect(result.mime).toBe('audio/mp4')
    expect(result.durationMs).toBe(3600)
    expect(result.blob.type).toBe('audio/mp4')
    expect(result.blob.size).toBe(500)
    vi.useRealTimers() // jsdom's FileReader needs real timers
    const received = await new Promise<Uint8Array>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
      reader.readAsArrayBuffer(result.blob)
    })
    expect(Array.from(received)).toEqual(Array.from(bytes))
  })

  it('accepts string details (raw JSON) as well as objects', async () => {
    const rec = useRecorder()
    const starting = rec.start()
    const id = posted(postMessage)[0].id as string
    window.dispatchEvent(new CustomEvent('dictation', { detail: JSON.stringify({ type: 'dictation:status', id, state: 'recording', durationMs: 0 }) }))
    await expect(starting).resolves.toBe(true)
  })

  it('fails with the native error code', async () => {
    const rec = useRecorder()
    const starting = rec.start()
    const id = posted(postMessage)[0].id as string
    dispatch({ type: 'dictation:error', id, code: 'permission_denied', message: 'nope' })
    await expect(starting).resolves.toBe(false)
    expect(rec.state.value).toBe('error')
    expect(rec.error.value).toMatchObject({ code: 'permission_denied', message: 'nope' })
  })

  it('errors when the file never arrives (30 s timeout)', async () => {
    const rec = useRecorder()
    const starting = rec.start()
    const id = posted(postMessage)[0].id as string
    dispatch({ type: 'dictation:status', id, state: 'recording', durationMs: 0 })
    await starting
    const stopping = rec.stop()
    stopping.catch(() => undefined)
    vi.advanceTimersByTime(30_001)
    await expect(stopping).rejects.toMatchObject({ code: 'interrupted' })
    expect(rec.state.value).toBe('error')
  })

  it('cancel posts dictation:cancel and resets', async () => {
    const rec = useRecorder()
    const starting = rec.start()
    const id = posted(postMessage)[0].id as string
    dispatch({ type: 'dictation:status', id, state: 'recording', durationMs: 0 })
    await starting
    rec.cancel()
    expect(posted(postMessage).at(-1)).toEqual({ type: 'dictation:cancel', id })
    expect(rec.state.value).toBe('idle')
  })

  it('reports unsupported when postMessage is missing', async () => {
    delete (window as unknown as Record<string, unknown>).ReactNativeWebView
    const rec = useRecorder()
    await expect(rec.start()).resolves.toBe(false)
    expect(rec.error.value?.code).toBe('unsupported')
  })
})
