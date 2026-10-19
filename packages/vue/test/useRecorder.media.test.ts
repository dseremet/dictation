import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { pickMimeType } from '../src/recorder/mediaRecorderSource'
import { useRecorder } from '../src/recorder/useRecorder'
import { FakeMediaRecorder, installFakeMedia, uninstallFakeMedia } from './helpers/fakes'

describe('useRecorder with MediaRecorder', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    uninstallFakeMedia()
  })

  it('goes idle → requesting → recording → stopping → ready and delivers the blob', async () => {
    const { tracks, gum } = installFakeMedia()
    const scope = effectScope()
    const rec = scope.run(() => useRecorder({ source: 'media' }))!

    expect(rec.state.value).toBe('idle')
    const starting = rec.start()
    expect(rec.state.value).toBe('requesting')
    await expect(starting).resolves.toBe(true)
    expect(rec.state.value).toBe('recording')
    expect(rec.isNative.value).toBe(false)
    expect(gum).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })

    const instance = FakeMediaRecorder.instances[0]
    expect(instance.mimeType).toBe('audio/webm;codecs=opus')
    expect(instance.timeslice).toBe(1000)

    vi.advanceTimersByTime(2300)
    expect(rec.durationMs.value).toBeGreaterThanOrEqual(2200)

    const stopping = rec.stop()
    expect(rec.state.value).toBe('stopping')
    const result = await stopping
    expect(rec.state.value).toBe('ready')
    expect(result.mime).toBe('audio/webm;codecs=opus')
    expect(result.blob.size).toBe('fake-audio-bytes'.length)
    expect(result.durationMs).toBeGreaterThanOrEqual(2200)
    expect(tracks[0].stop).toHaveBeenCalled()

    // A second stop() after ready hands back the same result.
    await expect(rec.stop()).resolves.toBe(result)
    scope.stop()
  })

  it('pauses and resumes without counting paused time', async () => {
    installFakeMedia()
    const rec = useRecorder({ source: 'media' })
    await rec.start()
    vi.advanceTimersByTime(1000)
    rec.pause()
    expect(rec.state.value).toBe('paused')
    expect(FakeMediaRecorder.instances[0].state).toBe('paused')
    vi.advanceTimersByTime(5000)
    rec.resume()
    expect(rec.state.value).toBe('recording')
    vi.advanceTimersByTime(1000)
    expect(rec.durationMs.value).toBeGreaterThanOrEqual(2000)
    expect(rec.durationMs.value).toBeLessThan(3000)
    const result = await rec.stop()
    expect(result.durationMs).toBeLessThan(3000)
  })

  it('auto-stops at maxDurationMs and is ready for finish()', async () => {
    installFakeMedia()
    const rec = useRecorder({ source: 'media', maxDurationMs: 3000 })
    await rec.start()
    vi.advanceTimersByTime(3400)
    await Promise.resolve()
    await Promise.resolve()
    expect(['stopping', 'ready']).toContain(rec.state.value)
    const result = await rec.stop()
    expect(rec.state.value).toBe('ready')
    expect(result.blob.size).toBeGreaterThan(0)
  })

  it('maps NotAllowedError to permission_denied', async () => {
    installFakeMedia(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')))
    const rec = useRecorder({ source: 'media' })
    await expect(rec.start()).resolves.toBe(false)
    expect(rec.state.value).toBe('error')
    expect(rec.error.value?.code).toBe('permission_denied')
  })

  it('maps NotFoundError to unsupported and reports unsupported without MediaRecorder', async () => {
    installFakeMedia(vi.fn().mockRejectedValue(new DOMException('no mic', 'NotFoundError')))
    const rec = useRecorder({ source: 'media' })
    await rec.start()
    expect(rec.error.value?.code).toBe('unsupported')

    vi.stubGlobal('MediaRecorder', undefined)
    const rec2 = useRecorder({ source: 'media' })
    await rec2.start()
    expect(rec2.state.value).toBe('error')
    expect(rec2.error.value?.code).toBe('unsupported')
  })

  it('cancel stops tracks, discards audio and returns to idle', async () => {
    const { tracks } = installFakeMedia()
    const rec = useRecorder({ source: 'media' })
    await rec.start()
    rec.cancel()
    expect(rec.state.value).toBe('idle')
    expect(rec.durationMs.value).toBe(0)
    expect(tracks[0].stop).toHaveBeenCalled()
    await expect(rec.stop()).rejects.toMatchObject({ code: 'not_recording' })
  })

  it('installs a beforeunload guard only while recording', async () => {
    installFakeMedia()
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const rec = useRecorder({ source: 'media' })
    await rec.start()
    expect(add.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true)
    await rec.stop()
    expect(remove.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true)
  })

  it('feeds the level meter from an AnalyserNode when AudioContext exists', async () => {
    installFakeMedia()
    const close = vi.fn().mockResolvedValue(undefined)
    class FakeAudioContext {
      createAnalyser() {
        return {
          fftSize: 2048,
          getByteTimeDomainData(buffer: Uint8Array) {
            for (let i = 0; i < buffer.length; i += 1) buffer[i] = i % 2 ? 160 : 96
          },
        }
      }
      createMediaStreamSource() {
        return { connect: vi.fn() }
      }
      close = close
    }
    vi.stubGlobal('AudioContext', FakeAudioContext)
    let frame: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const rec = useRecorder({ source: 'media' })
    await rec.start()
    expect(frame).not.toBeNull()
    frame!(0)
    expect(rec.level.value).toBeGreaterThan(0.5)
    await rec.stop()
    expect(rec.level.value).toBe(0)
    expect(close).toHaveBeenCalled()
  })

  it('pickMimeType honours the preference order', () => {
    installFakeMedia()
    FakeMediaRecorder.supported = ['audio/mp4']
    expect(pickMimeType()).toBe('audio/mp4')
    FakeMediaRecorder.supported = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus']
    expect(pickMimeType()).toBe('audio/webm;codecs=opus')
    FakeMediaRecorder.supported = []
    expect(pickMimeType()).toBeUndefined()
    FakeMediaRecorder.supported = ['audio/webm;codecs=opus']
  })
})
