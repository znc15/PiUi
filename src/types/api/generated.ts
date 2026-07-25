// Local OpenCode-compatible API types for the Pi bridge.
// These are intentionally UI-facing and tolerant: Pi bridge implements the
// OpenCode-shaped surface, but many advanced OpenCode fields are optional.

// ---- Common ----
export type ErrorInfo = { name?: string; data?: unknown; message?: string }
export type ProviderAuthError = ErrorInfo
export type UnknownError = ErrorInfo
export type MessageOutputLengthError = ErrorInfo
export type MessageAbortedError = ErrorInfo
export type APIError = ErrorInfo

// ---- Model / provider ----
export type ModelStatus = 'active' | 'disabled' | string
export type ModelLimit = { context?: number; output?: number }
export type ModelIOCapabilities = { text?: boolean; image?: boolean; pdf?: boolean; audio?: boolean; video?: boolean }
export type ModelCapabilities = {
  reasoning?: boolean
  toolcall?: boolean
  input?: ModelIOCapabilities
  output?: ModelIOCapabilities
  [key: string]: unknown
}
export type Model = {
  id: string
  providerID?: string
  api?: string
  name?: string
  family?: string
  capabilities?: ModelCapabilities
  cost?: Record<string, unknown>
  limit?: ModelLimit
  status?: ModelStatus
  options?: Record<string, unknown>
  headers?: Record<string, string>
  release_date?: string
  variants?: Record<string, unknown>
}
export type ProviderAuthMethod = unknown
export type ProviderAuthAuthorization = unknown
export type Provider = {
  id: string
  name?: string
  source?: string
  env?: string[]
  key?: string
  options?: Record<string, unknown>
  models?: Record<string, Model>
}
export type ProvidersResponse = { providers: Provider[]; default: Record<string, string> }

// ---- Project / path ----
export type ProjectIcon = { url?: string; override?: string; color?: string }
export type ProjectCommands = Record<string, string>
export type Project = {
  id: string
  worktree: string
  vcs?: string
  name: string
  icon?: ProjectIcon
  commands?: ProjectCommands
  time?: { created?: number; updated?: number }
  sandboxes?: unknown
}
export type ProjectUpdateParams = { name?: string; icon?: ProjectIcon }
export type Path = { home: string; state: string; config: string; worktree: string; directory: string }
export type PathResponse = Path

// ---- File / search ----
export type FileNodeType = 'file' | 'directory'
export type FileNode = { name: string; path: string; absolute: string; type: FileNodeType; ignored?: boolean }
export type FileContent = {
  type?: string
  content: string
  diff?: string
  patch?: string
  encoding?: string
  mimeType?: string
}
export type FileStatusItem = { path: string; added?: number; removed?: number; status: string }
export type File = FileStatusItem
export type FileDiff = {
  file: string
  before?: string
  after?: string
  additions: number
  deletions: number
  patch?: string
  status?: string
}
export type FilePatch = unknown
export type PatchHunk = unknown
export type SymbolLocation = unknown
export type SymbolRange = unknown
export type Symbol = { name: string; kind?: number; path?: string; location?: SymbolLocation; range?: SymbolRange }
export type TextSearchMatch = {
  path: { text: string }
  lines: { text: string }
  line_number?: number
  absolute_offset?: number
  submatches: Array<{ match: { text: string }; start: number; end: number }>
}

// ---- Messages ----
export type MessageSummary = { diffs?: FileDiff[]; additions?: number; deletions?: number; files?: number; [key: string]: any }
export type FilePartSourceText = { value: string; start: number; end: number }
export type FileSource = { text?: FilePartSourceText; type?: string; path?: string }
export type FilePartSource = FileSource
export type FileSourceType = string

export type UserMessage = {
  id: string
  sessionID: string
  role: 'user'
  time: { created: number; completed?: number }
  summary?: MessageSummary
  agent?: string
  model?: { providerID?: string; modelID?: string }
  system?: string[]
  tools?: Record<string, boolean>
  variant?: string
}
export type AssistantMessage = {
  id: string
  sessionID: string
  role: 'assistant'
  time: { created: number; completed?: number }
  error?: ErrorInfo
  parentID?: string
  modelID?: string
  providerID?: string
  mode?: string
  agent?: string
  path?: { cwd?: string; root?: string }
  summary?: boolean | MessageSummary
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  finish?: string
}
export type Message = UserMessage | AssistantMessage

