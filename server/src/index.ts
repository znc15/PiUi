import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import type { Server as HttpServer } from 'node:http'
import { setDefaultDirectory, subscribe, type GlobalEvent } from './events.js'
import * as hub from './session-hub.js'
import * as fsApi from './fs-api.js'
import * as ptyHub from './pty-hub.js'
import * as mcpHub from './mcp-hub.js'
import * as piConfig from './pi-config.js'
import * as permHub from './permission-hub.js'
import * as skillsHub from './skills-hub.js'
import * as symbolSearch from './symbol-search.js'
import * as worktreeHub from './worktree-hub.js'
import * as lspHub from './lsp-hub.js'
import { getPiStatus } from './pi-status.js'

const VERSION = '0.1.0-pi'

// 将打包进 bridge 的 SDK 暴露到 globalThis：
// 单文件 bundle 内 jiti 的 '@earendil-works/pi-coding-agent' 别名指向
// <bundle>/../../index.js（见 src-tauri/index.js 桥接文件），
// 使 pi 扩展（pi-ask / pi-subagents 等）与 bridge 使用同一份 SDK。
import * as piSdk from '@earendil-works/pi-coding-agent'
;(globalThis as Record<string, unknown>).__PI_SDK__ = piSdk
const PORT = Number(process.env.PORT || process.env.PI_PORT || 4096)
const HOST = process.env.HOST || '127.0.0.1'

const app = new Hono()

app.use(
  '*',
  cors({
    origin: origin => origin || '*',
    allowHeaders: ['Content-Type', 'Authorization', 'x-opencode-directory', 'x-directory'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  }),
)

function directoryFrom(
  c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } },
  body?: { directory?: string },
) {
  return (
    body?.directory ||
    c.req.query('directory') ||
    c.req.header('x-opencode-directory') ||
    c.req.header('x-directory') ||
    hub.getDefaultWorkspace()
  )
}

function err(c: { json: (b: unknown, s?: number) => Response }, e: unknown) {
  const status = typeof e === 'object' && e && 'status' in e ? Number((e as { status: number }).status) : 500
  const message = e instanceof Error ? e.message : String(e)
  return c.json({ error: message }, status)
}

setDefaultDirectory(hub.getDefaultWorkspace())

async function sseHandler(c: Context) {
  const requestedDirectory = c.req.query('directory')
  const directory = requestedDirectory || hub.getDefaultWorkspace()
  return streamSSE(c, async stream => {
    let closed = false
    const send = async (event: GlobalEvent) => {
      if (closed) return
      // No query means a true global stream. This is required for new sessions,
      // worktrees, and split panes whose directories can change after connect.
      if (
        requestedDirectory &&
        event.directory &&
        event.directory !== requestedDirectory &&
        event.payload.type !== 'server.connected'
      ) {
        return
      }
      await stream.writeSSE({ data: JSON.stringify(event) })
    }

    await send({
      directory,
      payload: { type: 'server.connected', properties: { timestamp: Date.now() } },
    })

    const unsub = subscribe(event => {
      void send(event)
    })

    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: String(Date.now()) })
    }, 15000)

    stream.onAbort(() => {
      closed = true
      clearInterval(heartbeat)
      unsub()
    })

    // keep alive until aborted
    await new Promise<void>(resolve => {
      stream.onAbort(() => resolve())
    })
  })
}

// ---- Health / global ----
app.get('/global/health', async c => c.json({ healthy: true, version: VERSION, pi: await getPiStatus(VERSION) }))
app.get('/global/pi-status', async c => {
  try {
    return c.json(await getPiStatus(VERSION))
  } catch (e) {
    return err(c, e)
  }
})
app.post('/global/dispose', async c => {
  await hub.disposeAll()
  await mcpHub.dispose()
  return c.json(true)
})
app.get('/global/config', async c => {
  try {
    return c.json(await piConfig.getGlobalConfig())
  } catch (e) {
    return err(c, e)
  }
})
app.patch('/global/config', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const patch = body && typeof body === 'object' && 'config' in body ? (body as { config: Record<string, unknown> }).config : body
    // Support full replace when client sends { replace: true, config }
    if (body && typeof body === 'object' && (body as { replace?: boolean }).replace) {
      const result = await piConfig.replaceGlobalConfig((patch || {}) as Record<string, unknown>)
      skillsHub.invalidateCaches()
      return c.json(result)
    }
    const result = await piConfig.updateGlobalConfig((patch || {}) as Record<string, unknown>)
    skillsHub.invalidateCaches()
    return c.json(result)
  } catch (e) {
    return err(c, e)
  }
})
app.get('/global/config/paths', c => c.json(piConfig.getConfigPaths(directoryFrom(c))))
app.post('/instance/dispose', c => c.json(true))
app.get('/global/event', sseHandler)
app.get('/event', sseHandler)

