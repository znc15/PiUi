import { spawn, type ChildProcess } from 'node:child_process'
import * as piConfig from './pi-config.js'
import { publishPayload } from './events.js'

// ============================================
// Types
// ============================================

export type MCPStatus =
  | { type: 'connected'; status: 'connected'; resources?: MCPResource[]; tools?: MCPTool[] }
  | { type: 'disconnected'; status: 'disconnected' }
  | { type: 'connecting'; status: 'connecting' }
  | { type: 'disabled'; status: 'disabled' }
  | { type: 'failed'; status: 'failed'; error?: string }
  | { type: 'needs-auth'; status: 'needs_auth' }
  | { type: 'needs-client-registration'; status: 'needs_client_registration' }

export type MCPStatusResponse = Record<string, MCPStatus>

export type MCPResource = {
  uri: string
  name: string
  mimeType?: string
  text?: string
  blob?: string
  client: string
}

export type MCPTool = {
  name: string
  description?: string
  inputSchema?: unknown
}

/** Pi mcp.json server entry (actual format on disk) */
export type PiMcpServerEntry = {
  type?: string // 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
  lifecycle?: string // 'lazy' | 'eager'
  timeout?: number
  oauth?: { clientId?: string; clientSecret?: string; scope?: string }
}

type LiveMcpServer = {
  name: string
  config: PiMcpServerEntry
  status: MCPStatus
  process?: ChildProcess
  resources: MCPResource[]
  tools: MCPTool[]
  connectPromise?: Promise<void>
  lastError?: string
}

// ============================================
// State
// ============================================

const servers = new Map<string, LiveMcpServer>()
let configLoaded = false

// ============================================
// Config loading
// ============================================

function isLocalServer(entry: PiMcpServerEntry): boolean {
  return Boolean(entry.command) || entry.type === 'stdio' || (!entry.type && Boolean(entry.command))
}

function isRemoteServer(entry: PiMcpServerEntry): boolean {
  return Boolean(entry.url) || entry.type === 'sse' || entry.type === 'streamable-http'
}

/** Read mcp.json and sync server definitions. Preserves running servers. */
export async function loadConfig(): Promise<void> {
  const raw = await piConfig.getMcpConfig()
  const mcpServers = (raw.mcpServers ?? raw) as Record<string, PiMcpServerEntry>

  // Remove servers no longer in config
  for (const name of servers.keys()) {
    if (!(name in mcpServers)) {
      const live = servers.get(name)!
      if (live.process) {
        try { live.process.kill() } catch { /* ignore */ }
      }
      servers.delete(name)
    }
  }

  // Add or update servers from config
  for (const [name, config] of Object.entries(mcpServers)) {
    if (!config || typeof config !== 'object') continue
    const existing = servers.get(name)
    if (existing) {
      // Update config but keep running process if command unchanged
      existing.config = config
      // If disabled, disconnect
      if (config.enabled === false && existing.status.type === 'connected') {
        disconnectServer(name)
      }
    } else {
      servers.set(name, {
        name,
        config,
        status: config.enabled === false ? { type: 'disabled', status: 'disabled' } : { type: 'disconnected', status: 'disconnected' },
        resources: [],
        tools: [],
      })
    }
  }
  configLoaded = true
}

/** Ensure config is loaded before any operation. */
async function ensureLoaded(): Promise<void> {
  if (!configLoaded) await loadConfig()
}

// ============================================
// Server lifecycle
// ============================================