export type BasePart = { id: string; sessionID: string; messageID: string; type: string; time?: { start?: number; end?: number }; metadata?: Record<string, unknown> }
export type TextPart = BasePart & { type: 'text'; text: string; synthetic?: boolean; ignored?: boolean }
export type ReasoningPart = BasePart & { type: 'reasoning'; text: string }
export type ToolStatePending = { status: 'pending'; input?: unknown; raw?: string; [key: string]: unknown }
export type ToolStateRunning = { status: 'running'; input?: unknown; title?: string; metadata?: Record<string, unknown>; time?: { start?: number; end?: number }; [key: string]: unknown }
export type ToolStateCompleted = { status: 'completed'; input?: unknown; output?: unknown; title?: string; metadata?: Record<string, unknown>; time?: { start?: number; end?: number }; attachments?: unknown[]; [key: string]: unknown }
export type ToolStateError = { status: 'error'; input?: unknown; error?: unknown; metadata?: Record<string, unknown>; time?: { start?: number; end?: number }; [key: string]: unknown }
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError
export type ToolPart = BasePart & { type: 'tool'; callID?: string; tool: string; state: ToolState }
export type FilePart = BasePart & { type: 'file'; mime?: string; filename?: string; url?: string; source?: FilePartSource }
export type AgentPart = BasePart & { type: 'agent'; name: string; source?: FilePartSourceText }
export type StepStartPart = BasePart & { type: 'step-start'; snapshot?: string }
export type StepFinishPart = BasePart & { type: 'step-finish'; reason?: string; snapshot?: string; cost?: number; tokens?: unknown }
export type SnapshotPart = BasePart & { type: 'snapshot'; snapshot?: string }
export type PatchPart = BasePart & { type: 'patch'; hash?: string; files?: FileDiff[] }
export type SubtaskPart = BasePart & { type: 'subtask'; prompt: string; description?: string; agent?: string; model?: { providerID: string; modelID: string }; command?: string }
export type RetryPart = BasePart & { type: 'retry'; attempt?: number; error?: unknown }
export type CompactionPart = BasePart & { type: 'compaction'; auto?: boolean }
export type Part = TextPart | ReasoningPart | ToolPart | FilePart | AgentPart | StepStartPart | StepFinishPart | SnapshotPart | PatchPart | SubtaskPart | RetryPart | CompactionPart
export type MessageWithParts = { info: Message; parts: Part[] }
export type TextPartInput = { id?: string; type: 'text'; text: string; synthetic?: boolean; ignored?: boolean; time?: unknown; metadata?: unknown }
export type FilePartInput = { id?: string; type: 'file'; mime?: string; filename?: string; url: string; source?: FilePartSource }
export type AgentPartInput = { id?: string; type: 'agent'; name: string; source?: FilePartSourceText }
export type SubtaskPartInput = { id?: string; type: 'subtask'; prompt: string; description?: string; agent?: string; model?: { providerID: string; modelID: string }; command?: string }

// ---- Session ----
export type SessionStatus = { type: 'idle' } | { type: 'busy' } | { type: 'retry'; attempt: number; message: string; next: number } | { type: string; [key: string]: any }
export type SessionStatusMap = Record<string, SessionStatus>
export type SessionSummary = { additions: number; deletions: number; files: number; diffs?: FileDiff[]; [key: string]: any }
export type SessionShare = { url?: string; [key: string]: unknown }
export type SessionRevert = { messageID: string; partID?: string }
export type Session = {
  id: string
  slug?: string
  projectID?: string
  directory: string
  parentID?: string
  summary?: SessionSummary
  share?: SessionShare
  title?: string
  version?: string
  time: { created: number; updated: number; archived?: number }
  permission?: unknown
  revert?: SessionRevert
}
export type SessionListParams = { directory?: string; roots?: boolean; start?: number; search?: string; limit?: number }
export type SessionCreateParams = { directory?: string; title?: string; parentID?: string }
export type SessionUpdateParams = { title?: string; time?: { archived?: number } }
export type SessionForkParams = { messageID?: string; directory?: string }

// ---- Permission / question ----
export type PermissionToolInfo = { id?: string; name?: string; callID?: string; input?: any }
export type PermissionRequest = { id: string; sessionID: string; permission: string; patterns: string[]; metadata?: Record<string, any>; always?: string[]; tool?: PermissionToolInfo }
export type PermissionReply = 'once' | 'always' | 'reject' | string
export type QuestionOption = { label: string; value?: string; description?: string }
export type QuestionInfo = { id?: string; header?: string; question?: string; prompt?: string; options: QuestionOption[]; multiple?: boolean; custom?: boolean; [key: string]: any }
export type QuestionRequest = { id: string; sessionID: string; questions: QuestionInfo[]; question?: QuestionInfo; [key: string]: any }
export type QuestionAnswer = any

