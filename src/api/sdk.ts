// ============================================
// Pi Bridge Client
// 替代 @opencode-ai/sdk，通过 HTTP 调用本地 pi-agent 后端
// 路径形状保持 OpenCode 兼容，便于复用现有 UI 逻辑
// ============================================

import { serverStore } from '../store/serverStore'
import { abortInFlightApiRequests, ensureHttpReady, http, type ApiResult } from './httpClient'

export { abortInFlightApiRequests }

export function unwrap<T>(result: ApiResult<T> | { data?: T; error?: unknown }): T {
  if (result.error != null) {
    const err = result.error
    if (err instanceof Error) throw err
    if (typeof err === 'string') throw new Error(err)
    throw new Error(JSON.stringify(err))
  }
  return result.data as T
}

type Q = Record<string, string | number | boolean | undefined>

function q(params?: object): Q {
  if (!params) return {}
  const out: Q = {}
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

/** Pi 后端客户端 — 方法面与旧 OpenCode SDK 大致对齐 */
export function createPiClient() {
  return {
    global: {
      health: () => http.get<{ healthy: boolean; version: string }>('/global/health'),
      dispose: () => http.post('/global/dispose'),
      config: {
        get: () => http.get('/global/config'),
        update: (body: { config: unknown }) => http.patch('/global/config', body.config ?? body),
      },
    },
    instance: {
      dispose: (params?: { directory?: string }) => http.post('/instance/dispose', undefined, q(params)),
    },
    path: {
      get: (params?: { directory?: string }) => http.get('/path', q(params)),
    },
    project: {
      current: (params?: { directory?: string }) => http.get('/project/current', q(params)),
      list: (params?: { directory?: string }) => http.get('/project', q(params)),
      initGit: (params?: { directory?: string }) => http.post('/project/init-git', undefined, q(params)),
      update: (params: { projectID: string; directory?: string; name?: string; icon?: unknown }) =>
        http.patch(`/project/${encodeURIComponent(params.projectID)}`, params, q({ directory: params.directory })),
    },
    config: {
      get: (params?: { directory?: string }) => http.get('/config', q(params)),
      update: (params: { directory?: string; config: unknown }) =>
        http.patch('/config', params.config, q({ directory: params.directory })),
      providers: (params?: { directory?: string }) => http.get('/config/providers', q(params)),
      refreshProviders: (params?: { directory?: string }) => http.post('/config/providers/refresh', {}, q(params)),
    },
    session: {
      list: (params?: { directory?: string; roots?: boolean; start?: number; search?: string; limit?: number }) =>
        http.get('/session', q(params)),
      get: (params: { sessionID: string; directory?: string }) =>
        http.get(`/session/${encodeURIComponent(params.sessionID)}`, q({ directory: params.directory })),
      create: (params?: { directory?: string; title?: string; parentID?: string }) =>
        http.post('/session', params ?? {}, q({ directory: params?.directory })),
      update: (params: { sessionID: string; directory?: string; title?: string; time?: { archived?: number } }) =>
        http.patch(`/session/${encodeURIComponent(params.sessionID)}`, params, q({ directory: params.directory })),
      delete: (params: { sessionID: string; directory?: string }) =>
        http.delete(`/session/${encodeURIComponent(params.sessionID)}`, q({ directory: params.directory })),
      status: (params?: { directory?: string }) => http.get('/session/status', q(params)),
      diff: (params: { sessionID: string; directory?: string; messageID?: string }) =>
        http.get(`/session/${encodeURIComponent(params.sessionID)}/diff`, q(params)),
      abort: (params: { sessionID: string; directory?: string }) =>
        http.post(`/session/${encodeURIComponent(params.sessionID)}/abort`, undefined, q({ directory: params.directory })),
      revert: (params: {
        sessionID: string
        directory?: string
        messageID: string
        partID?: string
      }) => http.post(`/session/${encodeURIComponent(params.sessionID)}/revert`, params, q({ directory: params.directory })),
      unrevert: (params: { sessionID: string; directory?: string }) =>
        http.post(`/session/${encodeURIComponent(params.sessionID)}/unrevert`, undefined, q({ directory: params.directory })),
      share: (params: { sessionID: string; directory?: string }) =>
        http.post(`/session/${encodeURIComponent(params.sessionID)}/share`, undefined, q({ directory: params.directory })),
      unshare: (params: { sessionID: string; directory?: string }) =>
        http.delete(`/session/${encodeURIComponent(params.sessionID)}/share`, q({ directory: params.directory })),
      fork: (params: { sessionID: string; directory?: string; messageID?: string }) =>
        http.post(`/session/${encodeURIComponent(params.sessionID)}/fork`, params, q({ directory: params.directory })),
      summarize: (params: {
        sessionID: string
        directory?: string
        providerID: string
        modelID: string
        auto?: boolean
      }) => http.post(`/session/${encodeURIComponent(params.sessionID)}/summarize`, params, q({ directory: params.directory })),
      children: (params: { sessionID: string; directory?: string }) =>
        http.get(`/session/${encodeURIComponent(params.sessionID)}/children`, q({ directory: params.directory })),
      todo: (params: { sessionID: string; directory?: string }) =>
        http.get(`/session/${encodeURIComponent(params.sessionID)}/todo`, q({ directory: params.directory })),
      stats: (params: { sessionID: string; directory?: string }) =>
        http.get(`/session/${encodeURIComponent(params.sessionID)}/stats`, q({ directory: params.directory })),
      messages: (params: { sessionID: string; directory?: string; limit?: number }) =>
        http.get(`/session/${encodeURIComponent(params.sessionID)}/message`, q(params)),
      prompt: (params: Record<string, unknown>) =>
        http.post(`/session/${encodeURIComponent(String(params.sessionID))}/message`, params, q({ directory: params.directory as string | undefined })),
      promptAsync: (params: Record<string, unknown>) =>
        http.post(
          `/session/${encodeURIComponent(String(params.sessionID))}/prompt_async`,
          params,
          q({ directory: params.directory as string | undefined }),
        ),
      command: (params: Record<string, unknown>) =>
        http.post(
          `/session/${encodeURIComponent(String(params.sessionID))}/command`,
          params,
          q({ directory: params.directory as string | undefined }),
        ),
    },
    file: {
      list: (params: { path?: string; directory?: string }) => http.get('/file', q(params)),
      read: (params: { path: string; directory?: string }) => http.get('/file/content', q(params)),
      status: (params?: { directory?: string }) => http.get('/file/status', q(params)),
    },
    find: {
      files: (params: { query: string; directory?: string; type?: string; limit?: number }) =>
        http.get('/find/file', q(params)),
      symbols: (params: { query: string; directory?: string }) => http.get('/find/symbol', q(params)),
      text: (params: { pattern: string; directory?: string }) => http.get('/find', q(params)),
    },
    permission: {
      list: (params?: { directory?: string }) => http.get('/permission', q(params)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      respond: (params: any) =>
        http.post(`/permission/${encodeURIComponent(params.requestID)}/reply`, params, q({ directory: params.directory })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reply: (params: any) =>
        http.post(`/permission/${encodeURIComponent(params.requestID)}/reply`, params, q({ directory: params.directory })),
    },
    question: {
      list: (params?: { directory?: string }) => http.get('/question', q(params)),
      reply: (params: { requestID: string; answers?: unknown; directory?: string }) =>
        http.post(`/question/${encodeURIComponent(params.requestID)}/reply`, params, q({ directory: params.directory })),
      reject: (params: { requestID: string; directory?: string }) =>
        http.post(`/question/${encodeURIComponent(params.requestID)}/reject`, undefined, q({ directory: params.directory })),
    },
    agent: {
      list: (params?: { directory?: string }) => http.get('/agent', q(params)),
    },
    app: {
      skills: (params?: { directory?: string }) => http.get('/skill', q(params)),
      agents: (params?: { directory?: string }) => http.get('/agent', q(params)),
    },
    command: {
      list: (params?: { directory?: string }) => http.get('/command', q(params)),
    },
    mcp: {
      status: (params?: { directory?: string }) => http.get('/mcp', q(params)),
      add: (params: { name: string; config: unknown; directory?: string }) =>
        http.post('/mcp', params, q({ directory: params.directory })),
      connect: (params: { name: string; directory?: string }) =>
        http.post(`/mcp/${encodeURIComponent(params.name)}/connect`, undefined, q({ directory: params.directory })),
      disconnect: (params: { name: string; directory?: string }) =>
        http.post(`/mcp/${encodeURIComponent(params.name)}/disconnect`, undefined, q({ directory: params.directory })),
      auth: Object.assign(
        (params: { name: string; directory?: string }) =>
          http.post(`/mcp/${encodeURIComponent(params.name)}/auth`, undefined, q({ directory: params.directory })),
        {
          start: (params: { name: string; directory?: string }) =>
            http.post(`/mcp/${encodeURIComponent(params.name)}/auth`, undefined, q({ directory: params.directory })),
          remove: (params: { name: string; directory?: string }) =>
            http.delete(`/mcp/${encodeURIComponent(params.name)}/auth`, q({ directory: params.directory })),
          callback: (params: { name: string; code?: string; directory?: string }) =>
            http.post(
              `/mcp/${encodeURIComponent(params.name)}/auth/callback`,
              params,
              q({ directory: params.directory }),
            ),
          authenticate: (params: { name: string; directory?: string }) =>
            http.post(
              `/mcp/${encodeURIComponent(params.name)}/auth/authenticate`,
              undefined,
              q({ directory: params.directory }),
            ),
        },
      ),
    },
    experimental: {
      resource: {
        list: (params?: { directory?: string }) => http.get('/experimental/resource', q(params)),
      },
    },
    pty: {
      list: (params?: { directory?: string }) => http.get('/pty', q(params)),
      get: (params: { ptyID: string; directory?: string }) =>
        http.get(`/pty/${encodeURIComponent(params.ptyID)}`, q({ directory: params.directory })),
      create: (params: Record<string, unknown>) => http.post('/pty', params, q({ directory: params.directory as string | undefined })),
      update: (params: { ptyID: string; directory?: string } & Record<string, unknown>) =>
        http.put(`/pty/${encodeURIComponent(params.ptyID)}`, params, q({ directory: params.directory })),
      remove: (params: { ptyID: string; directory?: string }) =>
        http.delete(`/pty/${encodeURIComponent(params.ptyID)}`, q({ directory: params.directory })),
      shells: (params?: { directory?: string }) => http.get('/pty/shells', q(params)),
    },
    vcs: {
      get: (params?: { directory?: string }) => http.get('/vcs', q(params)),
      diff: (params?: { mode?: string; directory?: string }) => http.get('/vcs/diff', q(params)),
    },
    worktree: {
      list: (params?: { directory?: string }) => http.get('/experimental/worktree', q(params)),
      create: (params: Record<string, unknown>) =>
        http.post('/experimental/worktree', params, q({ directory: params.directory as string | undefined })),
      remove: (params: Record<string, unknown>) =>
        http.delete('/experimental/worktree', q(params as Q)),
      reset: (params?: Record<string, unknown>) => http.post('/experimental/worktree/reset', params ?? {}),
    },
    lsp: {
      status: (params?: { directory?: string }) => http.get('/lsp', q(params)),
    },
    tool: {
      ids: (params?: { directory?: string }) => http.get('/experimental/tool/ids', q(params)),
      list: (params?: { directory?: string; provider?: string; model?: string }) =>
        http.get('/experimental/tool', q(params)),
    },
  }
}

export type PiClient = ReturnType<typeof createPiClient>

let _cachedClient: PiClient | null = null
let _cachedKey = ''

function buildCacheKey(): string {
  const baseUrl = serverStore.getActiveBaseUrl()
  const auth = serverStore.getActiveAuth()
  const authPart = auth?.password ? `${auth.username}:${auth.password}` : ''
  return `${baseUrl}|${authPart}`
}

export function getSDKClient(): PiClient {
  const key = buildCacheKey()
  if (_cachedClient && _cachedKey === key) return _cachedClient
  _cachedClient = createPiClient()
  _cachedKey = key
  return _cachedClient
}

export async function getSDKClientAsync(): Promise<PiClient> {
  await ensureHttpReady()
  _cachedClient = null
  _cachedKey = ''
  return getSDKClient()
}

export function invalidateSDKClient(): void {
  _cachedClient = null
  _cachedKey = ''
}