/** Connect a local (stdio) MCP server by spawning its process. */
async function connectLocalServer(name: string, live: LiveMcpServer): Promise<void> {
  const config = live.config
  const command = config.command
  if (!command) {
    live.status = { type: 'failed', status: 'failed', error: 'No command specified' }
    return
  }

  live.status = { type: 'connecting', status: 'connecting' }
  publishMcpStatusChanged(name, live.status)

  return new Promise<void>((resolve) => {
    try {
      const args = config.args ?? []
      const env = { ...process.env, ...config.env }

      const proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        timeout: config.timeout,
      }) as ChildProcess

      live.process = proc

      // Buffer stderr for error reporting
      let stderrBuf = ''
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString()
        // Keep last 2KB for error message
        if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048)
      })

      proc.on('error', (err: Error) => {
        const code = (err as NodeJS.ErrnoException).code
        const friendly =
          code === 'ENOENT'
            ? `Command not found: "${command}". Install it first (e.g. npm i -g ${command}), or use an absolute path / npx in args.`
            : err.message
        live.status = { type: 'failed', status: 'failed', error: friendly }
        live.process = undefined
        live.lastError = friendly
        publishMcpStatusChanged(name, live.status)
        resolve()
      })

      proc.on('exit', (code: number | null, signal: string | null) => {
        if (live.status.type === 'connecting' || live.status.type === 'connected') {
          const reason = signal
            ? `killed by signal ${signal}`
            : code === 0
              ? 'exited cleanly'
              : `exited with code ${code}`
          const errorDetail = stderrBuf.trim() ? `: ${stderrBuf.trim().slice(0, 500)}` : ''
          live.status = code === 0 && live.status.type === 'connected'
            ? { type: 'disconnected', status: 'disconnected' }
            : { type: 'failed', status: 'failed', error: `${reason}${errorDetail}` }
          live.lastError = live.status.type === 'failed' ? (live.status as { error?: string }).error : undefined
          live.process = undefined
          publishMcpStatusChanged(name, live.status)
        }
        resolve()
      })

      // Give the process a moment to start; if it dies immediately we catch it via exit
      // For a real MCP protocol implementation we'd do JSON-RPC initialize here.
      // For now, consider it "connected" once the process is running for 500ms.
      const startupTimer = setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          live.status = { type: 'connected', status: 'connected', resources: live.resources, tools: live.tools }
          publishMcpStatusChanged(name, live.status)
          resolve()
        }
      }, 500)

      proc.on('exit', () => {
        clearTimeout(startupTimer)
      })

    } catch (err) {
      live.status = { type: 'failed', status: 'failed', error: err instanceof Error ? err.message : String(err) }
      live.lastError = (live.status as { error?: string }).error
      publishMcpStatusChanged(name, live.status)
      resolve()
    }
  })
}

/** Connect a remote (URL-based) MCP server by checking HTTP health. */
async function connectRemoteServer(name: string, live: LiveMcpServer): Promise<void> {
  const config = live.config
  const url = config.url
  if (!url) {
    live.status = { type: 'failed', status: 'failed', error: 'No URL specified' }
    return
  }

  live.status = { type: 'connecting', status: 'connecting' }
  publishMcpStatusChanged(name, live.status)

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), (config.timeout ?? 10) * 1000)

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...config.headers,
    }

    // Try SSE endpoint first (common MCP pattern), then fallback to base URL
    const sseUrl = url.endsWith('/sse') ? url : `${url.replace(/\/$/, '')}/sse`
    let response: Response | null = null

    try {
      response = await fetch(sseUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
    } catch {
      // SSE endpoint not available, try base URL
      try {
        response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        })
      } catch (fetchErr) {
        live.status = {
          type: 'failed',
          status: 'failed',
          error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        }
        live.lastError = (live.status as { error?: string }).error
        publishMcpStatusChanged(name, live.status)
        return
      }
    } finally {
      clearTimeout(timeout)
    }

    if (response.ok) {
      live.status = { type: 'connected', status: 'connected', resources: live.resources, tools: live.tools }
      publishMcpStatusChanged(name, live.status)
    } else if (response.status === 401 || response.status === 403) {
      live.status = { type: 'needs-auth', status: 'needs_auth' }
      publishMcpStatusChanged(name, live.status)
    } else {
      live.status = {
        type: 'failed',
        status: 'failed',
        error: `HTTP ${response.status} ${response.statusText}`,
      }
      live.lastError = (live.status as { error?: string }).error
      publishMcpStatusChanged(name, live.status)
    }
  } catch (err) {
    live.status = { type: 'failed', status: 'failed', error: err instanceof Error ? err.message : String(err) }
    live.lastError = (live.status as { error?: string }).error
    publishMcpStatusChanged(name, live.status)
  }
}

/** Connect a named MCP server. */
export async function connectServer(name: string): Promise<MCPStatus> {
  await ensureLoaded()
  const live = servers.get(name)
  if (!live) return { type: 'failed', status: 'failed', error: `Server "${name}" not found in config` }

  if (live.config.enabled === false) return { type: 'disabled', status: 'disabled' }
  if (live.status.type === 'connected') return live.status

  // Prevent double-connect
  if (live.connectPromise) return live.connectPromise.then(() => live.status)

  if (isLocalServer(live.config)) {
    live.connectPromise = connectLocalServer(name, live)
  } else if (isRemoteServer(live.config)) {
    live.connectPromise = connectRemoteServer(name, live)
  } else {
    live.status = { type: 'failed', status: 'failed', error: 'Unknown server type (no command or url)' }
    publishMcpStatusChanged(name, live.status)
    live.connectPromise = Promise.resolve()
  }

  await live.connectPromise
  live.connectPromise = undefined
  return live.status
}

