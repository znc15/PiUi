import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent'
import { newMessageId, newPartId, newSessionId } from './ids.js'
import { publishPayload } from './events.js'
import * as permHub from './permission-hub.js'
import {
  makeAssistantShell,
  makeUserMessage,
  mapAgentMessageToUi,
  sanitizeAssistantText,
  type AgentMessage,
  type MessageWithParts,
  type UiMessage,
  type UiPart,
} from './mapper.js'

export type SessionMeta = {
  id: string
  title: string
  directory: string
  projectID: string
  parentID?: string
  version: string
  time: { created: number; updated: number; archived?: number }
  sessionFile?: string
  todos: Array<{ id: string; content: string; status: string; priority: string }>
  revert?: { messageID: string; partID?: string }
}

type LiveSession = {
  meta: SessionMeta
  runtime: AgentSessionRuntime
  unsubscribe?: () => void
  status: 'idle' | 'busy' | 'retry'
  abortRequested?: boolean
  messages: MessageWithParts[]
  /** current streaming assistant message tracking */
  stream?: {
    assistantMessageId: string
    textPartId: string
    reasoningPartId: string
    toolParts: Map<string, string> // toolCallId -> partId
  }
}

const sessions = new Map<string, LiveSession>()
let modelRuntimePromise: Promise<ModelRuntime> | null = null

function projectIdFor(directory: string): string {
  // stable-ish id from path
  let hash = 0
  for (let i = 0; i < directory.length; i++) hash = (hash * 31 + directory.charCodeAt(i)) >>> 0
  return `prj_${hash.toString(16)}`
}

async function getModelRuntime(): Promise<ModelRuntime> {
  if (!modelRuntimePromise) {
    modelRuntimePromise = ModelRuntime.create()
  }
  return modelRuntimePromise
}

function toApiSession(meta: SessionMeta) {
  return {
    id: meta.id,
    slug: meta.id.slice(0, 12),
    projectID: meta.projectID,
    directory: meta.directory,
    parentID: meta.parentID,
    title: meta.title,
    version: meta.version,
    time: {
      created: meta.time.created,
      updated: meta.time.updated,
      archived: meta.time.archived,
    },
    summary: undefined,
    share: undefined,
    permission: undefined,
    revert: meta.revert,
  }
}

function emitSession(type: 'session.created' | 'session.updated' | 'session.deleted', meta: SessionMeta) {
  if (type === 'session.deleted') {
    publishPayload(type, { sessionID: meta.id, info: toApiSession(meta) }, meta.directory)
  } else {
    publishPayload(type, { info: toApiSession(meta), sessionID: meta.id }, meta.directory)
  }
}

function emitStatus(live: LiveSession) {
  const status =
    live.status === 'busy'
      ? { type: 'busy' as const }
      : live.status === 'retry'
        ? { type: 'retry' as const, attempt: 1, message: 'retrying', next: Date.now() + 1000 }
        : { type: 'idle' as const }
  publishPayload('session.status', { sessionID: live.meta.id, status }, live.meta.directory)
}

function emitMessageUpdated(live: LiveSession, info: UiMessage) {
  publishPayload('message.updated', { info }, live.meta.directory)
}

function emitPartUpdated(live: LiveSession, part: UiPart) {
  publishPayload('message.part.updated', { sessionID: live.meta.id, part }, live.meta.directory)
}

function emitPartDelta(
  live: LiveSession,
  messageID: string,
  partID: string,
  field: string,
  delta: string,
) {
  publishPayload(
    'message.part.delta',
    { sessionID: live.meta.id, messageID, partID, field, delta },
    live.meta.directory,
  )
}

function bindSessionEvents(live: LiveSession) {
  live.unsubscribe?.()
  const session = live.runtime.session
  live.unsubscribe = session.subscribe(event => {
    void handlePiEvent(live, event)
  })
}