// ---- Path / project ----
app.get('/path', c => c.json(hub.getPathInfo(directoryFrom(c))))
app.get('/project/current', c => c.json(hub.getCurrentProject(directoryFrom(c))))
app.get('/project', c => c.json([hub.getCurrentProject(directoryFrom(c))]))
app.post('/project/init-git', async c => {
  const dir = directoryFrom(c)
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)('git', ['init'], { cwd: dir })
  } catch {
    // ignore
  }
  return c.json(hub.getCurrentProject(dir))
})
app.patch('/project/:projectID', async c => {
  const body = await c.req.json().catch(() => ({}))
  const project = hub.getCurrentProject(directoryFrom(c, body))
  return c.json({ ...project, ...body })
})

// ---- Config / providers ----
app.get('/config', async c => {
  try {
    const directory = directoryFrom(c)
    const effective = await piConfig.getEffectiveConfig(directory)
    return c.json({
      ...effective,
      model: effective.defaultModel || '',
      username: 'pi',
      _paths: piConfig.getConfigPaths(directory),
    })
  } catch (e) {
    return err(c, e)
  }
})
app.patch('/config', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const directory = directoryFrom(c, body)
    const patch = body && typeof body === 'object' && 'config' in body ? (body as { config: Record<string, unknown> }).config : body
    // Project-scoped write when directory provided; otherwise global
    if (c.req.query('directory') || body?.directory) {
      const result = await piConfig.updateProjectConfig((patch || {}) as Record<string, unknown>, directory)
      skillsHub.invalidateCaches()
      return c.json(result)
    }
    const result = await piConfig.updateGlobalConfig((patch || {}) as Record<string, unknown>)
    skillsHub.invalidateCaches()
    return c.json(result)
  } catch (e) {
    return err(c, e)
  }
})
app.get('/mcp/config', async c => {
  try {
    return c.json(await piConfig.getMcpConfig())
  } catch (e) {
    return err(c, e)
  }
})
app.put('/mcp/config', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    return c.json(await piConfig.updateMcpConfig((body || {}) as Record<string, unknown>))
  } catch (e) {
    return err(c, e)
  }
})
app.get('/config/providers', async c => c.json(await hub.listProviders()))
app.post('/config/providers/refresh', async c => {
  try {
    return c.json(await hub.listProviders({ refresh: true }))
  } catch (e) {
    return err(c, e)
  }
})
app.get('/provider', async c => c.json(await hub.listProviders()))

// ---- Session ----
app.get('/session', async c => {
  try {
    return c.json(
      await hub.listSessions({
        directory: directoryFrom(c),
        search: c.req.query('search'),
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      }),
    )
  } catch (e) {
    return err(c, e)
  }
})

app.get('/session/status', c => c.json(hub.getStatusMap(directoryFrom(c))))

app.post('/session', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    return c.json(
      await hub.createSession({
        directory: directoryFrom(c, body),
        title: body.title,
        parentID: body.parentID,
      }),
    )
  } catch (e) {
    return err(c, e)
  }
})

app.get('/session/:sessionID', async c => {
  try {
    return c.json(await hub.getSession(c.req.param('sessionID'), directoryFrom(c)))
  } catch (e) {
    return err(c, e)
  }
})

app.patch('/session/:sessionID', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    return c.json(await hub.updateSession(c.req.param('sessionID'), body, directoryFrom(c, body)))
  } catch (e) {
    return err(c, e)
  }
})

app.delete('/session/:sessionID', async c => {
  try {
    return c.json(await hub.deleteSession(c.req.param('sessionID'), directoryFrom(c)))
  } catch (e) {
    return err(c, e)
  }
})

app.get('/session/:sessionID/message', async c => {
  try {
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined
    return c.json(await hub.getMessages(c.req.param('sessionID'), directoryFrom(c), limit))
  } catch (e) {
    return err(c, e)
  }
})

