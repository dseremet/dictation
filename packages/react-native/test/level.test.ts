import { base64ByteLength, dbToLevel, formatDuration } from '../src/level'
import { DICTATION_RECORDING_OPTIONS } from '../src/recordingOptions'

describe('dbToLevel', () => {
  test('maps dBFS to 0..1 with a -60 dB floor', () => {
    expect(dbToLevel(0)).toBe(1)
    expect(dbToLevel(-30)).toBeCloseTo(0.5)
    expect(dbToLevel(-60)).toBe(0)
    expect(dbToLevel(-160)).toBe(0)
    expect(dbToLevel(5)).toBe(1)
  })
  test('tolerates missing metering', () => {
    expect(dbToLevel(undefined)).toBe(0)
    expect(dbToLevel(null)).toBe(0)
    expect(dbToLevel(Number.NaN)).toBe(0)
  })
  test('custom floor', () => {
    expect(dbToLevel(-80, -160)).toBeCloseTo(0.5)
  })
})

describe('formatDuration', () => {
  test('m:ss and h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(3_600_000 + 61_000)).toBe('1:01:01')
    expect(formatDuration(-5)).toBe('0:00')
  })
})

describe('base64ByteLength', () => {
  test('accounts for padding', () => {
    expect(base64ByteLength('')).toBe(0)
    expect(base64ByteLength(Buffer.from('a').toString('base64'))).toBe(1)
    expect(base64ByteLength(Buffer.from('ab').toString('base64'))).toBe(2)
    expect(base64ByteLength(Buffer.from('abc').toString('base64'))).toBe(3)
  })
})

describe('recording preset', () => {
  test('is mono 16 kHz AAC in m4a with metering', () => {
    expect(DICTATION_RECORDING_OPTIONS).toMatchObject({
      extension: '.m4a',
      sampleRate: 16000,
      numberOfChannels: 1,
      bitRate: 32000,
      isMeteringEnabled: true,
      android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
    })
  })
})
