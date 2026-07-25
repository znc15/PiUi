// ============================================
// LSP API - Language Server Protocol 状态
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { formatPathForApi } from '../utils/directoryUtils'

export interface LSPStatus {
  running: boolean
  language?: string
  capabilities?: string[]
}

interface LspStatusItem {
  id?: string
  name?: string
  root?: string
  status?: string
}

/**
 * 获取 LSP 服务状态
 */
export async function getLspStatus(directory?: string): Promise<LSPStatus> {
  const sdk = getSDKClient()
  const result = unwrap<LspStatusItem[]>(await sdk.lsp.status({ directory: formatPathForApi(directory) }))
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0]
    return {
      running: first.status === 'connected',
      language: first.name,
    }
  }
  return { running: false }
}

export interface FormatterStatus {
  available: boolean
  name?: string
}

/**
 * 获取格式化器状态（pi 后端暂不提供，返回空）
 */
export async function getFormatterStatus(_directory?: string): Promise<FormatterStatus> {
  return { available: false }
}
