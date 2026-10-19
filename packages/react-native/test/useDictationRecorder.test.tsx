import { AppState } from 'react-native'
import { __audio, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio'
import { __files, deleteAsync } from 'expo-file-system/legacy'
import { useDictationRecorder, type UseDictationRecorderOptions } from '../src/useDictationRecorder'
import { act, actCatch, flush, renderHook } from './helpers'

type Audio = typeof __audio & { recorder: NonNullable<(typeof __audio)['recorder']> }
const audio = __audio as Audio
const files = __files as Map<string, string>

const URI = 'file:///tmp/recording-1.m4a'

beforeEach(() => {
  __audio.reset()
  files.clear()
  files.set(URI, 'QUJDRA==') // "ABCD", 4 bytes
})

function mount(options: UseDictationRecorderOptions = {}) {
  return renderHook(() => useDictationRecorder({ pollIntervalMs: 5, ...options }))
}

describe('useDictationRecorder', () => {
  test('starts idle and starts recording after permission + audio mode + prepare', async () => {
    const { result, unmount } = mount()
    expect(result.current.state).toBe('idle')
    await act(() => result.current.start())
    expect(requestRecordingPermissionsAsync).toHaveBeenCalled()
    expect(setAudioModeAsync).toHaveBeenCalledWith({ allowsRecording: true, playsInSilentMode: true })
    expect(audio.recorder.prepareToRecordAsync).toHaveBeenCalled()
    expect(audio.recorder.record).toHaveBeenCalled()
    expect(result.current.state).toBe('recording')
    expect(result.current.error).toBeNull()
    await act(() => result.current.cancel())
    unmount()
  })

  test('permission denied maps to permission_denied and stays idle', async () => {
    __audio.permission = { granted: false, status: 'denied', canAskAgain: false }
    const { result, unmount } = mount()
    expect((await actCatch(() => result.current.start())).error).toMatchObject({ code: 'permission_denied' })
    expect(result.current.state).toBe('idle')
    expect(result.current.error).toMatchObject({ code: 'permission_denied' })
    expect(audio.recorder?.record ?? jest.fn()).not.toHaveBeenCalled()
    unmount()
  })

  test('second start while recording rejects with busy', async () => {
    const { result, unmount } = mount()
    await act(() => result.current.start())
    expect((await actCatch(() => result.current.start())).error).toMatchObject({ code: 'busy' })
    expect(result.current.error).toMatchObject({ code: 'busy' })
    expect(result.current.state).toBe('recording')
    await act(() => result.current.cancel())
    unmount()
  })

  test('polls duration and level while recording', async () => {
    const { result, unmount } = mount()
    await act(() => result.current.start())
    audio.recorder.durationMillis = 1500
    audio.recorder.metering = -30
    await flush(30)
    expect(result.current.durationMs).toBe(1500)
    expect(result.current.level).toBeCloseTo(0.5)
    expect(result.current.getStatus()).toEqual({ state: 'recording', durationMs: 1500, level: expect.closeTo(0.5) })
    await act(() => result.current.cancel())
    unmount()
  })

  test('stop resolves { uri, mime, durationMs, size } and releases the audio session', async () => {
    const { result, unmount } = mount()
    await act(() => result.current.start())
    audio.recorder.durationMillis = 4200
    await flush(20)
    let output: unknown
    await act(async () => {
      output = await result.current.stop()
    })
    expect(output).toEqual({ uri: URI, mime: 'audio/mp4', durationMs: 4200, size: 4 })
    expect(audio.recorder.stop).toHaveBeenCalledTimes(1)
    expect(setAudioModeAsync).toHaveBeenLastCalledWith({ allowsRecording: false, playsInSilentMode: true })
    expect(result.current.state).toBe('idle')
    expect(result.current.level).toBe(0)
    unmount()
  })

  test('stop while idle rejects with not_recording', async () => {
    const { result, unmount } = mount()
    expect((await actCatch(() => result.current.stop())).error).toMatchObject({ code: 'not_recording' })
    unmount()
  })

  test('pause / resume', async () => {
    const { result, unmount } = mount()
    await act(() => result.current.start())
    await act(() => result.current.pause())
    expect(audio.recorder.pause).toHaveBeenCalled()
    expect(result.current.state).toBe('paused')
    await act(() => result.current.resume())
    expect(audio.recorder.record).toHaveBeenCalledTimes(2)
    expect(result.current.state).toBe('recording')
    await act(() => result.current.cancel())
    unmount()
  })

  test('cancel stops and deletes the file', async () => {
    const { result, unmount } = mount()
    await act(() => result.current.start())
    await act(() => result.current.cancel())
    expect(audio.recorder.stop).toHaveBeenCalled()
    expect(deleteAsync).toHaveBeenCalledWith(URI, { idempotent: true })
    expect(files.has(URI)).toBe(false)
    expect(result.current.state).toBe('idle')
    unmount()
  })

  test('auto-stops at maxDurationMs and calls onAutoStop with the file', async () => {
    const onAutoStop = jest.fn()
    const { result, unmount } = mount({ maxDurationMs: 1000, onAutoStop })
    await act(() => result.current.start())
    audio.recorder.durationMillis = 1000
    await flush(40)
    expect(onAutoStop).toHaveBeenCalledWith({ uri: URI, mime: 'audio/mp4', durationMs: 1000, size: 4 })
    expect(result.current.state).toBe('idle')
    expect(result.current.error).toMatchObject({ code: 'too_long' })
    unmount()
  })

  test('start() may lower the limit per recording but not raise it', async () => {
    const onAutoStop = jest.fn()
    const { result, unmount } = mount({ maxDurationMs: 1000, onAutoStop })
    await act(() => result.current.start({ maxDurationMs: 5000 }))
    audio.recorder.durationMillis = 1200
    await flush(40)
    expect(onAutoStop).toHaveBeenCalledTimes(1)
    unmount()
  })

  test('app going to background stops the recording and reports interrupted with the partial file', async () => {
    const onInterrupted = jest.fn()
    const { result, unmount } = mount({ onInterrupted })
    await act(() => result.current.start())
    audio.recorder.durationMillis = 800
    await flush(20)
    await act(async () => {
      AppState.__emit('background')
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(onInterrupted).toHaveBeenCalledWith(
      { uri: URI, mime: 'audio/mp4', durationMs: 800, size: 4, interrupted: true },
      expect.objectContaining({ code: 'interrupted' }),
    )
    expect(result.current.error).toMatchObject({ code: 'interrupted', result: { interrupted: true } })
    expect(result.current.state).toBe('idle')
    unmount()
  })

  test('inactive (control center, permission alert) does not interrupt', async () => {
    const onInterrupted = jest.fn()
    const { result, unmount } = mount({ onInterrupted })
    await act(() => result.current.start())
    await act(async () => {
      AppState.__emit('inactive')
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(onInterrupted).not.toHaveBeenCalled()
    expect(result.current.state).toBe('recording')
    await act(() => result.current.cancel())
    unmount()
  })

  test('recorder finishing on its own (system interruption) is reported as interrupted', async () => {
    const onInterrupted = jest.fn()
    const { result, unmount } = mount({ onInterrupted })
    await act(() => result.current.start())
    await act(async () => {
      audio.recorder.__emitStatus({ isFinished: true, url: URI })
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(onInterrupted).toHaveBeenCalledWith(expect.objectContaining({ interrupted: true, uri: URI }), expect.objectContaining({ code: 'interrupted' }))
    expect(result.current.state).toBe('idle')
    unmount()
  })

  test('our own stop does not trigger the interruption path', async () => {
    const onInterrupted = jest.fn()
    const { result, unmount } = mount({ onInterrupted })
    await act(() => result.current.start())
    await act(async () => {
      const p = result.current.stop()
      audio.recorder.__emitStatus({ isFinished: true, url: URI })
      await p
    })
    expect(onInterrupted).not.toHaveBeenCalled()
    unmount()
  })

  test('unmount while recording stops the recorder, deletes the file and removes the AppState listener', async () => {
    const before = AppState.__listenerCount()
    const { result, unmount } = mount()
    expect(AppState.__listenerCount()).toBe(before + 1)
    await act(() => result.current.start())
    unmount()
    await new Promise((r) => setTimeout(r, 10))
    expect(audio.recorder.stop).toHaveBeenCalled()
    expect(deleteAsync).toHaveBeenCalledWith(URI, { idempotent: true })
    expect(AppState.__listenerCount()).toBe(before)
  })
})
