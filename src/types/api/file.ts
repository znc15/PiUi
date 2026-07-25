export type {
  FileNode,
  FileNodeType,
  FileContent,
  FileDiff,
  FileStatusItem,
  FilePatch,
  PatchHunk,
  Symbol,
  SymbolLocation,
  SymbolRange,
  TextSearchMatch,
} from './generated'

/** 过滤缺少 file 字段的异常 diff 项 */
export function normalizeFileDiffs(value: unknown): import('./generated').FileDiff[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is import('./generated').FileDiff => {
    return !!item && typeof item === 'object' && typeof (item as { file?: unknown }).file === 'string'
  })
}