async function handlePiEvent(live: LiveSession, event: { type: string; [key: string]: unknown }) {
  const session = live.runtime.session

  // Abort is user-visible immediately. Ignore late provider chunks from the cancelled turn.
  if (
    live.abortRequested &&
    ['message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'message_end'].includes(event.type)
  ) {
    return
  }

  switch (event.type) {
    case 'agent_start': {
      live.status = 'busy'
      emitStatus(live)
      break
    }
    case 'message_start': {
      const message = event.message as { role?: string }
      if (message?.role === 'assistant') {
        const shell = makeAssistantShell(live.meta.id, {
          parentID: live.messages.filter(m => m.info.role === 'user').at(-1)?.info.id,
          cwd: live.meta.directory,
          providerID: session.model?.provider ?? 'pi',
          modelID: session.model?.id ?? 'default',
        })
        const textPart = shell.parts.find(p => p.type === 'text')!
        const reasoningPart = shell.parts.find(p => p.type === 'reasoning')!
        live.stream = {
          assistantMessageId: shell.info.id,
          textPartId: textPart.id,
          reasoningPartId: reasoningPart.id,
          toolParts: new Map(),
        }
        live.messages.push(shell)
        emitMessageUpdated(live, shell.info)
        emitPartUpdated(live, reasoningPart)
        emitPartUpdated(live, textPart)
      }
      break
    }
    case 'message_update': {
      const ame = event.assistantMessageEvent as { type?: string; delta?: string } | undefined
      if (!live.stream || !ame) break
      const msg = live.messages.find(m => m.info.id === live.stream!.assistantMessageId)
      if (!msg) break

      if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
        const part = msg.parts.find(p => p.id === live.stream!.textPartId)
        if (part) {
          const prevClean = String(part.text ?? '')
          const raw = String((part as { _rawText?: string })._rawText ?? prevClean) + ame.delta
          ;(part as { _rawText?: string })._rawText = raw
          const nextClean = sanitizeAssistantText(raw)
          const added = nextClean.startsWith(prevClean) ? nextClean.slice(prevClean.length) : nextClean
          part.text = nextClean
          if (added) emitPartDelta(live, msg.info.id, part.id, 'text', added)
        }
      } else if (ame.type === 'thinking_delta' && typeof ame.delta === 'string') {
        const part = msg.parts.find(p => p.id === live.stream!.reasoningPartId)
        if (part) {
          const prevClean = String(part.text ?? '')
          const raw = String((part as { _rawText?: string })._rawText ?? prevClean) + ame.delta
          ;(part as { _rawText?: string })._rawText = raw
          const nextClean = sanitizeAssistantText(raw)
          const added = nextClean.startsWith(prevClean) ? nextClean.slice(prevClean.length) : nextClean
          part.text = nextClean
          if (added) emitPartDelta(live, msg.info.id, part.id, 'text', added)
        }
      }
      break
    }
    case 'tool_execution_start': {
      if (!live.stream) break
      const msg = live.messages.find(m => m.info.id === live.stream!.assistantMessageId)
      if (!msg) break
      const toolCallId = String(event.toolCallId ?? newPartId())
      const toolName = String(event.toolName ?? 'tool')
      const partId = newPartId()
      live.stream.toolParts.set(toolCallId, partId)
      const part: UiPart = {
        id: partId,
        sessionID: live.meta.id,
        messageID: msg.info.id,
        type: 'tool',
        callID: toolCallId,
        tool: toolName,
        state: {
          status: 'running',
          input: event.args ?? {},
          title: toolName,
          metadata: {},
          time: { start: Date.now() },
        },
      }
      msg.parts.push(part)
      emitPartUpdated(live, part)
      break
    }
    case 'tool_execution_update': {
      if (!live.stream) break
      const toolCallId = String(event.toolCallId ?? '')
      const partId = live.stream.toolParts.get(toolCallId)
      const msg = live.messages.find(m => m.info.id === live.stream!.assistantMessageId)
      const part = msg?.parts.find(p => p.id === partId)
      if (!part) break
      part.state = {
        ...(part.state as object),
        status: 'running',
        metadata: { partial: event.partialResult },
        title: String(event.toolName ?? (part as { tool?: string }).tool ?? 'tool'),
      }
      emitPartUpdated(live, part)
      break
    }
    case 'tool_execution_end': {
      if (!live.stream) break
      const toolCallId = String(event.toolCallId ?? '')
      const partId = live.stream.toolParts.get(toolCallId)
      const msg = live.messages.find(m => m.info.id === live.stream!.assistantMessageId)
      const part = msg?.parts.find(p => p.id === partId)
      if (!part) break
      const isError = Boolean(event.isError)
      const result = event.result
      const output =
        typeof result === 'string'
          ? result
          : result && typeof result === 'object' && 'content' in (result as object)
            ? JSON.stringify((result as { content: unknown }).content)
            : JSON.stringify(result ?? '')
      part.state = {
        status: isError ? 'error' : 'completed',
        input: (part.state as { input?: unknown })?.input ?? {},
        output: isError ? undefined : output,
        error: isError ? output : undefined,
        title: String(event.toolName ?? (part as { tool?: string }).tool ?? 'tool'),
        metadata: {},
        time: {
          start: (part.state as { time?: { start?: number } })?.time?.start ?? Date.now(),
          end: Date.now(),
        },
      }
      emitPartUpdated(live, part)
      break
    }
    case 'message_end': {
      if (!live.stream) break
      const msg = live.messages.find(m => m.info.id === live.stream!.assistantMessageId)
      if (msg) {
        const completedAt = Date.now()
        const prevTime = (msg.info.time ?? { created: completedAt }) as { created: number; completed?: number }
        const rawMessage = event.message as AgentMessage | undefined
        // Reconcile the streamed shell with Pi's final assistant payload.
        if (rawMessage?.role === 'assistant') {
          const finalMessage = mapAgentMessageToUi(live.meta.id, rawMessage, {
            messageId: msg.info.id,
            cwd: live.meta.directory,
          })
          msg.info = { ...msg.info, ...finalMessage.info }
          for (const finalPart of finalMessage.parts) {
            if (finalPart.type !== 'text' && finalPart.type !== 'reasoning') continue
            const current = msg.parts.find(p => p.type === finalPart.type)
            if (current) {
              current.text = finalPart.text
              current.time = { ...(current.time as object), end: completedAt }
            } else if (String(finalPart.text ?? '').trim()) {
              finalPart.time = { ...(finalPart.time as object), end: completedAt }
              msg.parts.push(finalPart)
            }
          }
        }
        msg.info.time = { created: prevTime.created, completed: completedAt }
        msg.parts = msg.parts.filter(p => !(p.type === 'reasoning' && !String(p.text ?? '').trim()))
        for (const part of msg.parts) {
          if (part.type === 'text' || part.type === 'reasoning') {
            part.time = { ...(part.time as object), end: completedAt }
            emitPartUpdated(live, part)
          }
        }
        emitMessageUpdated(live, msg.info)
      }
      live.stream = undefined
      break
    }
    case 'agent_end':
    case 'agent_settled': {
      live.abortRequested = false
      live.status = 'idle'
      live.meta.time.updated = Date.now()
      emitStatus(live)
      publishPayload('session.idle', { sessionID: live.meta.id }, live.meta.directory)
      emitSession('session.updated', live.meta)
      break
    }
    case 'auto_retry_start': {
      live.status = 'retry'
      emitStatus(live)
      break
    }
    default:
      break
  }
}

