import { CHUNK_SIZE, type NativeToWebMessage } from '@ditactic/dictation-protocol'
import { createBridgeController } from '../src/bridgeController'
import type { BridgeRecorder, RecordingResult } from '../src/types'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const msg = (m: Record<string, unknown>) => JSON.stringify(m)

function fakeRecorder(overrides: Partial<BridgeRecorder> = {}) {
  let state: 'idle' | 'recording' | 'paused' = 'idle'
  const recorder: BridgeRecorder & { state: () => string } = {
    start: jest.fn(async () => {
      state = 'recording'
    }),
    pause: jest.fn(async () => {
      state = 'paused'
    }),
    resume: jest.fn(async () => {
      state = 'recording'
    }),
    stop: jest.fn(async (): Promise<RecordingResult> => {
      state = 'idle'
      return { uri: 'file:///tmp/rec.m4a', mime: 'audio/mp4', durationMs: 4200, size: 0 }
    }),
    getStatus: jest.fn(() => ({ state, durationMs: 1234, level: 0.5 })),
    state: () => state,
    ...overrides,
  }
  return recorder
}

function setup(options: { base64?: string; recorder?: BridgeRecorder; maxDurationMs?: number; statusIntervalMs?: number } = {}) {
  const sent: NativeToWebMessage[] = []
  const files = new Map<string, string>([['file:///tmp/rec.m4a', options.base64 ?? 'QUJD']])
  const recorder = options.recorder ?? fakeRecorder()
  const readBase64 = jest.fn(async (uri: string) => {
    const data = files.get(uri)
    if (data === undefined) throw new Error('missing')
    return data
  })
  const deleteFile = jest.fn(async (uri: string) => {
    files.delete(uri)
  })
  const controller = createBridgeController({
    recorder,
    deliver: (m) => sent.push(m),
    readBase64,
    deleteFile,
    maxDurationMs: options.maxDurationMs ?? 600000,
    statusIntervalMs: options.statusIntervalMs ?? 10,
    yieldToUi: () => Promise.resolve(),
  })
  return { controller, sent, files, recorder, readBase64, deleteFile }
}

async function settle(sent: NativeToWebMessage[], type: string, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    if (sent.some((m) => m.type === type)) return
    await sleep(2)
  }
}

