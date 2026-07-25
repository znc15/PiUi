// ============================================
// Low-level HTTP helpers for Pi bridge backend
// ============================================

import { serverStore, makeBasicAuthHeader } from '../store/serverStore'
import { isTauri } from '../utils/tauri'
import { buildQueryString } from './http'

let _tauriFetch: typeof globalThis.fetch | null = null
let _tauriFetchLoading: Promise<typeof globalThis.fetch> | null = null
let _apiRequestGeneration = 0
const _apiRequestControllers = new Set<AbortController>()

async function getTauriFetch(): Promise<typeof globalThis.fetch> {
  if (_tauriFetch) return _tauriFetch
  if (_tauriFetchLoading) return _tauriFetchLoading
  _tauriFetchLoading = import('@tauri-apps/plugin-http').then(mod => {
    _tauriFetch = mod.fetch as unknown as typeof globalThis.fetch
    return _tauriFetch
  })
  return _tauriFetchLoading
}

function getFetchImpl(): typeof globalThis.fetch {
  return isTauri() && _tauriFetch ? _tauriFetch : globalThis.fetch
}

function createAbortError(message: string) {
  return new DOMException(message, 'AbortError')
}

function buildHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra)
  if (!headers.has('Content-Type')) {
    // only set JSON content-type when body is present (caller decides)
  }
  const auth = serverStore.getActiveAuth()
  if (auth?.password && !headers.has('Authorization')) {
    headers.set('Authorization', makeBasicAuthHeader(auth))
  }
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  return headers
}

async function trackedFetch(input: RequestInfo | URL, init: RequestInit | undefined, generation: number): Promise<Response> {
  const controller = new AbortController()
  const externalSignal = init?.signal
  const abortFromExternal = () => controller.abort(externalSignal?.reason)

  if (externalSignal?.aborted) {
    abortFromExternal()
  } else {
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  }

  _apiRequestControllers.add(controller)

  try {
    if (generation !== _apiRequestGeneration) {
      throw createAbortError('Stale API request')
    }

    return await getFetchImpl()(input, {
      ...init,
      signal: controller.signal,
    })
  } finally {
    externalSignal?.removeEventListener('abort', abortFromExternal)
    _apiRequestControllers.delete(controller)
  }
}

export function abortInFlightApiRequests(reason = 'Server endpoint changed'): void {
  _apiRequestGeneration++
  for (const controller of _apiRequestControllers) {
    controller.abort(createAbortError(reason))
  }
  _apiRequestControllers.clear()
}

export async function ensureHttpReady(): Promise<void> {
  if (isTauri()) await getTauriFetch()
}

export type ApiResult<T> = { data?: T; error?: unknown; response?: Response }

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

// Default to any so call sites keep OpenCode-era typing without fighting every endpoint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiRequest<T = any>(
  method: string,
  path: string,
  options: {
    query?: Record<string, string | number | boolean | undefined>
    body?: unknown
    headers?: HeadersInit
    signal?: AbortSignal
  } = {},
): Promise<ApiResult<T>> {
  const baseUrl = serverStore.getActiveBaseUrl()
  const url = joinUrl(baseUrl, path) + buildQueryString(options.query ?? {})
  const generation = _apiRequestGeneration
  const headers = buildHeaders(options.headers)

  let body: BodyInit | undefined
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(options.body)
  }

  try {
    const response = await trackedFetch(
      url,
      {
        method,
        headers,
        body,
        signal: options.signal,
      },
      generation,
    )

    if (response.status === 204) {
      return { data: undefined as T, response }
    }

    const text = await response.text()
    let parsed: unknown = undefined
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }

    if (!response.ok) {
      const err =
        parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
          ? (parsed as { error: unknown }).error
          : parsed || `HTTP ${response.status}`
      return { error: err, response }
    }

    return { data: parsed as T, response }
  } catch (error) {
    return { error }
  }
}

export const http = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get: <T = any>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
    apiRequest<T>('GET', path, { query }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  post: <T = any>(path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>) =>
    apiRequest<T>('POST', path, { body, query }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  put: <T = any>(path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>) =>
    apiRequest<T>('PUT', path, { body, query }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patch: <T = any>(path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>) =>
    apiRequest<T>('PATCH', path, { body, query }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete: <T = any>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
    apiRequest<T>('DELETE', path, { query }),
}