async function createRuntime(cwd: string, sessionManager: SessionManager): Promise<AgentSessionRuntime> {
  const modelRuntime = await getModelRuntime()
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: runtimeCwd,
    sessionManager: sm,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({ cwd: runtimeCwd, modelRuntime })
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: sm,
      sessionStartEvent,
      thinkingLevel: services.settingsManager.getDefaultThinkingLevel(),
    })
    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    }
  }

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: getAgentDir(),
    sessionManager,
  })

  // Install the beforeToolCall hook for permission gating.
  // The Agent exposes beforeToolCall as a mutable property.
  const session = runtime.session
  const agent = (session as { agent?: { beforeToolCall?: unknown } }).agent
  if (agent && typeof agent === 'object') {
    const a = agent as { beforeToolCall?: (context: unknown, signal?: unknown) => Promise<unknown> }
    const originalBeforeToolCall = a.beforeToolCall
    const settingsManager = runtime.services.settingsManager
    const hook = permHub.createBeforeToolCallHook(
      session.sessionId || '',
      cwd,
      settingsManager,
    )
    a.beforeToolCall = async (context: unknown, signal?: unknown) => {
      // Run our permission hook first
      const c = context as {
        toolCall: { name: string; id: string; arguments?: unknown }
        args: unknown
      }
      const result = await hook(c, signal as AbortSignal | undefined)
      if (result && (result as { block?: boolean }).block) return result
      // Then run any existing beforeToolCall from extensions
      if (originalBeforeToolCall) {
        return originalBeforeToolCall.call(agent, context, signal)
      }
      return undefined
    }
  }

  return runtime
}

