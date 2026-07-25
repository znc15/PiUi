export type {
  MCPStatus,
  MCPStatusConnected,
  MCPStatusDisabled,
  MCPStatusFailed,
  MCPStatusNeedsAuth,
  MCPStatusNeedsClientRegistration,
  MCPResource,
  MCPStatusResponse,
  McpServerConfig,
} from './generated'

export type MCPResourceMap = Record<string, import('./generated').MCPResource>