app.post('/session/:sessionID/message', async c => {
  try {
    const body = await c.req.json()
    return c.json(await hub.promptSync(c.req.param('sessionID'), { ...body, directory: directoryFrom(c, body) }))
  } catch (e) {
    return err(c, e)
  }
})

app.post('/session/:sessionID/prompt_async', async c => {
  try {
    const body = await c.req.json()
    await hub.promptAsync(c.req.param('sessionID'), { ...body, directory: directoryFrom(c, body) })
    return c.json(true)
  } catch (e) {
    return err(c, e)
  }
})

app.post('/session/:sessionID/abort', async c => {
  try {
    return c.json(await hub.abortSession(c.req.param('sessionID'), directoryFrom(c)))
  } catch (e) {
    return err(c, e)
  }
})

app.get('/session/:sessionID/diff', async c => {
  try {
    return c.json(await fsApi.getVcsDiff(directoryFrom(c)))
  } catch (e) {
    return err(c, e)
  }
})

app.get('/session/:sessionID/stats', async c => {
  try {
    // Ensure the session is loaded (from memory or disk)
    await hub.getLiveSession(c.req.param('sessionID'), directoryFrom(c))
    return c.json(hub.getSessionUsageStats(c.req.param('sessionID')))
  } catch (e) {
    return err(c, e)
  }
})

app.get('/session/:sessionID/todo', async c => c.json(hub.getTodos(c.req.param('sessionID'))))
app.get('/session/:sessionID/children', async c => c.json([]))
app.post('/session/:sessionID/summarize', async c => {
  try {
    return c.json(await hub.summarizeSession(c.req.param('sessionID'), directoryFrom(c)))
  } catch (e) {
    return err(c, e)
  }
})
app.post('/session/:sessionID/fork', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    return c.json(await hub.forkSession(c.req.param('sessionID'), body.messageID, directoryFrom(c, body)))
  } catch (e) {
    return err(c, e)
  }
})
app.post('/session/:sessionID/revert', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const session = await hub.getSession(c.req.param('sessionID'), directoryFrom(c, body))
    return c.json({ ...session, revert: { messageID: body.messageID, partID: body.partID } })
  } catch (e) {
    return err(c, e)
  }
})
app.post('/session/:sessionID/unrevert', async c => {
  try {
    return c.json(await hub.getSession(c.req.param('sessionID'), directoryFrom(c)))
  } catch (e) {
    return err(c, e)
  }
})
app.post('/session/:sessionID/share', async c => c.json(await hub.getSession(c.req.param('sessionID'), directoryFrom(c))))
app.delete('/session/:sessionID/share', async c =>
  c.json(await hub.getSession(c.req.param('sessionID'), directoryFrom(c))),
)
app.post('/session/:sessionID/command', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const text = body.command ? `/${body.command}${body.arguments ? ' ' + body.arguments : ''}` : body.message || ''
    await hub.promptAsync(c.req.param('sessionID'), {
      parts: [{ type: 'text', text }],
      directory: directoryFrom(c, body),
    })
    return c.json(true)
  } catch (e) {
    return err(c, e)
  }
})

// ---- Files ----
app.get('/file', async c => {
  try {
    return c.json(await fsApi.listDirectory(directoryFrom(c), c.req.query('path') || '.'))
  } catch (e) {
    return err(c, e)
  }
})
app.get('/file/content', async c => {
  try {
    const p = c.req.query('path')
    if (!p) return c.json({ error: 'path required' }, 400)
    return c.json(await fsApi.readFileContent(directoryFrom(c), p))
  } catch (e) {
    return err(c, e)
  }
})
app.get('/file/status', async c => c.json(await fsApi.fileStatus(directoryFrom(c))))
app.get('/find/file', async c => {
  const q = c.req.query('query') || ''
  const type = c.req.query('type')
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 50
  return c.json(await fsApi.findFiles(directoryFrom(c), q, type, limit))
})
app.get('/find/symbol', async c => {
  try {
    const query = c.req.query('query') || ''
    return c.json(symbolSearch.searchSymbols(query, directoryFrom(c)))
  } catch (e) {
    return err(c, e)
  }
})
app.get('/find', async c => c.json(await fsApi.findText(directoryFrom(c), c.req.query('pattern') || '')))