function hydrateMessagesFromSession(live: LiveSession) {
  try {
    const agentMessages = live.runtime.session.messages ?? []
    live.messages = agentMessages.map(m =>
      mapAgentMessageToUi(live.meta.id, m as Parameters<typeof mapAgentMessageToUi>[1], {
        cwd: live.meta.directory,
      }),
    )
  } catch (err) {
    console.warn('[session-hub] hydrate failed', err)
    live.messages = []
  }
}

export async function createSession(params: {
  directory?: string
  title?: string
  parentID?: string
}): Promise<ReturnType<typeof toApiSession>> {
  const directory = path.resolve(params.directory || process.env.PI_WORKSPACE || process.cwd())
  const id = newSessionId()
  const now = Date.now()
  const sessionManager = SessionManager.create(directory)
  const runtime = await createRuntime(directory, sessionManager)

  const meta: SessionMeta = {
    id,
    title: params.title || 'New session',
    directory,
    projectID: projectIdFor(directory),
    parentID: params.parentID,
    version: 'pi',
    time: { created: now, updated: now },
    sessionFile: runtime.session.sessionFile,
    todos: [],
  }

  try {
    runtime.session.setSessionName(meta.title)
  } catch {
    // optional API
  }

  const live: LiveSession = {
    meta,
    runtime,
    status: 'idle',
    messages: [],
  }
  // Use pi session id as canonical if available
  if (runtime.session.sessionId) {
    // Keep both: store under our id AND pi id for lookup robustness
    meta.id = runtime.session.sessionId
  }
  sessions.set(meta.id, live)
  bindSessionEvents(live)
  emitSession('session.created', meta)
  emitStatus(live)
  return toApiSession(meta)
}

export async function openExistingSession(sessionFile: string, directory: string): Promise<LiveSession | null> {
  try {
    const sessionManager = SessionManager.open(sessionFile)
    const runtime = await createRuntime(directory, sessionManager)
    const id = runtime.session.sessionId || newSessionId()
    if (sessions.has(id)) return sessions.get(id)!

    const now = Date.now()
    const meta: SessionMeta = {
      id,
      title: runtime.session.sessionName || path.basename(sessionFile),
      directory,
      projectID: projectIdFor(directory),
      version: 'pi',
      time: { created: now, updated: now },
      sessionFile,
      todos: [],
    }
    const live: LiveSession = { meta, runtime, status: 'idle', messages: [] }
    hydrateMessagesFromSession(live)
    sessions.set(id, live)
    bindSessionEvents(live)
    return live
  } catch (err) {
    console.error('[session-hub] openExistingSession failed', err)
    return null
  }
}

export async function listSessions(params: {
  directory?: string
  search?: string
  limit?: number
}): Promise<ReturnType<typeof toApiSession>[]> {
  const directory = params.directory ? path.resolve(params.directory) : undefined

  // include live
  const result: ReturnType<typeof toApiSession>[] = []
  for (const live of sessions.values()) {
    if (directory && live.meta.directory !== directory) continue
    if (params.search && !live.meta.title.toLowerCase().includes(params.search.toLowerCase())) continue
    result.push(toApiSession(live.meta))
  }

  // discover persisted pi sessions
  try {
    const cwd = directory || process.cwd()
    const infos = await SessionManager.list(cwd)
    for (const info of infos) {
      if (sessions.has(info.id)) continue
      if (params.search) {
        const hay = `${info.name ?? ''} ${info.firstMessage ?? ''}`.toLowerCase()
        if (!hay.includes(params.search.toLowerCase())) continue
      }
      result.push({
        id: info.id,
        slug: info.id.slice(0, 12),
        projectID: projectIdFor(info.cwd || cwd),
        directory: info.cwd || cwd,
        parentID: undefined,
        title: info.name || info.firstMessage?.slice(0, 60) || 'Session',
        version: 'pi',
        time: {
          created: info.created?.getTime?.() ?? Date.now(),
          updated: info.modified?.getTime?.() ?? Date.now(),
          archived: undefined,
        },
        summary: undefined,
        share: undefined,
        permission: undefined,
        revert: undefined,
      })
    }
  } catch (err) {
    console.warn('[session-hub] list persisted failed', err)
  }

  result.sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
  if (params.limit) return result.slice(0, params.limit)
  return result
}

