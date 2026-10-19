import { describe, expect, it } from 'vitest'
import {
  ChunkAssembler,
  buildDeliveryScript,
  buildInjectedScript,
  chunkBase64,
  parseMessage,
  serialize,
} from '../src/index'

describe('parseMessage', () => {
  it('parses known messages and rejects the rest', () => {
    expect(parseMessage(serialize({ type: 'dictation:ping' }))).toEqual({ type: 'dictation:ping' })
    expect(parseMessage('{"type":"other"}')).toBeNull()
    expect(parseMessage('not json')).toBeNull()
    expect(parseMessage(42)).toBeNull()
  })
})

describe('ChunkAssembler', () => {
  it('reassembles chunks in any order', () => {
    const payload = 'A'.repeat(1000) + 'B'.repeat(1000) + 'C'.repeat(500)
    const chunks = chunkBase64(payload, 1000)
    expect(chunks).toHaveLength(3)

    const assembler = new ChunkAssembler()
    expect(
      assembler.push({ type: 'dictation:file-begin', id: 'r1', mime: 'audio/mp4', size: 3, chunks: 3, durationMs: 1200 }),
    ).toBeNull()
    expect(assembler.push({ type: 'dictation:file-chunk', id: 'r1', index: 2, data: chunks[2] })).toBeNull()
    expect(assembler.push({ type: 'dictation:file-chunk', id: 'r1', index: 0, data: chunks[0] })).toBeNull()
    expect(assembler.push({ type: 'dictation:file-chunk', id: 'r1', index: 1, data: chunks[1] })).toBeNull()
    const file = assembler.push({ type: 'dictation:file-end', id: 'r1' })
    expect(file).toEqual({ mime: 'audio/mp4', size: 3, durationMs: 1200, base64: payload })
  })

  it('throws on an incomplete file', () => {
    const assembler = new ChunkAssembler()
    assembler.push({ type: 'dictation:file-begin', id: 'r1', mime: 'audio/mp4', size: 3, chunks: 2, durationMs: 1 })
    assembler.push({ type: 'dictation:file-chunk', id: 'r1', index: 0, data: 'x' })
    expect(() => assembler.push({ type: 'dictation:file-end', id: 'r1' })).toThrow(/incomplete/)
  })

  it('ignores chunks for another recording id', () => {
    const assembler = new ChunkAssembler()
    assembler.push({ type: 'dictation:file-begin', id: 'r1', mime: 'audio/mp4', size: 1, chunks: 1, durationMs: 1 })
    assembler.push({ type: 'dictation:file-chunk', id: 'other', index: 0, data: 'x' })
    expect(() => assembler.push({ type: 'dictation:file-end', id: 'r1' })).toThrow(/incomplete/)
  })
})

describe('injected scripts', () => {
  it('publishes the marker and a receive function', () => {
    const script = buildInjectedScript({ record: true, maxDurationMs: 1000, mime: 'audio/mp4' })
    expect(script).toContain('window.__DICTATION_BRIDGE__ = {"version":1')
    expect(script).toContain('window.__dictationReceive = function')
  })

  it('delivery script is valid JS that calls the receiver', () => {
    const script = buildDeliveryScript({ type: 'dictation:file-end', id: 'r"1' })
    const calls: unknown[] = []
    const fn = new Function('window', script)
    fn({ __dictationReceive: (json: string) => calls.push(JSON.parse(json)) })
    expect(calls).toEqual([{ type: 'dictation:file-end', id: 'r"1' }])
  })
})
