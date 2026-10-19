import { flattenFields, uploadRecording } from '../src/uploadRecording'

class FakeFormData {
  parts: Array<[string, unknown]> = []
  append(name: string, value: unknown) {
    this.parts.push([name, value])
  }
}

describe('uploadRecording', () => {
  const originalFormData = globalThis.FormData
  beforeAll(() => {
    ;(globalThis as unknown as { FormData: unknown }).FormData = FakeFormData
  })
  afterAll(() => {
    ;(globalThis as unknown as { FormData: unknown }).FormData = originalFormData
  })

  test('posts multipart with the file under `audio` and returns response.data', async () => {
    const post = jest.fn(async () => ({ data: { uuid: 'abc', status: 'pending' } }))
    const result = await uploadRecording({
      http: { post },
      url: '/karton/diktat',
      uri: 'file:///tmp/rec.m4a',
      mime: 'audio/mp4',
      fields: { language: 'auto', duration_ms: 4200, context: { question_key: 'anamneza', field_label: 'Anamneza' }, recordable_id: 7, skip: null },
    })
    expect(result).toEqual({ uuid: 'abc', status: 'pending' })
    expect(post).toHaveBeenCalledTimes(1)
    const [url, body, config] = post.mock.calls[0] as unknown as [string, FakeFormData, Record<string, unknown>]
    expect(url).toBe('/karton/diktat')
    expect(body).toBeInstanceOf(FakeFormData)
    expect(body.parts[0]).toEqual(['audio', { uri: 'file:///tmp/rec.m4a', name: 'recording.m4a', type: 'audio/mp4' }])
    expect(body.parts.slice(1)).toEqual([
      ['language', 'auto'],
      ['duration_ms', '4200'],
      ['context[question_key]', 'anamneza'],
      ['context[field_label]', 'Anamneza'],
      ['recordable_id', '7'],
    ])
    expect(config.timeout).toBe(120000)
    expect(config.headers).toMatchObject({ 'Content-Type': 'multipart/form-data' })
  })

  test('custom timeout, field name, file name and headers', async () => {
    const post = jest.fn(async () => ({ data: 'ok' }))
    await uploadRecording({
      http: { post },
      url: 'u',
      uri: 'file:///x.m4a',
      fieldName: 'file',
      fileName: 'x.m4a',
      timeoutMs: 5000,
      headers: { Authorization: 'Bearer t' },
    })
    const [, body, config] = post.mock.calls[0] as unknown as [string, FakeFormData, Record<string, unknown>]
    expect(body.parts[0]).toEqual(['file', { uri: 'file:///x.m4a', name: 'x.m4a', type: 'audio/mp4' }])
    expect(config.timeout).toBe(5000)
    expect(config.headers).toMatchObject({ Authorization: 'Bearer t', 'Content-Type': 'multipart/form-data' })
  })

  test('propagates http errors', async () => {
    const post = jest.fn(async () => {
      throw new Error('Network Error')
    })
    await expect(uploadRecording({ http: { post }, url: 'u', uri: 'file:///x.m4a' })).rejects.toThrow('Network Error')
  })
})

describe('flattenFields', () => {
  test('bracket notation for nested objects, arrays and booleans', () => {
    expect(flattenFields({ a: 1, b: { c: 'x', d: { e: true } }, list: ['p', { q: 2 }], n: undefined })).toEqual([
      ['a', '1'],
      ['b[c]', 'x'],
      ['b[d][e]', '1'],
      ['list[0]', 'p'],
      ['list[1][q]', '2'],
    ])
  })
})