// ---- Agent / config ----
export type AgentMode = 'subagent' | 'primary' | 'all' | string
export type AgentPermission = unknown
export type Agent = { name: string; description?: string; mode?: AgentMode; native?: boolean; hidden?: boolean; color?: string; permission?: AgentPermission; model?: { providerID?: string; modelID?: string }; options?: Record<string, unknown> }
export type LogLevel = string
export type ServerConfig = { port?: number; hostname?: string; mdns?: boolean; cors?: string[] | string }
export type PermissionConfig = unknown
export type PermissionActionConfig = unknown
export type PermissionObjectConfig = unknown
export type PermissionRuleConfig = unknown
export type AgentConfig = unknown
export type ProviderConfig = unknown
export type McpLocalConfig = { type?: 'local'; command: string | string[]; environment?: Record<string, string>; enabled?: boolean; timeout?: number }
export type McpOAuthConfig = { clientId?: string; clientSecret?: string; scope?: string }
export type McpRemoteConfig = { type?: 'remote'; url?: string; enabled?: boolean; headers?: Record<string, string>; oauth?: McpOAuthConfig; timeout?: number }
export type LayoutConfig = unknown
export type Config = Record<string, unknown> & { server?: ServerConfig; agent?: Record<string, AgentConfig>; provider?: Record<string, ProviderConfig>; mcp?: Record<string, McpLocalConfig | McpRemoteConfig> }

// ---- MCP / skills / pty / vcs / worktree / tools ----
export type MCPStatusConnected = { type: 'connected'; resources?: any[]; tools?: any[]; [key: string]: any }
export type MCPStatusDisabled = { type: 'disabled'; [key: string]: any }
export type MCPStatusFailed = { type: 'failed'; error?: string; [key: string]: any }
export type MCPStatusNeedsAuth = { type: 'needs-auth'; [key: string]: any }
export type MCPStatusNeedsClientRegistration = { type: 'needs-client-registration'; [key: string]: any }
export type MCPStatus = MCPStatusConnected | MCPStatusDisabled | MCPStatusFailed | MCPStatusNeedsAuth | MCPStatusNeedsClientRegistration | { type: string; [key: string]: any }
export type MCPResource = { uri: string; name: string; mimeType?: string; text?: string; blob?: string; client: string; [key: string]: any }
export type MCPStatusResponse = Record<string, MCPStatus>
export type McpServerConfig = McpLocalConfig | McpRemoteConfig
export type Skill = { name: string; description?: string; location?: string; content?: string }
export type SkillList = Skill[]
export type Pty = { id: string; title?: string; command?: string; args?: string[]; cwd?: string; status: 'running' | 'exited' | string; pid?: number }
export type PtySize = { rows?: number; cols?: number }
export type PtyCreateParams = { command?: string; args?: string[]; cwd?: string; title?: string; env?: Record<string, string> }
export type PtyUpdateParams = { title?: string; size?: PtySize }
export type VcsInfo = { branch?: string; default_branch?: string }
export type VcsDiffMode = string
export type Worktree = { name?: string; path?: string; directory?: string; branch?: string }
export type WorktreeCreateInput = { name?: string; directory?: string }
export type WorktreeRemoveInput = { directory?: string }
export type WorktreeResetInput = { directory?: string }
export type ToolIDs = string[]
export type ToolListItem = { id: string; description?: string }
export type ToolList = ToolListItem[]

// ---- Events ----
export type ServerConnectedPayload = { timestamp?: unknown }
export type SessionIdlePayload = { sessionID: string }
export type SessionErrorPayload = { sessionID: string; name: string; data: unknown }
export type SessionStatusPayload = { sessionID: string; status: SessionStatus }
export type SessionDiffPayload = { sessionID: string; diff: FileDiff[] }
export type PartDeltaPayload = { sessionID: string; messageID: string; partID: string; field: string; delta: string }
export type PartRemovedPayload = { sessionID: string; messageID: string; partID: string }
export type PermissionRepliedPayload = { sessionID: string; requestID: string; reply: string }
export type QuestionRepliedPayload = { sessionID: string; requestID: string }
export type QuestionRejectedPayload = { sessionID: string; requestID: string }
export type Todo = { id?: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | string; priority: 'high' | 'medium' | 'low' | string }
export type TodoItem = Todo & { id: string }
export type TodoUpdatedPayload = { sessionID: string; todos: TodoItem[] }
export type WorktreeReadyPayload = { name?: string; directory?: string; branch?: string }
export type WorktreeFailedPayload = { message?: string }
export type VcsBranchUpdatedPayload = { branch?: string; directory?: string }

