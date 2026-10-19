import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import type { Recording } from '../src/types'
import { extensionForMime, useDictation } from '../src/useDictation'
import { createFakeHttp, createFakeSource, endpoints, flush, makeRecording } from './helpers/fakes'

describe('useDictation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('records, uploads the right FormData and polls until done', async () => {
    const source = createFakeSource({ blob: new Blob(['abc'], { type: 'audio/webm;codecs=opus' }), durationMs: 5300 })
    const pending = makeRecording({ status: 'pending', transcript: null, final_text: null })
    const { http, calls } = createFakeHttp({
      post: { data: pending },
      gets: [{ data: { ...pending, status: 'processing' } }, { data: { ...pending, status: 'processing' } }, { data: makeRecording() }],
    })
    const phases: string[] = []
    const d = useDictation({
      http,
      endpoints,
      language: 'bs',
      context: () => ({ question_key: 'anamneza', field_label: 'Anamneza', meta: { a: 1 }, skip: null }),
      recordable: async () => ({ type: 'carton_entry', id: 42 }),
      recorder: { source: source.factory },
    })
    const stop = watch(d.phase, (p) => phases.push(p), { flush: 'sync' })

    await expect(d.start()).resolves.toBe(true)
    expect(d.phase.value).toBe('recording')
    vi.advanceTimersByTime(1500)

    const finishing = d.finish()
    await flush(20)
    expect(['uploading', 'transcribing']).toContain(d.phase.value)

    // Poll 1 after 1.5 s, poll 2 after 2.25 s, poll 3 after 3.375 s.
    await vi.advanceTimersByTimeAsync(1500)
    expect(http.get).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2250)
    expect(http.get).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3375)
    expect(http.get).toHaveBeenCalledTimes(3)

    const final = await finishing
    expect(final?.status).toBe('done')
    expect(d.phase.value).toBe('done')
    expect(d.transcript.value).toBe('Pacijent se žali na bol.')
    expect(phases).toEqual(['recording', 'uploading', 'transcribing', 'done'])

    // No more polling after done.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(http.get).toHaveBeenCalledTimes(3)

    const upload = calls.find((c) => c.method === 'post')!
    expect(upload.url).toBe('/dict')
    const form = upload.body as FormData
    const audio = form.get('audio') as File
    expect(audio).toBeInstanceOf(Blob)
    expect(audio.name).toBe('recording.webm')
    expect(form.get('language')).toBe('bs')
    expect(form.get('duration_ms')).toBe('5300')
    expect(form.get('context[question_key]')).toBe('anamneza')
    expect(form.get('context[field_label]')).toBe('Anamneza')
    expect(form.get('context[meta]')).toBe('{"a":1}')
    expect(form.has('context[skip]')).toBe(false)
    expect(form.get('recordable_type')).toBe('carton_entry')
    expect(form.get('recordable_id')).toBe('42')
    stop()
  })

  it('stops polling and reports failed when the server says failed', async () => {
    const source = createFakeSource()
    const pending = makeRecording({ status: 'pending' })
    const { http } = createFakeHttp({
      post: pending,
      gets: [makeRecording({ status: 'failed', error: 'Engine timeout' })],
    })
    const d = useDictation({ http, endpoints, recorder: { source: source.factory } })
    await d.start()
    const finishing = d.finish()
    await flush(20)
    await vi.advanceTimersByTimeAsync(1500)
    await finishing
    expect(d.phase.value).toBe('failed')
    expect(d.error.value).toMatchObject({ code: 'transcription_failed', message: 'Engine timeout' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(http.get).toHaveBeenCalledTimes(1)
  })

  it('finishes immediately when the upload response is already terminal', async () => {
    const source = createFakeSource()
    const { http } = createFakeHttp({ post: makeRecording({ status: 'done', final_text: 'Gotovo.' }) })
    const d = useDictation({ http, endpoints, recorder: { source: source.factory } })
    await d.start()
    await d.finish()
    expect(d.phase.value).toBe('done')
    expect(d.transcript.value).toBe('Gotovo.')
    expect(http.get).not.toHaveBeenCalled()
  })

  it('uses subscribe() when provided and unsubscribes afterwards', async () => {
    const source = createFakeSource()
    const pending = makeRecording({ status: 'pending' })
    const { http } = createFakeHttp({ post: pending, gets: [pending] })
    const unsubscribe = vi.fn()
    let push: ((r: Recording) => void) | null = null
    const subscribe = vi.fn((_uuid: string, cb: (r: Recording) => void) => {
      push = cb
      return unsubscribe
    })
    const d = useDictation({ http, endpoints, subscribe, recorder: { source: source.factory } })
    await d.start()
    const finishing = d.finish()
    await flush(20)
    expect(subscribe).toHaveBeenCalledWith('r-1', expect.any(Function))
    push!({ data: makeRecording({ final_text: 'Preko kanala.' }) } as unknown as Recording)
    await finishing
    expect(d.phase.value).toBe('done')
    expect(d.transcript.value).toBe('Preko kanala.')
    expect(unsubscribe).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(http.get).not.toHaveBeenCalled()
  })

  it('fails on upload errors and can retry by recording again', async () => {
    const source = createFakeSource()
    const { http } = createFakeHttp({})
    ;(http.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce({ response: { data: { message: 'Prevelik fajl' } } })
    const d = useDictation({ http, endpoints, recorder: { source: source.factory } })
    await d.start()
    await d.finish()
    expect(d.phase.value).toBe('failed')
    expect(d.error.value).toMatchObject({ code: 'upload_failed', message: 'Prevelik fajl' })
    await d.retry()
    expect(d.phase.value).toBe('recording')
  })

  it('retries a failed transcription through the retry endpoint', async () => {
    const source = createFakeSource()
    const failed = makeRecording({ status: 'failed', error: 'x' })
    const { http } = createFakeHttp({ post: failed, gets: [makeRecording({ final_text: 'Drugi put.' })] })
    const d = useDictation({ http, endpoints, recorder: { source: source.factory } })
    await d.start()
    await d.finish()
    expect(d.phase.value).toBe('failed')
    ;(http.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { ...failed, status: 'pending', error: null } })
    const retrying = d.retry()
    await flush(4)
    expect(d.phase.value).toBe('transcribing')
    expect(http.post).toHaveBeenLastCalledWith('/dict/r-1/retry', null, expect.anything())
    await vi.advanceTimersByTimeAsync(1500)
    await expect(retrying).resolves.toBe(true)
    expect(d.transcript.value).toBe('Drugi put.')
  })

  it('cancel() during transcribing stops polling and resets', async () => {
    const source = createFakeSource()
    const pending = makeRecording({ status: 'pending' })
    const { http } = createFakeHttp({ post: pending, gets: [pending] })
    const d = useDictation({ http, endpoints, recorder: { source: source.factory } })
    await d.start()
    const finishing = d.finish()
    await flush(20)
    expect(d.phase.value).toBe('transcribing')
    d.cancel()
    expect(d.phase.value).toBe('idle')
    await expect(finishing).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(http.get).not.toHaveBeenCalled()
  })

  it('reports recorder errors as failed phase', async () => {
    const source = createFakeSource()
    source.failStartWith(new DOMException('denied', 'NotAllowedError'))
    const { http } = createFakeHttp({})
    const d = useDictation({ http, endpoints, recorder: { source: source.factory } })
    await expect(d.start()).resolves.toBe(false)
    expect(d.phase.value).toBe('failed')
    expect(d.error.value?.code).toBe('unknown')
  })

  it('auto-stop (max duration) finishes on its own', async () => {
    const source = createFakeSource()
    const { http } = createFakeHttp({ post: makeRecording({ final_text: 'Auto.' }) })
    const d = useDictation({ http, endpoints, recorder: { source: source.factory, maxDurationMs: 2000 } })
    await d.start()
    await vi.advanceTimersByTimeAsync(2400)
    await flush(20)
    expect(d.phase.value).toBe('done')
    expect(d.transcript.value).toBe('Auto.')
  })

  it('maps mime types to file extensions', () => {
    expect(extensionForMime('audio/webm;codecs=opus')).toBe('webm')
    expect(extensionForMime('audio/mp4')).toBe('m4a')
    expect(extensionForMime('audio/ogg;codecs=opus')).toBe('ogg')
    expect(extensionForMime('audio/mpeg')).toBe('mp3')
    expect(extensionForMime('')).toBe('webm')
  })
})
