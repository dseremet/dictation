import { RECORDING_MIME, type HttpClient } from './types'

export type UploadFieldValue = string | number | boolean | null | undefined | UploadFields | UploadFieldValue[]
export interface UploadFields {
  [key: string]: UploadFieldValue
}

export interface UploadRecordingOptions<T = unknown> {
  /** axios-like client: `post(url, data, config)` resolving to `{ data }`. */
  http: HttpClient
  url: string
  uri: string
  mime?: string
  /** Extra multipart fields. Nested objects become `context[question_key]`. */
  fields?: UploadFields
  /** Multipart field name of the file. Default `audio`. */
  fieldName?: string
  fileName?: string
  /** Default 120 s: uploads from mobile networks are slow and the server may transcode. */
  timeoutMs?: number
  headers?: Record<string, string>
  /** Called by axios with upload progress events when supported. */
  onUploadProgress?: (event: { loaded: number; total?: number }) => void
  /** Transform the response; by default `response.data` is returned. */
  select?: (response: unknown) => T
}

/** Flatten nested fields into PHP/Laravel bracket notation. */
export function flattenFields(fields: UploadFields, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [key, value] of Object.entries(fields)) {
    const name = prefix ? `${prefix}[${key}]` : key
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item === null || item === undefined) return
        if (typeof item === 'object') out.push(...flattenFields(item as UploadFields, `${name}[${index}]`))
        else out.push([`${name}[${index}]`, String(item)])
      })
    } else if (typeof value === 'object') {
      out.push(...flattenFields(value, name))
    } else if (typeof value === 'boolean') {
      out.push([name, value ? '1' : '0'])
    } else {
      out.push([name, String(value)])
    }
  }
  return out
}

/**
 * Upload a native recording as multipart form data. The file goes under the
 * `audio` field as `{ uri, name, type }`, which React Native's networking turns
 * into a real file part.
 */
export async function uploadRecording<T = unknown>(options: UploadRecordingOptions<T>): Promise<T> {
  const {
    http,
    url,
    uri,
    mime = RECORDING_MIME,
    fields = {},
    fieldName = 'audio',
    fileName = 'recording.m4a',
    timeoutMs = 120000,
    headers,
    onUploadProgress,
    select,
  } = options

  const form = new FormData()
  // React Native's FormData accepts a file descriptor object; the DOM typing does not know it.
  form.append(fieldName, { uri, name: fileName, type: mime } as unknown as Blob)
  for (const [name, value] of flattenFields(fields)) form.append(name, value)

  const response = await http.post(url, form, {
    timeout: timeoutMs,
    headers: { Accept: 'application/json', 'Content-Type': 'multipart/form-data', ...headers },
    onUploadProgress,
  })
  if (select) return select(response)
  if (response && typeof response === 'object' && 'data' in response) return (response as { data: T }).data
  return response as T
}
