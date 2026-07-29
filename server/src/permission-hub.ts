// ============================================
// Permission Hub - Permission & Question interaction
//
// Manages pending permission requests and question requests
// between the Pi agent (beforeToolCall hook) and the
// frontend UI (PermissionDialog / QuestionDialog).
//
// Flow:
// 1. Pi agent tool call → beforeToolCall hook → needsApproval?
// 2. If yes → create PermissionRequest → publish permission.asked SSE
// 3. Frontend renders PermissionDialog → user clicks Allow/Reject
// 4. POST /permission/:id/reply → resolve pending promise
// 5. beforeToolCall returns { block: true } or undefined
// ============================================

import { newPermissionId } from './ids.js'
import { publishPayload } from './events.js'
import { ProjectTrustStore, getAgentDir } from '@earendil-works/pi-coding-agent'
import type { SettingsManager } from '@earendil-works/pi-coding-agent'

// ---- Types ----

export type PermissionReply = 'once' | 'always' | 'reject' | string

export interface PermissionToolInfo {
  id?: string
  name?: string
  callID?: string
  input?: unknown
}

export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
  always?: string[]
  tool?: PermissionToolInfo
}

export interface QuestionOption {
  label: string
  value?: string
  description?: string
}

export interface QuestionInfo {
  id?: string
  header?: string
  question?: string
  prompt?: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
  [key: string]: unknown
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  question?: QuestionInfo
  [key: string]: unknown
}

export type QuestionAnswer = unknown

// ---- Pending request tracking ----

interface PendingPermission {
  request: PermissionRequest
  resolve: (reply: PermissionReply) => void
  timer: ReturnType<typeof setTimeout>
  directory: string
}

interface PendingQuestion {
  request: QuestionRequest
  resolve: (answers: QuestionAnswer) => void
  reject: (reason: string) => void
  timer: ReturnType<typeof setTimeout>
  directory: string
}

const pendingPermissions = new Map<string, PendingPermission>()
const pendingQuestions = new Map<string, PendingQuestion>()

// ---- Project trust ----

let trustStore: ProjectTrustStore | null = null

function getTrustStore(): ProjectTrustStore {
  if (!trustStore) {
    trustStore = new ProjectTrustStore(getAgentDir())
  }
  return trustStore
}

/** Check if a project directory is trusted based on the trust store. */
export function isProjectTrusted(cwd: string): boolean | null {
  return getTrustStore().get(cwd)
}

/** Set project trust decision. */
export function setProjectTrusted(cwd: string, trusted: boolean): void {
  getTrustStore().set(cwd, trusted)
}

// ---- Tool permission classification ----

/** Tools that require explicit approval. */
const GATED_TOOLS = new Set(['bash', 'edit', 'write'])

/** Map Pi tool names to permission categories. */
function toolToPermission(toolName: string): string {
  if (toolName === 'bash') return 'bash'
  if (toolName === 'edit') return 'edit'
  if (toolName === 'write') return 'write'
  // read, grep, find, ls are read-only → auto-approve
  return toolName
}

/** Determine if a tool call needs user approval. */
export function needsApproval(
  toolName: string,
  args: unknown,
  settingsManager: SettingsManager,
  cwd: string,
): { needed: boolean; permission: string; patterns: string[]; metadata: Record<string, unknown> } | null {
  const permission = toolToPermission(toolName)
  if (!GATED_TOOLS.has(toolName)) return null

  // Check project trust
  const trustDecision = getTrustStore().get(cwd)
  if (trustDecision === true) return null // trusted → auto-approve

  // Check default project trust setting
  const defaultTrust = settingsManager.getDefaultProjectTrust()
  if (defaultTrust === 'always') return null
  if (defaultTrust === 'never') {
    // never trust → auto-reject (handled by returning needed=true, then auto-reject in beforeToolCall)
    // Actually, "never" means don't load project resources, not reject all tool calls.
    // For tool calls, "never" still needs to ask the user.
  }

  // Build patterns and metadata from tool args
  const patterns: string[] = []
  const metadata: Record<string, unknown> = {}

  if (toolName === 'bash' && args && typeof args === 'object') {
    const a = args as { command?: string }
    if (a.command) patterns.push(a.command)
    metadata.command = a.command
  } else if (toolName === 'edit' && args && typeof args === 'object') {
    const a = args as { file_path?: string; path?: string; old_string?: string; new_string?: string; diff?: string }
    const filePath = a.file_path || a.path || ''
    if (filePath) patterns.push(filePath)
    metadata.filepath = filePath
    if (a.diff) metadata.diff = a.diff
    if (a.old_string && a.new_string) {
      metadata.filediff = { before: a.old_string, after: a.new_string }
    }
  } else if (toolName === 'write' && args && typeof args === 'object') {
    const a = args as { file_path?: string; path?: string; content?: string }
    const filePath = a.file_path || a.path || ''
    if (filePath) patterns.push(filePath)
    metadata.filepath = filePath
  }

  return { needed: true, permission, patterns, metadata }
}