export async function getLiveSession(sessionID: string, directory?: string): Promise<LiveSession | null> {
  const existing = sessions.get(sessionID)
  if (existing) return existing

  // try open from disk
  const cwd = directory ? path.resolve(directory) : process.cwd()
  try {
    const infos = await SessionManager.list(cwd)
    const hit = infos.find(i => i.id === sessionID || i.path.includes(sessionID))
    if (hit) {
      return openExistingSession(hit.path, hit.cwd || cwd)
    }
  } catch {
    // ignore
  }

  // broader search
  try {
    const infos = await SessionManager.listAll()
    const hit = infos.find(i => i.id === sessionID)
    if (hit) return openExistingSession(hit.path, hit.cwd || cwd)
  } catch {
    // ignore
  }
  return null
}

export async function getSession(sessionID: string, directory?: string) {
  const live = await getLiveSession(sessionID, directory)
  if (!live) throw Object.assign(new Error('Session not found'), { status: 404 })
  return toApiSession(live.meta)
}

export async function updateSession(
  sessionID: string,
  patch: { title?: string; time?: { archived?: number } },
  directory?: string,
) {
  const live = await getLiveSession(sessionID, directory)
  if (!live) throw Object.assign(new Error('Session not found'), { status: 404 })
  if (patch.title !== undefined) {
    live.meta.title = patch.title
    try {
      live.runtime.session.setSessionName(patch.title)
    } catch {
      // optional
    }
  }
  if (patch.time?.archived !== undefined) {
    live.meta.time.archived = patch.time.archived
  }
  live.meta.time.updated = Date.now()
  emitSession('session.updated', live.meta)
  return toApiSession(live.meta)
}

export async function deleteSession(sessionID: string, directory?: string) {
  const live = await getLiveSession(sessionID, directory)
  if (!live) return true
  // Clean up pending permissions/questions for this session
  permHub.disposeSession(sessionID)
  try {
    await live.runtime.session.abort()
  } catch {
    // ignore
  }
  live.unsubscribe?.()
  try {
    await live.runtime.dispose()
  } catch {
    // ignore
  }
  // try delete session file
  if (live.meta.sessionFile && fs.existsSync(live.meta.sessionFile)) {
    try {
      fs.unlinkSync(live.meta.sessionFile)
    } catch {
      // ignore
    }
  }
  sessions.delete(live.meta.id)
  emitSession('session.deleted', live.meta)
  return true
}

export async function getMessages(sessionID: string, directory?: string, limit?: number) {
  const live = await getLiveSession(sessionID, directory)
  if (!live) throw Object.assign(new Error('Session not found'), { status: 404 })
  if (live.messages.length === 0) hydrateMessagesFromSession(live)
  const msgs = live.messages
  return typeof limit === 'number' ? msgs.slice(-limit) : msgs
}

export async function promptAsync(
  sessionID: string,
  body: {
    parts?: Array<{ type: string; text?: string; [key: string]: unknown }>
    model?: { providerID?: string; modelID?: string }
    agent?: string
    directory?: string
  },
) {
  const live = await getLiveSession(sessionID, body.directory)
  if (!live) throw Object.assign(new Error('Session not found'), { status: 404 })

  const text = (body.parts ?? [])
    .filter(p => p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text as string)
    .join('\n')

  const user = makeUserMessage(live.meta.id, text, {
    providerID: body.model?.providerID,
    modelID: body.model?.modelID,
    agent: body.agent,
  })
  live.messages.push(user)
  emitMessageUpdated(live, user.info)
  for (const part of user.parts) emitPartUpdated(live, part)

  // model switch if requested
  if (body.model?.modelID) {
    try {
      const modelRuntime = await getModelRuntime()
      const providerID = body.model.providerID
      const found = providerID
        ? modelRuntime.getModel(providerID, body.model.modelID)
        : modelRuntime.getModels().find(m => m.id === body.model?.modelID)
      if (found) await live.runtime.session.setModel(found)
    } catch (err) {
      console.warn('[session-hub] setModel failed', err)
    }
  }

  live.meta.time.updated = Date.now()
  live.meta.title = live.meta.title === 'New session' ? text.slice(0, 60) || live.meta.title : live.meta.title
  live.abortRequested = false
  emitSession('session.updated', live.meta)

  // fire and forget prompt
  void live.runtime.session.prompt(text).catch(err => {
    console.error('[session-hub] prompt error', err)
    publishPayload(
      'session.error',
      {
        sessionID: live.meta.id,
        name: 'UnknownError',
        data: { message: err instanceof Error ? err.message : String(err) },
      },
      live.meta.directory,
    )
    live.stream = undefined
    live.status = 'idle'
    emitStatus(live)
    publishPayload('session.idle', { sessionID: live.meta.id }, live.meta.directory)
  })

  return { ok: true }
}

