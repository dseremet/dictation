import type { HttpAdapter, HttpRequestOptions, HttpResponse } from './types'

interface AxiosLike {
  post(url: string, data?: unknown, config?: { headers?: Record<string, string> }): Promise<{ data: unknown }>
  get(url: string, config?: { headers?: Record<string, string> }): Promise<{ data: unknown }>
  patch(url: string, data?: unknown, config?: { headers?: Record<string, string> }): Promise<{ data: unknown }>
  delete(url: string, config?: { headers?: Record<string, string> }): Promise<{ data: unknown }>
}

/** Wrap an axios instance (or the default export) as an `HttpAdapter`. */
export function axiosAdapter(axios: AxiosLike): HttpAdapter {
  return {
    post: (url, body, options) => axios.post(url, body ?? undefined, { headers: options?.headers }) as Promise<HttpResponse<never>>,
    get: (url, options) => axios.get(url, { headers: options?.headers }) as Promise<HttpResponse<never>>,
    patch: (url, body, options) => axios.patch(url, body, { headers: options?.headers }) as Promise<HttpResponse<never>>,
    delete: (url, options) => axios.delete(url, { headers: options?.headers }) as Promise<HttpResponse<never>>,
  }
}

export interface FetchAdapterOptions {
  /** Sent as `X-CSRF-TOKEN` (Laravel web routes). A function is re-read per request. */
  csrfToken?: string | (() => string | null | undefined)
  credentials?: RequestCredentials
  headers?: Record<string, string>
  fetch?: typeof fetch
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public data: unknown,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`)
    this.name = 'HttpError'
  }
}

/** `fetch`-based adapter for apps that do not use axios. */
export function fetchAdapter(options: FetchAdapterOptions = {}): HttpAdapter {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

  async function request<T>(method: string, url: string, body?: unknown, extra?: HttpRequestOptions): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(options.headers ?? {}),
      ...(extra?.headers ?? {}),
    }
    const token = typeof options.csrfToken === 'function' ? options.csrfToken() : options.csrfToken
    if (token) headers['X-CSRF-TOKEN'] = token

    let payload: BodyInit | undefined
    if (body instanceof FormData) {
      payload = body
      delete headers['Content-Type']
      delete headers['content-type']
    } else if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }

    const response = await doFetch(url, {
      method,
      headers,
      body: payload,
      credentials: options.credentials ?? 'same-origin',
    })

    let data: unknown = null
    const type = response.headers.get('content-type') ?? ''
    if (response.status !== 204) {
      if (type.includes('json')) {
        data = await response.json().catch(() => null)
      } else {
        const text = await response.text().catch(() => '')
        data = text || null
      }
    }
    if (!response.ok) {
      const message = (data as { message?: string } | null)?.message
      throw new HttpError(response.status, data, message)
    }
    return { data: data as T }
  }

  return {
    post: (url, body, o) => request('POST', url, body, o),
    get: (url, o) => request('GET', url, undefined, o),
    patch: (url, body, o) => request('PATCH', url, body, o),
    delete: (url, o) => request('DELETE', url, undefined, o),
  }
}

/** Accept both `{ data: { uuid } }` (Laravel resource) and a bare object. */
export function unwrapRecording<T extends { uuid?: unknown }>(payload: unknown): T | null {
  if (!payload || typeof payload !== 'object') return null
  const obj = payload as Record<string, unknown>
  if (typeof obj.uuid === 'string') return obj as T
  const inner = obj.data
  if (inner && typeof inner === 'object' && typeof (inner as Record<string, unknown>).uuid === 'string') return inner as T
  return null
}

/** Best-effort message from an adapter error (axios, fetch, plain). */
export function describeError(error: unknown, fallback = 'Request failed'): string {
  if (!error) return fallback
  if (typeof error === 'string') return error
  const e = error as { response?: { data?: { message?: string } }; data?: { message?: string }; message?: string }
  return e.response?.data?.message || e.data?.message || e.message || fallback
}