// ---- Agents / skills / commands / tools ----
app.get('/agent', c =>
  c.json([
    {
      name: 'pi',
      description: 'Pi coding agent',
      mode: 'primary',
      native: true,
      permission: [],
      options: {},
    },
  ]),
)
app.get('/skill', c => {
  const dir = directoryFrom(c)
  const refresh = c.req.query('refresh') === '1'
  return c.json(refresh ? skillsHub.refreshSkills(dir) : skillsHub.loadSkillsForDirectory(dir))
})
app.get('/command', c => c.json(skillsHub.getCommands(directoryFrom(c))))
app.get('/experimental/tool/ids', c => c.json(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']))
app.get('/experimental/tool', c =>
  c.json([
    { id: 'read', description: 'Read files' },
    { id: 'bash', description: 'Run shell commands' },
    { id: 'edit', description: 'Edit files' },
    { id: 'write', description: 'Write files' },
  ]),
)

// ---- Permission / question ----
app.get('/permission', c => {
  const sessionID = c.req.query('sessionID')
  const directory = c.req.query('directory')
  return c.json(permHub.getPendingPermissions(sessionID || undefined, directory || undefined))
})
app.post('/permission/:requestID/reply', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const reply = (body.reply || body.response || 'once') as permHub.PermissionReply
    const ok = permHub.replyPermission(c.req.param('requestID'), reply)
    if (!ok) return c.json({ error: 'Permission request not found or already resolved' }, 404)
    return c.json(true)
  } catch (e) {
    return err(c, e)
  }
})
app.get('/question', c => {
  const sessionID = c.req.query('sessionID')
  const directory = c.req.query('directory')
  return c.json(permHub.getPendingQuestions(sessionID || undefined, directory || undefined))
})
app.post('/question/:requestID/reply', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const ok = permHub.replyQuestion(c.req.param('requestID'), body.answers)
    if (!ok) return c.json({ error: 'Question request not found or already resolved' }, 404)
    return c.json(true)
  } catch (e) {
    return err(c, e)
  }
})
app.post('/question/:requestID/reject', c => {
  const ok = permHub.rejectQuestion(c.req.param('requestID'))
  if (!ok) return c.json({ error: 'Question request not found or already resolved' }, 404)
  return c.json(true)
})

// ---- MCP runtime ----
app.get('/mcp', async c => {
  try {
    return c.json(await mcpHub.getStatus())
  } catch (e) {
    return err(c, e)
  }
})
app.post('/mcp', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const { name, ...config } = body as { name?: string; [key: string]: unknown }
    if (!name || typeof name !== 'string') return c.json({ error: 'name required' }, 400)
    const status = await mcpHub.addServer(name, config as mcpHub.PiMcpServerEntry, body.autoConnect !== false)
    return c.json({ name, status })
  } catch (e) {
    return err(c, e)
  }
})
app.post('/mcp/:name/connect', async c => {
  try {
    const status = await mcpHub.connectServer(c.req.param('name'))
    return c.json(status)
  } catch (e) {
    return err(c, e)
  }
})
app.post('/mcp/:name/disconnect', async c => {
  try {
    return c.json(await mcpHub.disconnectServer(c.req.param('name')))
  } catch (e) {
    return err(c, e)
  }
})
app.post('/mcp/:name/auth', c => c.json({ authorizationUrl: '' }))
app.post('/mcp/:name/auth/callback', c => c.json(true))
app.post('/mcp/:name/auth/authenticate', c => c.json(true))
app.delete('/mcp/:name/auth', c => c.json(true))
app.get('/experimental/resource', async c => {
  try {
    return c.json(await mcpHub.getResources())
  } catch (e) {
    return err(c, e)
  }
})
app.get('/lsp', async c => {
  try {
    return c.json(await lspHub.getLspStatus(directoryFrom(c)))
  } catch (e) {
    return err(c, e)
  }
})
app.get('/experimental/worktree', async c => {
  try {
    return c.json(await worktreeHub.listWorktrees(directoryFrom(c)))
  } catch (e) {
    return err(c, e)
  }
})
app.post('/experimental/worktree', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const name = (body as { name?: string }).name
    if (!name) return c.json({ error: 'name required' }, 400)
    return c.json(await worktreeHub.createWorktree(name, directoryFrom(c, body)))
  } catch (e) {
    return err(c, e)
  }
})
app.delete('/experimental/worktree', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const dir = (body as { directory?: string }).directory
    if (!dir) return c.json({ error: 'directory required' }, 400)
    return c.json(await worktreeHub.removeWorktree(dir, directoryFrom(c)))
  } catch (e) {
    return err(c, e)
  }
})
app.post('/experimental/worktree/reset', async c => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const dir = (body as { directory?: string }).directory
    if (!dir) return c.json({ error: 'directory required' }, 400)
    return c.json(await worktreeHub.resetWorktree(dir, directoryFrom(c)))
  } catch (e) {
    return err(c, e)
  }
})