export async function promptSync(
  sessionID: string,
  body: {
    parts?: Array<{ type: string; text?: string; [key: string]: unknown }>
    model?: { providerID?: string; modelID?: string }
    agent?: string
    directory?: string
  },
) {
  await promptAsync(sessionID, body)
  const live = await getLiveSession(sessionID, body.directory)
  if (!live) throw Object.assign(new Error('Session not found'), { status: 404 })
  // wait until idle (max 10 minutes)
  const started = Date.now()
  while (live.status === 'busy' || live.status === 'retry') {
    if (Date.now() - started > 10 * 60 * 1000) break
    await new Promise(r => setTimeout(r, 100))
  }
  const lastAssistant = [...live.messages].reverse().find(m => m.info.role === 'assistant')
  return lastAssistant ?? { info: { id: newMessageId(), role: 'assistant', sessionID }, parts: [] }
}

export async function abortSession(sessionID: string, directory?: string) {
  const live = await getLiveSession(sessionID, directory)
  if (!live) return true

  // Mark idle before awaiting provider cleanup so the stop button responds immediately.
  live.abortRequested = true
  live.status = 'idle'
  emitStatus(live)
  publishPayload('session.idle', { sessionID: live.meta.id }, live.meta.directory)

  // Reject any pending permissions/questions for this session so the UI doesn't hang
  permHub.disposeSession(sessionID)

  void live.runtime.session.abort().catch(err => {
    console.warn('[session-hub] abort failed', err)
  })
  return true
}

export function getStatusMap(directory?: string): Record<string, { type: string }> {
  const out: Record<string, { type: string }> = {}
  for (const live of sessions.values()) {
    if (directory && live.meta.directory !== path.resolve(directory)) continue
    out[live.meta.id] = { type: live.status === 'busy' ? 'busy' : live.status === 'retry' ? 'retry' : 'idle' }
  }
  return out
}

export async function listProviders() {
  try {
    const modelRuntime = await getModelRuntime()
    let models = modelRuntime.getAvailableSnapshot()
    if (!models.length) {
      try {
        models = await modelRuntime.getAvailable()
      } catch {
        models = modelRuntime.getModels()
      }
    }
    if (!models.length) models = modelRuntime.getModels()

    const byProvider = new Map<string, Record<string, unknown>>()
    const defaults: Record<string, string> = {}

    for (const m of models) {
      const providerId = m.provider || 'pi'
      if (!byProvider.has(providerId)) {
        byProvider.set(providerId, {})
      }
      const bucket = byProvider.get(providerId)!
      bucket[m.id] = {
        id: m.id,
        name: m.name || m.id,
        family: '',
        status: 'active',
        limit: {
          context: (m as { contextWindow?: number }).contextWindow ?? 200000,
          output: (m as { maxOutputTokens?: number }).maxOutputTokens ?? 8192,
        },
        capabilities: {
          reasoning: true,
          toolcall: true,
          input: { text: true, image: true },
        },
        variants: {},
      }
      if (!defaults[providerId]) defaults[providerId] = m.id
    }

    // ensure at least one provider for UI
    if (byProvider.size === 0) {
      byProvider.set('pi', {
        default: {
          id: 'default',
          name: 'Pi Default',
          family: 'pi',
          status: 'active',
          limit: { context: 200000, output: 8192 },
          capabilities: { reasoning: true, toolcall: true, input: { text: true, image: true } },
          variants: {},
        },
      })
      defaults.pi = 'default'
    }

    const providers = [...byProvider.entries()].map(([id, modelsMap]) => ({
      id,
      name: id,
      source: 'pi',
      env: [],
      models: modelsMap,
    }))

    return { providers, default: defaults }
  } catch (err) {
    console.warn('[session-hub] listProviders failed', err)
    return {
      providers: [
        {
          id: 'pi',
          name: 'Pi',
          source: 'pi',
          env: [],
          models: {
            default: {
              id: 'default',
              name: 'Pi Default',
              family: 'pi',
              status: 'active',
              limit: { context: 200000, output: 8192 },
              capabilities: { reasoning: true, toolcall: true, input: { text: true, image: true } },
              variants: {},
            },
          },
        },
      ],
      default: { pi: 'default' },
    }
  }
}