export type Event = { type: string; properties: any }
export type GlobalEvent = { directory: string; payload: { type: string; properties: any } }
export type EventType = string
export const EventTypes = {
  SESSION_CREATED: 'session.created',
  SESSION_UPDATED: 'session.updated',
  SESSION_DELETED: 'session.deleted',
  SESSION_IDLE: 'session.idle',
  SESSION_ERROR: 'session.error',
  SESSION_STATUS: 'session.status',
  SESSION_DIFF: 'session.diff',
  SESSION_COMPACTED: 'session.compacted',
  MESSAGE_UPDATED: 'message.updated',
  MESSAGE_REMOVED: 'message.removed',
  MESSAGE_PART_UPDATED: 'message.part.updated',
  MESSAGE_PART_DELTA: 'message.part.delta',
  MESSAGE_PART_REMOVED: 'message.part.removed',
  PERMISSION_ASKED: 'permission.asked',
  PERMISSION_REPLIED: 'permission.replied',
  QUESTION_ASKED: 'question.asked',
  QUESTION_REPLIED: 'question.replied',
  QUESTION_REJECTED: 'question.rejected',
  TODO_UPDATED: 'todo.updated',
  TUI_PROMPT_APPEND: 'tui.prompt.append',
  TUI_COMMAND_EXECUTE: 'tui.command.execute',
  TUI_TOAST_SHOW: 'tui.toast.show',
  TUI_SESSION_SELECT: 'tui.session.select',
  PROJECT_UPDATED: 'project.updated',
  SERVER_CONNECTED: 'server.connected',
  SERVER_INSTANCE_DISPOSED: 'server.instance.disposed',
  GLOBAL_DISPOSED: 'global.disposed',
  FILE_EDITED: 'file.edited',
  FILE_WATCHER_UPDATED: 'file.watcher.updated',
  INSTALLATION_UPDATED: 'installation.updated',
  INSTALLATION_UPDATE_AVAILABLE: 'installation.update-available',
  WORKTREE_READY: 'worktree.ready',
  WORKTREE_FAILED: 'worktree.failed',
  WORKSPACE_READY: 'workspace.ready',
  WORKSPACE_FAILED: 'workspace.failed',
  LSP_UPDATED: 'lsp.updated',
  MCP_TOOLS_CHANGED: 'mcp.tools.changed',
  MCP_BROWSER_OPEN_FAILED: 'mcp.browser.open.failed',
  VCS_BRANCH_UPDATED: 'vcs.branch.updated',
  COMMAND_EXECUTED: 'command.executed',
  PTY_CREATED: 'pty.created',
  PTY_UPDATED: 'pty.updated',
  PTY_EXITED: 'pty.exited',
  PTY_DELETED: 'pty.deleted',
} as const

export interface EventCallbacks {
  onMessageUpdated?: (message: Message) => void
  onPartUpdated?: (part: Part) => void
  onPartDelta?: (data: PartDeltaPayload) => void
  onPartRemoved?: (data: PartRemovedPayload) => void
  onServerConnected?: (data: ServerConnectedPayload) => void
  onSessionCreated?: (session: Session) => void
  onSessionUpdated?: (session: Session) => void
  onSessionDeleted?: (sessionId: string) => void
  onSessionIdle?: (data: SessionIdlePayload) => void
  onSessionError?: (data: SessionErrorPayload) => void
  onSessionStatus?: (data: SessionStatusPayload) => void
  onPermissionAsked?: (request: PermissionRequest) => void
  onPermissionReplied?: (data: PermissionRepliedPayload) => void
  onQuestionAsked?: (request: QuestionRequest) => void
  onQuestionReplied?: (data: QuestionRepliedPayload) => void
  onQuestionRejected?: (data: QuestionRejectedPayload) => void
  onTodoUpdated?: (data: TodoUpdatedPayload) => void
  onProjectUpdated?: (project: Project) => void
  onWorktreeReady?: (data: WorktreeReadyPayload) => void
  onWorktreeFailed?: (data: WorktreeFailedPayload) => void
  onVcsBranchUpdated?: (data: VcsBranchUpdatedPayload) => void
  onError?: (error: Error) => void
  onReconnected?: (reason: 'network' | 'server-switch') => void
}