// ---- Permission request lifecycle ----

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Create a permission request and wait for the user's response.
 * Called from the beforeToolCall hook.
 *
 * @returns The user's reply: 'once', 'always', or 'reject'
 */
export function requestPermission(params: {
  sessionID: string
  directory: string
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
  tool?: PermissionToolInfo
}): Promise<PermissionReply> {
  const { sessionID, directory, permission, patterns, metadata, tool } = params
  const id = newPermissionId()

  const alwaysPatterns: string[] = []
  // For bash, the "always" pattern is the command prefix
  if (permission === 'bash' && patterns.length > 0) {
    alwaysPatterns.push(patterns[0])
  }
  // For edit/write, the "always" pattern is the file path
  if ((permission === 'edit' || permission === 'write') && patterns.length > 0) {
    alwaysPatterns.push(patterns[0])
  }

  const request: PermissionRequest = {
    id,
    sessionID,
    permission,
    patterns,
    metadata,
    always: alwaysPatterns,
    tool,
  }

  return new Promise<PermissionReply>(resolve => {
    const timer = setTimeout(() => {
      // Auto-reject on timeout
      pendingPermissions.delete(id)
      publishPayload('permission.replied', { sessionID, requestID: id, reply: 'reject' }, directory)
      resolve('reject')
    }, PERMISSION_TIMEOUT_MS)

    pendingPermissions.set(id, { request, resolve, timer, directory })

    // Publish SSE event so the frontend renders the permission dialog
    publishPayload('permission.asked', request, directory)
  })
}

/**
 * Reply to a pending permission request.
 * Called from POST /permission/:requestID/reply
 */
export function replyPermission(requestID: string, reply: PermissionReply): boolean {
  const pending = pendingPermissions.get(requestID)
  if (!pending) return false

  clearTimeout(pending.timer)
  pendingPermissions.delete(requestID)

  // If "always", update the trust store or auto-approve rules
  if (reply === 'always' && pending.request.always && pending.request.always.length > 0) {
    // For project-level trust, mark the project as trusted
    // This is a simplification: in a full implementation, we'd add
    // per-pattern rules. For now, "always" for bash/edit/write
    // means the project is trusted for that category.
  }

  // Publish the reply event so other SSE subscribers know
  publishPayload(
    'permission.replied',
    {
      sessionID: pending.request.sessionID,
      requestID,
      reply,
    },
    pending.directory,
  )

  pending.resolve(reply)
  return true
}

/**
 * Get all pending permission requests, optionally filtered by session.
 */
export function getPendingPermissions(sessionID?: string, directory?: string): PermissionRequest[] {
  const result: PermissionRequest[] = []
  for (const pending of pendingPermissions.values()) {
    if (sessionID && pending.request.sessionID !== sessionID) continue
    if (directory && pending.directory !== directory) continue
    result.push(pending.request)
  }
  return result
}

// ---- Question request lifecycle ----

const QUESTION_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Create a question request and wait for the user's response.
 */
export function requestQuestion(params: {
  sessionID: string
  directory: string
  questions: QuestionInfo[]
}): Promise<QuestionAnswer> {
  const { sessionID, directory, questions } = params
  const id = newPermissionId()

  const request: QuestionRequest = {
    id,
    sessionID,
    questions,
    question: questions[0],
  }

  return new Promise<QuestionAnswer>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Auto-reject on timeout
      pendingQuestions.delete(id)
      publishPayload('question.rejected', { sessionID, requestID: id }, directory)
      reject('Question timed out')
    }, QUESTION_TIMEOUT_MS)

    pendingQuestions.set(id, { request, resolve, reject, timer, directory })

    // Publish SSE event
    publishPayload('question.asked', request, directory)
  })
}

