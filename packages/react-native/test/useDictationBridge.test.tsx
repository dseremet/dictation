import { createElement } from 'react'
import { CHUNK_SIZE, ChunkAssembler, type NativeToWebMessage } from '@ditactic/dictation-protocol'
import { __audio } from 'expo-audio'
import { __files, deleteAsync } from 'expo-file-system/legacy'
import { useDictationBridge } from '../src/useDictationBridge'
import { DictationButton } from '../src/DictationButton'
import { act, flush, render, renderHook } from './helpers'

const files = __files as Map<string, string>
const URI = 'file:///tmp/recording-1.m4a'

/** Decode the delivery scripts the bridge injected back into messages. */
function decode(scripts: string[]): NativeToWebMessage[] {
  return scripts
    .filter((s) => s.includes('__dictationReceive('))
    .map((s) => {
      const m = /__dictationReceive\(("(?:[^"\\]|\\.)*")\); true;$/.exec(s)
      if (!m) throw new Error(`unexpected script: ${s.slice(0, 80)}`)
      return JSON.parse(JSON.parse(m[1])) as NativeToWebMessage
    })
}

function fakeWebView() {
  const scripts: string[] = []
  const ref = { current: { injectJavaScript: (script: string) => void scripts.push(script) } }
  return { ref, scripts }
}

const event = (payload: unknown) => ({ nativeEvent: { data: typeof payload === 'string' ? payload : JSON.stringify(payload) } })

beforeEach(() => {
  __audio.reset()
  files.clear()
})

