import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getActiveBaseUrlMock, getActiveAuthMock, isTauriMock } = vi.hoisted(() => ({
  getActiveBaseUrlMock: vi.fn(() => 'http://127.0.0.1:4096'),
  getActiveAuthMock: vi.fn(() => null),
  isTauriMock: vi.fn(() => false),
}))

vi.mock('../store/serverStore', () => ({
  makeBasicAuthHeader: vi.fn(() => 'Basic token'),
  serverStore: {
    getActiveBaseUrl: getActiveBaseUrlMock,
    getActiveAuth: getActiveAuthMock,
  },
}))

vi.mock('../utils/tauri', () => ({
  isTauri: isTauriMock,
}))

describe('sdk request lifecycle', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    getActiveBaseUrlMock.mockReturnValue('http://127.0.0.1:4096')
    getActiveAuthMock.mockReturnValue(null)
    isTauriMock.mockReturnValue(false)
    const { abortInFlightApiRequests, invalidateSDKClient } = await import('./sdk')
    abortInFlightApiRequests('reset test state')
    invalidateSDKClient()
  })

  it('aborts in-flight API requests when the server endpoint changes', async () => {
    const { abortInFlightApiRequests } = await import('./sdk')
    const { apiRequest } = await import('./httpClient')
    let signal: AbortSignal | undefined

    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
      })
    })

    const request = apiRequest('GET', '/project/current')
    abortInFlightApiRequests('Server endpoint changed')

    const result = await request
    expect(result.error).toBeTruthy()
    expect(signal?.aborted).toBe(true)
  })

  it('creates a pi client without OpenCode SDK', async () => {
    const { getSDKClient } = await import('./sdk')
    const client = getSDKClient()
    expect(client.session).toBeTruthy()
    expect(client.global.health).toBeTypeOf('function')
  })
})
