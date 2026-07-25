import { newMessageId, newPartId } from './ids.js'

// Loose message shape from Pi agent (avoid hard dep path on nested package types)
export type AgentMessage = {
  role: string
  content?: unknown
  id?: string
  timestamp?: number
  model?: string
  provider?: string
  usage?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
    totalTokens?: number
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
  }
  stopReason?: string
  errorMessage?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

export type UiMessage = {
  id: string
  sessionID: string
  role: 'user' | 'assistant'
  time: { created: number; completed?: number }
  [key: string]: unknown
}

export type UiPart = {
  id: string
  sessionID: string
  messageID: string
  type: string
  [key: string]: unknown
}

export type MessageWithParts = {
  info: UiMessage
  parts: UiPart[]
}

/** Strip ANSI CSI / OSC sequences and Pi turn-footer noise from assistant text. */
/* eslint-disable no-control-regex */
export function sanitizeAssistantText(text: string): string {
  if (!text) return text
  let out = text
    // ESC[ ... letter
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // ESC] ... BEL or ST
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // leftover single ESC
    .replace(/\u001b./g, '')
  // Drop Pi TUI turn summary footers that sometimes leak into content
  out = out.replace(/\n*\s*✻\s*Turn took[^\n]*$/g, '')
  return out
}
/* eslint-enable no-control-regex */

function contentToText(content: unknown): string {
  if (typeof content === 'string') return sanitizeAssistantText(content)
  if (!Array.isArray(content)) return ''
  return sanitizeAssistantText(
    content
      .map(block => {
        if (!block || typeof block !== 'object') return ''
        const b = block as { type?: string; text?: string }
        if (b.type === 'text' && typeof b.text === 'string') return b.text
        return ''
      })
      .filter(Boolean)
      .join(''),
  )
}

function contentToThinking(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (!block || typeof block !== 'object') return ''
      const b = block as { type?: string; thinking?: string }
      if (b.type === 'thinking' && typeof b.thinking === 'string') return b.thinking
      return ''
    })
    .filter(Boolean)
    .join('')
}