describe('createBridgeController', () => {
  test('answers ping with ready and advertises capabilities', () => {
    const { controller, sent } = setup({ maxDurationMs: 90000 })
    expect(controller.handleMessage(msg({ type: 'dictation:ping' }))).toBe(true)
    expect(sent).toEqual([
      { type: 'dictation:ready', version: 1, capabilities: { record: true, maxDurationMs: 90000, mime: 'audio/mp4' } },
    ])
    controller.onPageLoaded()
    expect(sent).toHaveLength(2)
  })

  test('ignores foreign and malformed messages', () => {
    const { controller, sent } = setup()
    expect(controller.handleMessage(msg({ type: 'app:navigate', to: '/x' }))).toBe(false)
    expect(controller.handleMessage('plain text')).toBe(false)
    expect(controller.handleMessage(undefined)).toBe(false)
    expect(controller.handleMessage(msg({ type: 'dictation:ready' }))).toBe(false) // native->web type, not ours to handle
    expect(sent).toEqual([])
  })

  test('second start while recording gets a busy error and does not touch the recorder', async () => {
    const { controller, sent, recorder } = setup()
    controller.handleMessage(msg({ type: 'dictation:start', id: 'a' }))
    controller.handleMessage(msg({ type: 'dictation:start', id: 'b' }))
    await sleep(5)
    expect(recorder.start).toHaveBeenCalledTimes(1)
    expect(sent.find((m) => m.type === 'dictation:error')).toEqual({
      type: 'dictation:error',
      id: 'b',
      code: 'busy',
      message: expect.any(String),
    })
    expect(controller.activeId()).toBe('a')
    expect(controller.isBusy()).toBe(true)
    await controller.dispose()
  })

  test('page may lower but not raise the duration limit', async () => {
    const { controller, recorder } = setup({ maxDurationMs: 60000 })
    controller.handleMessage(msg({ type: 'dictation:start', id: 'a', maxDurationMs: 30000 }))
    await sleep(2)
    expect(recorder.start).toHaveBeenCalledWith({ maxDurationMs: 30000 })
    await controller.dispose()

    const second = setup({ maxDurationMs: 60000 })
    second.controller.handleMessage(msg({ type: 'dictation:start', id: 'b', maxDurationMs: 999999 }))
    await sleep(2)
    expect(second.recorder.start).toHaveBeenCalledWith({ maxDurationMs: 60000 })
    await second.controller.dispose()
  })

  test('start failure is reported with the recorder error code', async () => {
    const recorder = fakeRecorder({
      start: jest.fn(async () => {
        throw Object.assign(new Error('Microphone permission was not granted.'), { code: 'permission_denied' })
      }),
    })
    const { controller, sent } = setup({ recorder })
    controller.handleMessage(msg({ type: 'dictation:start', id: 'a' }))
    await sleep(5)
    expect(sent).toContainEqual({ type: 'dictation:error', id: 'a', code: 'permission_denied', message: 'Microphone permission was not granted.' })
    expect(controller.isBusy()).toBe(false)
  })

  test('streams status while recording', async () => {
    const { controller, sent } = setup({ statusIntervalMs: 5 })
    controller.handleMessage(msg({ type: 'dictation:start', id: 'a' }))
    await sleep(40)
    const statuses = sent.filter((m) => m.type === 'dictation:status')
    expect(statuses.length).toBeGreaterThanOrEqual(3)
    expect(statuses[0]).toEqual({ type: 'dictation:status', id: 'a', state: 'recording', durationMs: 1234, level: 0.5 })
    await controller.dispose()
    const count = sent.length
    await sleep(20)
    expect(sent.length).toBe(count) // timer stopped
  })

  test('stop delivers file-begin, N chunks and file-end in order for a 500 KB base64 payload, then deletes the file', async () => {
    const base64 = 'A'.repeat(500 * 1024)
    const { controller, sent, files, deleteFile } = setup({ base64, statusIntervalMs: 1000 })
    controller.handleMessage(msg({ type: 'dictation:start', id: 'a' }))
    await sleep(2)
    controller.handleMessage(msg({ type: 'dictation:stop', id: 'a' }))
    await settle(sent, 'dictation:file-end')

    const expectedChunks = Math.ceil((500 * 1024) / CHUNK_SIZE) // 3
    expect(expectedChunks).toBe(3)
    const types = sent.map((m) => m.type)
    const beginAt = types.indexOf('dictation:file-begin')
    expect(beginAt).toBeGreaterThan(0)
    expect(types[beginAt - 1]).toBe('dictation:status')
    expect(sent[beginAt - 1]).toMatchObject({ state: 'stopped', durationMs: 4200 })
    expect(types.slice(beginAt)).toEqual([
      'dictation:file-begin',
      'dictation:file-chunk',
      'dictation:file-chunk',
      'dictation:file-chunk',
      'dictation:file-end',
    ])
    expect(sent[beginAt]).toEqual({
      type: 'dictation:file-begin',
      id: 'a',
      mime: 'audio/mp4',
      size: (500 * 1024 * 3) / 4,
      chunks: 3,
      durationMs: 4200,
    })
    const chunks = sent.filter((m) => m.type === 'dictation:file-chunk') as Array<{ index: number; data: string }>
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2])
    expect(chunks.map((c) => c.data).join('')).toBe(base64)
    expect(chunks[0].data.length).toBe(CHUNK_SIZE)
    expect(deleteFile).toHaveBeenCalledWith('file:///tmp/rec.m4a')
    expect(files.size).toBe(0)
    expect(controller.isBusy()).toBe(false)
  })

  test('stop with an unknown id reports not_recording', async () => {
    const { controller, sent } = setup()
    controller.handleMessage(msg({ type: 'dictation:stop', id: 'nope' }))
    await sleep(2)
    expect(sent).toEqual([{ type: 'dictation:error', id: 'nope', code: 'not_recording', message: expect.any(String) }])
  })

  test('cancel stops the recorder, deletes the file and delivers nothing', async () => {
    const { controller, sent, recorder, deleteFile, files } = setup()
    controller.handleMessage(msg({ type: 'dictation:start', id: 'a' }))
    await sleep(2)
    controller.handleMessage(msg({ type: 'dictation:cancel', id: 'a' }))
    await sleep(10)
    expect(recorder.stop).toHaveBeenCalledTimes(1)
    expect(deleteFile).toHaveBeenCalledWith('file:///tmp/rec.m4a')
    expect(files.size).toBe(0)
    expect(sent.some((m) => m.type.startsWith('dictation:file'))).toBe(false)
    expect(sent[sent.length - 1]).toMatchObject({ type: 'dictation:status', id: 'a', state: 'stopped' })
    expect(controller.isBusy()).toBe(false)
  })

  test('pause and resume forward to the recorder and report state', async () => {
    const { controller, sent, recorder } = setup({ statusIntervalMs: 1000 })
    controller.handleMessage(msg({ type: 'dictation:start', id: 'a' }))
    await sleep(2)
    controller.handleMessage(msg({ type: 'dictation:pause', id: 'a' }))
    await sleep(2)
    expect(recorder.pause).toHaveBeenCalled()
    expect(sent[sent.length - 1]).toMatchObject({ type: 'dictation:status', state: 'paused' })
    controller.handleMessage(msg({ type: 'dictation:resume', id: 'a' }))
    await sleep(2)
    expect(recorder.resume).toHaveBeenCalled()
    expect(sent[sent.length - 1]).toMatchObject({ type: 'dictation:status', state: 'recording' })
    await controller.dispose()
  })

  test('auto-stop (too_long) delivers the file and then an advisory too_long error', async () => {
    const { controller, sent, deleteFile } = setup({ statusIntervalMs: 1000 })
    controller.handleMessage(msg({ type: 'dictation:start', id: 'a' }))
    await sleep(2)
    await controller.notifyStopped({ uri: 'file:///tmp/rec.m4a', mime: 'audio/mp4', durationMs: 600000, size: 3 }, 'too_long')
    const types = sent.map((m) => m.type)
    expect(types.slice(-5)).toEqual([
      'dictation:status',
      'dictation:file-begin',
      'dictation:file-chunk',
      'dictation:file-end',
      'dictation:error',
    ])
    expect(sent[sent.length - 1]).toMatchObject({ code: 'too_long', id: 'a' })
    expect(deleteFile).toHaveBeenCalled()
    expect(controller.isBusy()).toBe(false)
  })

  test('interruption without audio reports an interrupted error', async () => {
    const { controller, sent } = setup({ statusIntervalMs: 1000 })
    controller.handleMessage(msg({ type: 'dictation:start', id: 'a' }))
    await sleep(2)
    controller.notifyError('interrupted', 'App moved to the background.')
    expect(sent[sent.length - 1]).toEqual({ type: 'dictation:error', id: 'a', code: 'interrupted', message: 'App moved to the background.' })
    expect(controller.isBusy()).toBe(false)
  })

  test('unreadable file reports an unknown error and frees the session', async () => {
    const { controller, sent, files } = setup()
    files.clear()
    controller.handleMessage(msg({ type: 'dictation:start', id: 'a' }))
    await sleep(2)
    controller.handleMessage(msg({ type: 'dictation:stop', id: 'a' }))
    await settle(sent, 'dictation:error')
    expect(sent[sent.length - 1]).toMatchObject({ type: 'dictation:error', id: 'a', code: 'unknown' })
    expect(controller.isBusy()).toBe(false)
  })
})