export function getDefaultWorkspace(): string {
  return path.resolve(process.env.PI_WORKSPACE || process.cwd())
}

export function getPathInfo(directory?: string) {
  const dir = path.resolve(directory || getDefaultWorkspace())
  return {
    home: os.homedir(),
    state: path.join(os.homedir(), '.pi'),
    config: path.join(os.homedir(), '.pi'),
    worktree: dir,
    directory: dir,
  }
}

export function getCurrentProject(directory?: string) {
  const dir = path.resolve(directory || getDefaultWorkspace())
  return {
    id: projectIdFor(dir),
    worktree: dir,
    vcs: fs.existsSync(path.join(dir, '.git')) ? 'git' : undefined,
    name: path.basename(dir),
    time: { created: Date.now(), updated: Date.now() },
  }
}

export async function summarizeSession(sessionID: string, directory?: string) {
  const live = await getLiveSession(sessionID, directory)
  if (!live) throw Object.assign(new Error('Session not found'), { status: 404 })
  try {
    await live.runtime.session.compact()
    publishPayload('session.compacted', { sessionID: live.meta.id }, live.meta.directory)
  } catch (err) {
    console.warn('[session-hub] compact failed', err)
  }
  return true
}

export async function forkSession(sessionID: string, messageID?: string, directory?: string) {
  const live = await getLiveSession(sessionID, directory)
  if (!live) throw Object.assign(new Error('Session not found'), { status: 404 })
  // create a new session and copy messages up to messageID
  const created = await createSession({
    directory: live.meta.directory,
    title: `${live.meta.title} (fork)`,
    parentID: live.meta.id,
  })
  const forked = sessions.get(created.id)
  if (forked) {
    const idx = messageID ? live.messages.findIndex(m => m.info.id === messageID) : live.messages.length - 1
    forked.messages = live.messages.slice(0, idx >= 0 ? idx + 1 : undefined).map(m => structuredClone(m))
  }
  return created
}

export function getTodos(sessionID: string) {
  const live = sessions.get(sessionID)
  return live?.meta.todos ?? []
}

/** Compute real token/cost stats from Pi agent messages (not estimated). */
export interface SessionUsageStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  costTotal: number
  contextLimit: number
}

export function getSessionUsageStats(sessionID: string): SessionUsageStats {
  const live = sessions.get(sessionID)
  const zero: SessionUsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costTotal: 0,
    contextLimit: 200000,
  }
  if (!live) return zero

  try {
    const piStats = live.runtime.session.getSessionStats()
    const contextUsage = live.runtime.session.getContextUsage()
    const messages = live.runtime.session.messages ?? []
    let reasoningTokens = 0
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') continue
      reasoningTokens += typeof msg.usage?.reasoning === 'number' ? msg.usage.reasoning : 0
    }

    return {
      inputTokens: piStats.tokens.input,
      outputTokens: piStats.tokens.output,
      cacheReadTokens: piStats.tokens.cacheRead,
      cacheWriteTokens: piStats.tokens.cacheWrite,
      reasoningTokens,
      totalTokens: contextUsage?.tokens ?? piStats.tokens.total,
      costTotal: piStats.cost,
      contextLimit: contextUsage?.contextWindow ?? live.runtime.session.model?.contextWindow ?? zero.contextLimit,
    }
  } catch {
    return zero
  }
}

export async function disposeAll() {
  // Clean up all pending permissions/questions
  permHub.disposeAll()
  for (const live of sessions.values()) {
    live.unsubscribe?.()
    try {
      live.runtime.session.dispose()
    } catch {
      // ignore
    }
    try {
      await live.runtime.dispose()
    } catch {
      // ignore
    }
  }
  sessions.clear()
}