export function mapAgentMessageToUi(
  sessionID: string,
  message: AgentMessage,
  opts?: { messageId?: string; cwd?: string },
): MessageWithParts {
  const messageID = opts?.messageId ?? (typeof (message as { id?: string }).id === 'string' ? (message as { id: string }).id : newMessageId())
  const created =
    typeof (message as { timestamp?: number }).timestamp === 'number'
      ? (message as { timestamp: number }).timestamp
      : Date.now()

  if (message.role === 'user') {
    const text = contentToText((message as { content?: unknown }).content)
    const info: UiMessage = {
      id: messageID,
      sessionID,
      role: 'user',
      time: { created },
      agent: 'pi',
      model: {
        providerID: 'pi',
        modelID: 'default',
      },
    }
    const parts: UiPart[] = [
      {
        id: newPartId(),
        sessionID,
        messageID,
        type: 'text',
        text,
        time: { start: created },
      },
    ]
    return { info, parts }
  }

  if (message.role === 'assistant') {
    const m = message as {
      content?: unknown
      model?: string
      provider?: string
      usage?: AgentMessage['usage']
      stopReason?: string
      errorMessage?: string
    }
    const text = contentToText(m.content)
    const thinking = contentToThinking(m.content)
    const info: UiMessage = {
      id: messageID,
      sessionID,
      role: 'assistant',
      time: { created, completed: created },
      parentID: '',
      modelID: m.model ?? 'default',
      providerID: m.provider ?? 'pi',
      mode: 'build',
      agent: 'pi',
      path: { cwd: opts?.cwd ?? process.cwd(), root: opts?.cwd ?? process.cwd() },
      cost: m.usage?.cost?.total ?? 0,
      tokens: {
        input: m.usage?.input ?? 0,
        output: m.usage?.output ?? 0,
        reasoning: m.usage?.reasoning ?? 0,
        cache: { read: m.usage?.cacheRead ?? 0, write: m.usage?.cacheWrite ?? 0 },
      },
      finish: m.stopReason ?? 'stop',
      error: m.errorMessage
        ? {
            name: 'UnknownError',
            data: { message: m.errorMessage },
          }
        : undefined,
    }

    const parts: UiPart[] = []
    if (thinking) {
      parts.push({
        id: newPartId(),
        sessionID,
        messageID,
        type: 'reasoning',
        text: thinking,
        time: { start: created, end: created },
      })
    }
    if (text) {
      parts.push({
        id: newPartId(),
        sessionID,
        messageID,
        type: 'text',
        text,
        time: { start: created, end: created },
      })
    }

    // tool calls on assistant message
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || typeof block !== 'object') continue
        const b = block as { type?: string; id?: string; name?: string; arguments?: unknown }
        if (b.type === 'toolCall') {
          parts.push({
            id: newPartId(),
            sessionID,
            messageID,
            type: 'tool',
            callID: b.id ?? newPartId(),
            tool: b.name ?? 'tool',
            state: {
              status: 'completed',
              input: b.arguments ?? {},
              output: '',
              title: b.name ?? 'tool',
              metadata: {},
              time: { start: created, end: created },
            },
          })
        }
      }
    }

    return { info, parts }
  }

  // toolResult / other → synthetic assistant tool part message
  const toolMsg = message as {
    toolCallId?: string
    toolName?: string
    content?: unknown
    isError?: boolean
    timestamp?: number
  }
  const info: UiMessage = {
    id: messageID,
    sessionID,
    role: 'assistant',
    time: { created: toolMsg.timestamp ?? Date.now(), completed: Date.now() },
    parentID: '',
    modelID: 'default',
    providerID: 'pi',
    mode: 'build',
    agent: 'pi',
    path: { cwd: opts?.cwd ?? process.cwd(), root: opts?.cwd ?? process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: 'tool-calls',
  }
  const output = contentToText(toolMsg.content) || JSON.stringify(toolMsg.content ?? '')
  const parts: UiPart[] = [
    {
      id: newPartId(),
      sessionID,
      messageID,
      type: 'tool',
      callID: toolMsg.toolCallId ?? newPartId(),
      tool: toolMsg.toolName ?? 'tool',
      state: {
        status: toolMsg.isError ? 'error' : 'completed',
        input: {},
        output: toolMsg.isError ? undefined : output,
        error: toolMsg.isError ? output : undefined,
        title: toolMsg.toolName ?? 'tool',
        metadata: {},
        time: { start: info.time.created, end: Date.now() },
      },
    },
  ]
  return { info, parts }
}

export function makeUserMessage(
  sessionID: string,
  text: string,
  opts?: {
    messageId?: string
    providerID?: string
    modelID?: string
    agent?: string
  },
): MessageWithParts {
  const messageID = opts?.messageId ?? newMessageId()
  const created = Date.now()
  return {
    info: {
      id: messageID,
      sessionID,
      role: 'user',
      time: { created },
      agent: opts?.agent ?? 'pi',
      model: {
        providerID: opts?.providerID ?? 'pi',
        modelID: opts?.modelID ?? 'default',
      },
    },
    parts: [
      {
        id: newPartId(),
        sessionID,
        messageID,
        type: 'text',
        text,
        time: { start: created },
      },
    ],
  }
}

export function makeAssistantShell(
  sessionID: string,
  opts?: {
    messageId?: string
    parentID?: string
    providerID?: string
    modelID?: string
    cwd?: string
  },
): MessageWithParts {
  const messageID = opts?.messageId ?? newMessageId()
  const created = Date.now()
  const textPartId = newPartId()
  const reasoningPartId = newPartId()
  return {
    info: {
      id: messageID,
      sessionID,
      role: 'assistant',
      time: { created },
      parentID: opts?.parentID ?? '',
      modelID: opts?.modelID ?? 'default',
      providerID: opts?.providerID ?? 'pi',
      mode: 'build',
      agent: 'pi',
      path: { cwd: opts?.cwd ?? process.cwd(), root: opts?.cwd ?? process.cwd() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: reasoningPartId,
        sessionID,
        messageID,
        type: 'reasoning',
        text: '',
        time: { start: created },
      },
      {
        id: textPartId,
        sessionID,
        messageID,
        type: 'text',
        text: '',
        time: { start: created },
      },
    ],
  }
}