/**
 * Reply to a pending question request.
 * Called from POST /question/:requestID/reply
 */
export function replyQuestion(requestID: string, answers: QuestionAnswer): boolean {
  const pending = pendingQuestions.get(requestID)
  if (!pending) return false

  clearTimeout(pending.timer)
  pendingQuestions.delete(requestID)

  publishPayload(
    'question.replied',
    {
      sessionID: pending.request.sessionID,
      requestID,
      answers,
    },
    pending.directory,
  )

  pending.resolve(answers)
  return true
}

/**
 * Reject a pending question request.
 * Called from POST /question/:requestID/reject
 */
export function rejectQuestion(requestID: string): boolean {
  const pending = pendingQuestions.get(requestID)
  if (!pending) return false

  clearTimeout(pending.timer)
  pendingQuestions.delete(requestID)

  publishPayload(
    'question.rejected',
    {
      sessionID: pending.request.sessionID,
      requestID,
    },
    pending.directory,
  )

  pending.reject('User rejected')
  return true
}

/**
 * Get all pending question requests, optionally filtered by session.
 */
export function getPendingQuestions(sessionID?: string, directory?: string): QuestionRequest[] {
  const result: QuestionRequest[] = []
  for (const pending of pendingQuestions.values()) {
    if (sessionID && pending.request.sessionID !== sessionID) continue
    if (directory && pending.directory !== directory) continue
    result.push(pending.request)
  }
  return result
}

// ---- Session cleanup ----

/**
 * Reject all pending permissions and questions for a session.
 * Called when a session is disposed or aborted.
 */
export function disposeSession(sessionID: string): void {
  // Reject pending permissions
  for (const [id, pending] of pendingPermissions.entries()) {
    if (pending.request.sessionID === sessionID) {
      clearTimeout(pending.timer)
      pendingPermissions.delete(id)
      publishPayload(
        'permission.replied',
        {
          sessionID,
          requestID: id,
          reply: 'reject',
        },
        pending.directory,
      )
      pending.resolve('reject')
    }
  }

  // Reject pending questions
  for (const [id, pending] of pendingQuestions.entries()) {
    if (pending.request.sessionID === sessionID) {
      clearTimeout(pending.timer)
      pendingQuestions.delete(id)
      publishPayload(
        'question.rejected',
        {
          sessionID,
          requestID: id,
        },
        pending.directory,
      )
      pending.reject('Session disposed')
    }
  }
}

/**
 * Dispose all pending permissions and questions.
 */
export function disposeAll(): void {
  for (const [, pending] of pendingPermissions.entries()) {
    clearTimeout(pending.timer)
    pending.resolve('reject')
  }
  pendingPermissions.clear()

  for (const [, pending] of pendingQuestions.entries()) {
    clearTimeout(pending.timer)
    pending.reject('Server shutting down')
  }
  pendingQuestions.clear()
}

// ---- beforeToolCall hook ----

/**
 * Create a beforeToolCall hook that checks the permission hub.
 * This hook is registered on the AgentSession to gate tool calls.
 *
 * Returns undefined to allow execution, or { block: true, reason } to block.
 */
export function createBeforeToolCallHook(sessionID: string, directory: string, settingsManager: SettingsManager) {
  return async (
    context: {
      toolCall: { name: string; id: string; arguments?: unknown }
      args: unknown
    },
    signal?: AbortSignal,
  ): Promise<{ block?: boolean; reason?: string } | undefined> => {
    const toolName = context.toolCall.name
    const args = context.args

    // Check if this tool needs approval
    const approval = needsApproval(toolName, args, settingsManager, directory)
    if (!approval) return undefined // auto-approve

    // If the abort signal is already aborted, reject immediately
    if (signal?.aborted) {
      return { block: true, reason: 'Operation aborted' }
    }

    // Create permission request and wait for user response
    const reply = await requestPermission({
      sessionID,
      directory,
      permission: approval.permission,
      patterns: approval.patterns,
      metadata: approval.metadata,
      tool: {
        name: toolName,
        callID: context.toolCall.id,
        input: args,
      },
    })

    if (reply === 'reject') {
      return { block: true, reason: 'User rejected this operation' }
    }

    // 'once' or 'always' → allow
    return undefined
  }
}