// ---- VCS ----
app.get('/vcs', async c => c.json(await fsApi.getVcsInfo(directoryFrom(c))))
app.get('/vcs/diff', async c => c.json(await fsApi.getVcsDiff(directoryFrom(c))))

// ---- PTY ----
app.get('/pty', c => c.json(ptyHub.listPtys()))
app.get('/pty/shells', c => {
  const shell = process.env.SHELL || '/bin/zsh'
  return c.json([
    { path: shell, name: shell.split('/').pop() || shell, acceptable: true },
    { path: '/bin/bash', name: 'bash', acceptable: true },
    { path: '/bin/zsh', name: 'zsh', acceptable: true },
    { path: '/bin/sh', name: 'sh', acceptable: true },
  ])
})
app.post('/pty', async c => {
  const body = await c.req.json().catch(() => ({}))
  return c.json(await ptyHub.createPty({ ...body, cwd: body.cwd || directoryFrom(c, body) }))
})
app.get('/pty/:ptyID', c => {
  const info = ptyHub.getPty(c.req.param('ptyID'))
  if (!info) return c.json({ error: 'not found' }, 404)
  return c.json(info)
})
app.put('/pty/:ptyID', async c => {
  const body = await c.req.json().catch(() => ({}))
  const info = ptyHub.updatePty(c.req.param('ptyID'), body)
  if (!info) return c.json({ error: 'not found' }, 404)
  return c.json(info)
})
app.delete('/pty/:ptyID', c => c.json(ptyHub.removePty(c.req.param('ptyID'))))

// ---- TUI no-ops ----
for (const p of [
  '/tui/append-prompt',
  '/tui/clear-prompt',
  '/tui/execute-command',
  '/tui/open-help',
  '/tui/open-models',
  '/tui/open-sessions',
  '/tui/open-themes',
  '/tui/publish',
  '/tui/select-session',
  '/tui/show-toast',
  '/tui/submit-prompt',
]) {
  app.post(p, c => c.json(true))
}
app.get('/tui/control/next', c => c.json(null))
app.post('/tui/control/response', c => c.json(true))

app.notFound(c => c.json({ error: `Not found: ${c.req.method} ${c.req.path}` }, 404))

const server = serve({
  fetch: app.fetch,
  hostname: HOST,
  port: PORT,
}) as unknown as HttpServer

console.log(`[pi-bridge] listening on http://${HOST}:${PORT}`)
console.log(`[pi-bridge] workspace: ${hub.getDefaultWorkspace()}`)

// Auto-connect MCP servers on startup
mcpHub.connectAll().catch(err => {
  console.warn('[pi-bridge] MCP auto-connect failed:', err)
})

// PTY websocket upgrade
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const match = url.pathname.match(/^\/pty\/([^/]+)\/connect$/)
  if (!match) {
    socket.destroy()
    return
  }
  const ptyID = decodeURIComponent(match[1])
  const proc = ptyHub.getPtyProc(ptyID)
  import('ws')
    .then(({ WebSocketServer }) => {
      const wss = new WebSocketServer({ noServer: true })
      wss.handleUpgrade(req, socket, head, ws => {
        if (!proc) {
          ws.close()
          return
        }
        const p = proc as {
          onData: (cb: (d: string) => void) => void
          write: (d: string) => void
          onExit: (cb: () => void) => void
        }
        p.onData(data => {
          try {
            ws.send(data)
          } catch {
            // ignore
          }
        })
        ws.on('message', msg => {
          try {
            const text = typeof msg === 'string' ? msg : msg.toString()
            if (text.startsWith('{')) {
              const parsed = JSON.parse(text) as { type?: string; cols?: number; rows?: number; data?: string }
              if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
                ;(proc as { resize?: (c: number, r: number) => void }).resize?.(parsed.cols, parsed.rows)
                return
              }
              if (parsed.type === 'data' && typeof parsed.data === 'string') {
                p.write(parsed.data)
                return
              }
            }
            p.write(text)
          } catch {
            // ignore
          }
        })
        p.onExit(() => ws.close())
      })
    })
    .catch(() => socket.destroy())
})