describe('useDictationBridge', () => {
  test('injected script publishes the bridge marker with capabilities', () => {
    const { ref } = fakeWebView()
    const { result, unmount } = renderHook(() => useDictationBridge({ webViewRef: ref, maxDurationMs: 120000 }))
    expect(result.current.injectedJavaScriptBeforeContentLoaded).toContain('window.__DICTATION_BRIDGE__ = {"version":1,"capabilities":{"record":true,"maxDurationMs":120000,"mime":"audio/mp4"}}')
    expect(result.current.injectedJavaScriptBeforeContentLoaded).toContain('window.__dictationReceive = function')
    expect(result.current.isRecording).toBe(false)
    unmount()
  })

  test('sends ready on ping and on load end, forwards foreign messages and onLoadEnd', async () => {
    const { ref, scripts } = fakeWebView()
    const onMessage = jest.fn()
    const onLoadEnd = jest.fn()
    const { result, unmount } = renderHook(() => useDictationBridge({ webViewRef: ref, onMessage, onLoadEnd }))

    act(() => result.current.onMessage(event({ type: 'dictation:ping' })))
    expect(decode(scripts)).toEqual([{ type: 'dictation:ready', version: 1, capabilities: { record: true, maxDurationMs: 600000, mime: 'audio/mp4' } }])

    const foreign = event({ type: 'app:logout' })
    act(() => result.current.onMessage(foreign))
    expect(onMessage).toHaveBeenCalledWith(foreign)
    act(() => result.current.onMessage(event('hello')))
    expect(onMessage).toHaveBeenCalledTimes(2)
    expect(decode(scripts)).toHaveLength(1)

    const loadEvent = { nativeEvent: { url: 'https://example.test' } }
    act(() => result.current.onLoadEnd(loadEvent))
    expect(onLoadEnd).toHaveBeenCalledWith(loadEvent)
    expect(decode(scripts)).toHaveLength(2)
    expect(decode(scripts)[1].type).toBe('dictation:ready')
    unmount()
  })

  test('start -> status -> stop delivers the file in chunks that reassemble, then deletes it', async () => {
    const base64 = Buffer.alloc(300 * 1024, 7).toString('base64') // 400 KB base64 -> 3 chunks
    files.set(URI, base64)
    const { ref, scripts } = fakeWebView()
    const onEvent = jest.fn()
    const { result, unmount } = renderHook(() => useDictationBridge({ webViewRef: ref, statusIntervalMs: 5, pollIntervalMs: 5, onEvent }))

    await act(async () => {
      result.current.onMessage(event({ type: 'dictation:start', id: 'r1' }))
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(result.current.isRecording).toBe(true)
    expect(result.current.state).toBe('recording')
    __audio.recorder!.durationMillis = 2500
    __audio.recorder!.metering = -30
    await flush(40)
    const statuses = decode(scripts).filter((m) => m.type === 'dictation:status')
    expect(statuses.length).toBeGreaterThanOrEqual(2)
    expect(statuses[statuses.length - 1]).toMatchObject({ id: 'r1', state: 'recording', durationMs: 2500, level: expect.closeTo(0.5) })

    await act(async () => {
      result.current.onMessage(event({ type: 'dictation:stop', id: 'r1' }))
      await new Promise((r) => setTimeout(r, 50))
    })
    const messages = decode(scripts)
    const begin = messages.findIndex((m) => m.type === 'dictation:file-begin')
    expect(messages[begin - 1]).toMatchObject({ type: 'dictation:status', state: 'stopped', durationMs: 2500 })
    expect(messages[begin]).toEqual({ type: 'dictation:file-begin', id: 'r1', mime: 'audio/mp4', size: 300 * 1024, chunks: Math.ceil(base64.length / CHUNK_SIZE), durationMs: 2500 })
    const assembler = new ChunkAssembler()
    let assembled: ReturnType<ChunkAssembler['push']> = null
    for (const m of messages.slice(begin)) assembled = assembler.push(m) ?? assembled
    expect(assembled).toEqual({ mime: 'audio/mp4', size: 300 * 1024, durationMs: 2500, base64 })
    expect(messages[messages.length - 1]).toEqual({ type: 'dictation:file-end', id: 'r1' })
    expect(deleteAsync).toHaveBeenCalledWith(URI, { idempotent: true })
    expect(result.current.isRecording).toBe(false)
    expect(onEvent).toHaveBeenCalledWith({ direction: 'in', message: { type: 'dictation:start', id: 'r1' } })
    expect(onEvent.mock.calls.some(([e]) => e.direction === 'out' && e.message.type === 'dictation:file-end')).toBe(true)
    unmount()
  })

  test('busy while recording, permission denied reported to the page', async () => {
    files.set(URI, 'QUJD')
    const { ref, scripts } = fakeWebView()
    const { result, unmount } = renderHook(() => useDictationBridge({ webViewRef: ref, statusIntervalMs: 1000, pollIntervalMs: 5 }))
    await act(async () => {
      result.current.onMessage(event({ type: 'dictation:start', id: 'r1' }))
      await new Promise((r) => setTimeout(r, 10))
      result.current.onMessage(event({ type: 'dictation:start', id: 'r2' }))
    })
    expect(decode(scripts).find((m) => m.type === 'dictation:error')).toMatchObject({ id: 'r2', code: 'busy' })
    await act(async () => {
      result.current.onMessage(event({ type: 'dictation:cancel', id: 'r1' }))
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(files.has(URI)).toBe(false)

    __audio.permission = { granted: false, status: 'denied', canAskAgain: false }
    await act(async () => {
      result.current.onMessage(event({ type: 'dictation:start', id: 'r3' }))
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(decode(scripts).pop()).toMatchObject({ type: 'dictation:error', id: 'r3', code: 'permission_denied' })
    unmount()
  })

  test('auto-stop at the limit delivers the file followed by an advisory too_long error', async () => {
    files.set(URI, 'QUJD')
    const { ref, scripts } = fakeWebView()
    const { result, unmount } = renderHook(() => useDictationBridge({ webViewRef: ref, maxDurationMs: 1000, statusIntervalMs: 1000, pollIntervalMs: 5 }))
    await act(async () => {
      result.current.onMessage(event({ type: 'dictation:start', id: 'r1' }))
      await new Promise((r) => setTimeout(r, 10))
    })
    __audio.recorder!.durationMillis = 1000
    await flush(60)
    const types = decode(scripts).map((m) => m.type)
    expect(types.slice(-5)).toEqual(['dictation:status', 'dictation:file-begin', 'dictation:file-chunk', 'dictation:file-end', 'dictation:error'])
    expect(decode(scripts).pop()).toMatchObject({ code: 'too_long', id: 'r1' })
    unmount()
  })
})

describe('DictationButton', () => {
  test('renders start label, records, then reports the result', async () => {
    files.set(URI, 'QUJD')
    const onResult = jest.fn()
    const renderer = render(createElement(DictationButton, { onResult }))
    const pressable = renderer.root.findByType('Pressable' as never)
    const texts = () => renderer.root.findAllByType('Text' as never).map((t) => t.props.children as unknown)
    expect(texts()).toEqual(['Diktiraj'])
    await act(() => pressable.props.onPress())
    expect(texts()[0]).toBe('Završi')
    await act(() => pressable.props.onPress())
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ uri: URI, mime: 'audio/mp4' }))
    expect(texts()).toEqual(['Diktiraj'])
    act(() => renderer.unmount())
  })

  test('reports permission errors through onError', async () => {
    __audio.permission = { granted: false, status: 'denied', canAskAgain: false }
    const onError = jest.fn()
    const renderer = render(createElement(DictationButton, { onResult: jest.fn(), onError, labels: { start: 'Rec' } }))
    const pressable = renderer.root.findByType('Pressable' as never)
    await act(() => pressable.props.onPress())
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'permission_denied' }))
    act(() => renderer.unmount())
  })
})