/** Disconnect a named MCP server. */
export async function disconnectServer(name: string): Promise<boolean> {
  const live = servers.get(name)
  if (!live) return false

  if (live.process) {
    try {
      live.process.kill('SIGTERM')
      // Give it 2 seconds then force kill
      setTimeout(() => {
        try { live.process?.kill('SIGKILL') } catch { /* ignore */ }
      }, 2000)
    } catch { /* ignore */ }
    live.process = undefined
  }

  live.resources = []
  live.tools = []
  live.status = live.config.enabled === false ? { type: 'disabled', status: 'disabled' } : { type: 'disconnected', status: 'disconnected' }
  publishMcpStatusChanged(name, live.status)
  return true
}

/** Connect all enabled servers. */
export async function connectAll(): Promise<void> {
  await ensureLoaded()
  const promises: Promise<MCPStatus>[] = []
  for (const [name, live] of servers.entries()) {
    if (live.config.enabled !== false && live.status.type !== 'connected') {
      promises.push(connectServer(name))
    }
  }
  await Promise.allSettled(promises)
}

/** Disconnect all servers. */
export async function disconnectAll(): Promise<void> {
  const promises: Promise<boolean>[] = []
  for (const name of servers.keys()) {
    promises.push(disconnectServer(name))
  }
  await Promise.allSettled(promises)
}

// ============================================
// Status queries
// ============================================

/** Get status of all MCP servers. */
export async function getStatus(): Promise<MCPStatusResponse> {
  await ensureLoaded()
  const out: MCPStatusResponse = {}
  for (const [name, live] of servers.entries()) {
    out[name] = live.status
  }
  return out
}

/** Get resources from all connected servers. */
export async function getResources(): Promise<Record<string, MCPResource[]>> {
  await ensureLoaded()
  const out: Record<string, MCPResource[]> = {}
  for (const [name, live] of servers.entries()) {
    if (live.status.type === 'connected' && live.resources.length > 0) {
      out[name] = live.resources
    }
  }
  return out
}

/** Get tools from all connected servers. */
export async function getTools(): Promise<Record<string, MCPTool[]>> {
  await ensureLoaded()
  const out: Record<string, MCPTool[]> = {}
  for (const [name, live] of servers.entries()) {
    if (live.status.type === 'connected' && live.tools.length > 0) {
      out[name] = live.tools
    }
  }
  return out
}

/** Add a new server to the config and optionally connect it. */
export async function addServer(name: string, config: PiMcpServerEntry, autoConnect = true): Promise<MCPStatus> {
  await ensureLoaded()

  // Write to mcp.json
  const raw = await piConfig.getMcpConfig()
  const mcpServers = ((raw.mcpServers ?? raw) as Record<string, PiMcpServerEntry>)
  mcpServers[name] = config
  if (!raw.mcpServers) {
    // Restructure to standard format
    await piConfig.updateMcpConfig({ mcpServers })
  } else {
    await piConfig.updateMcpConfig({ ...raw, mcpServers })
  }

  // Add to live state
  servers.set(name, {
    name,
    config,
    status: config.enabled === false ? { type: 'disabled', status: 'disabled' } : { type: 'disconnected', status: 'disconnected' },
    resources: [],
    tools: [],
  })

  if (autoConnect && config.enabled !== false) {
    return connectServer(name)
  }

  return servers.get(name)!.status
}

/** Remove a server from config and disconnect it. */
export async function removeServer(name: string): Promise<boolean> {
  await disconnectServer(name)

  const raw = await piConfig.getMcpConfig()
  const mcpServers = ((raw.mcpServers ?? raw) as Record<string, PiMcpServerEntry>)
  if (!(name in mcpServers)) return false
  delete mcpServers[name]
  await piConfig.updateMcpConfig(raw.mcpServers ? { ...raw, mcpServers } : { mcpServers })

  servers.delete(name)
  return true
}

// ============================================
// Event publishing
// ============================================

function publishMcpStatusChanged(name: string, status: MCPStatus): void {
  publishPayload('mcp.status.changed', { name, status })
  // Also publish tools.changed when transitioning to/from connected
  if (status.type === 'connected') {
    const live = servers.get(name)
    if (live) {
      publishPayload('mcp.tools.changed', {
        name,
        tools: live.tools,
        resources: live.resources,
      })
    }
  }
}

// ============================================
// Cleanup
// ============================================

/** Disconnect all and clear state. Called on server shutdown. */
export async function dispose(): Promise<void> {
  await disconnectAll()
  servers.clear()
  configLoaded = false
}
