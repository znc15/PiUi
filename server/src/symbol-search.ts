// ============================================
// Symbol Search — ripgrep-based symbol definition search
//
// Searches for function/class/interface/type/enum/const definitions
// using ripgrep with JSON output mode. Falls back gracefully if
// rg is not available.
// ============================================

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { getDefaultWorkspace } from './session-hub.js'

// ---- Frontend-facing types ----

export interface SymbolResult {
  name: string
  kind?: number
  path?: string
  location?: unknown
  range?: unknown
}

// ---- Symbol kind mapping (LSP-compatible) ----

const KIND_FUNCTION = 12
const KIND_CLASS = 5
const KIND_INTERFACE = 8
const KIND_TYPE = 22
const KIND_ENUM = 10
const KIND_VARIABLE = 13
const KIND_CONSTANT = 14

// ---- Pattern definitions ----
//
// Each entry defines a keyword prefix and the kind of symbol it produces.
// We search for lines starting with optional modifiers + keyword + identifier.
// The identifier is extracted from the matched line text after the keyword.

interface SymbolDef {
  /** The keyword that introduces this symbol (e.g. 'function', 'class') */
  keyword: string
  /** LSP symbol kind */
  kind: number
  /** File extensions this applies to */
  extensions: string[]
  /**
   * Optional regex to extract the identifier from the line.
   * If not provided, the first word after the keyword is used.
   * The regex should have a capture group for the identifier name.
   */
  extractPattern?: string
}

const SYMBOL_DEFS: SymbolDef[] = [
  // TypeScript / JavaScript
  { keyword: 'function', kind: KIND_FUNCTION, extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'] },
  { keyword: 'class', kind: KIND_CLASS, extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'] },
  { keyword: 'interface', kind: KIND_INTERFACE, extensions: ['.ts', '.tsx'] },
  { keyword: 'type', kind: KIND_TYPE, extensions: ['.ts', '.tsx'], extractPattern: '^type\\s+([A-Za-z_$][\\w$]*)\\s*=' },
  { keyword: 'enum', kind: KIND_ENUM, extensions: ['.ts', '.tsx'] },
  { keyword: 'const', kind: KIND_CONSTANT, extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'] },
  { keyword: 'let', kind: KIND_VARIABLE, extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'] },
  { keyword: 'var', kind: KIND_VARIABLE, extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'] },

  // Python
  { keyword: 'def', kind: KIND_FUNCTION, extensions: ['.py', '.pyw'] },
  { keyword: 'class', kind: KIND_CLASS, extensions: ['.py', '.pyw'] },

  // Rust
  { keyword: 'fn', kind: KIND_FUNCTION, extensions: ['.rs'] },
  { keyword: 'struct', kind: KIND_CLASS, extensions: ['.rs'] },
  { keyword: 'trait', kind: KIND_INTERFACE, extensions: ['.rs'] },
  { keyword: 'const', kind: KIND_CONSTANT, extensions: ['.rs'] },

  // Go
  { keyword: 'func', kind: KIND_FUNCTION, extensions: ['.go'] },
  { keyword: 'type', kind: KIND_CLASS, extensions: ['.go'], extractPattern: '^type\\s+([A-Za-z_][\\w]*)\\s+(struct|interface)' },
  { keyword: 'const', kind: KIND_CONSTANT, extensions: ['.go'] },
  { keyword: 'var', kind: KIND_VARIABLE, extensions: ['.go'] },

  // Java / Kotlin
  { keyword: 'class', kind: KIND_CLASS, extensions: ['.java', '.kt'] },
  { keyword: 'interface', kind: KIND_INTERFACE, extensions: ['.java', '.kt'] },
  { keyword: 'enum', kind: KIND_ENUM, extensions: ['.java', '.kt'] },
  { keyword: 'fun', kind: KIND_FUNCTION, extensions: ['.kt'] },

  // C / C++
  { keyword: 'class', kind: KIND_CLASS, extensions: ['.cpp', '.hpp', '.cc', '.cxx', '.h'] },
  { keyword: 'struct', kind: KIND_CLASS, extensions: ['.cpp', '.hpp', '.cc', '.cxx', '.h'] },
  { keyword: 'enum', kind: KIND_ENUM, extensions: ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx'] },

  // Ruby
  { keyword: 'def', kind: KIND_FUNCTION, extensions: ['.rb'] },
  { keyword: 'class', kind: KIND_CLASS, extensions: ['.rb'] },
  { keyword: 'module', kind: KIND_CLASS, extensions: ['.rb'] },

  // Swift
  { keyword: 'func', kind: KIND_FUNCTION, extensions: ['.swift'] },
  { keyword: 'class', kind: KIND_CLASS, extensions: ['.swift'] },
  { keyword: 'struct', kind: KIND_CLASS, extensions: ['.swift'] },
  { keyword: 'protocol', kind: KIND_INTERFACE, extensions: ['.swift'] },
  { keyword: 'enum', kind: KIND_ENUM, extensions: ['.swift'] },
  { keyword: 'let', kind: KIND_CONSTANT, extensions: ['.swift'] },
  { keyword: 'var', kind: KIND_VARIABLE, extensions: ['.swift'] },
]

// ---- rg availability check ----

let rgAvailable: boolean | null = null

function isRgAvailable(): boolean {
  if (rgAvailable !== null) return rgAvailable
  try {
    execFileSync('rg', ['--version'], { stdio: 'pipe', timeout: 5000 })
    rgAvailable = true
  } catch {
    rgAvailable = false
  }
  return rgAvailable
}

// ---- Identifier extraction ----

/**
 * Extract the identifier name from a line that matches a symbol definition.
 * Strips leading modifiers (export, default, async, pub, public, static, etc.)
 * and the keyword, then takes the first identifier token.
 */
function extractIdentifier(lineText: string, keyword: string): string | null {
  // Remove leading modifiers and the keyword, then capture the identifier
  // Common modifiers across languages
  const modifiers = [
    'export', 'declare', 'default', 'abstract', 'async', 'final', 'static',
    'public', 'private', 'protected', 'internal', 'override', 'synchronized',
    'pub', 'inline', 'volatile', 'transient', 'native', 'strictfp',
  ]
  const modifierPattern = modifiers.map(m => `${m}\\s+`).join('|')
  const pattern = new RegExp(
    `^(?:${modifierPattern})*${keyword}\\s+(?:\\*\\s+)?([A-Za-z_$@][\\w$]*)`,
  )
  const match = pattern.exec(lineText)
  return match ? match[1] : null
}

// ---- Search implementation ----

interface RgMatch {
  type: 'match'
  data: {
    path: { text: string }
    lines: { text: string }
    line_number: number
    absolute_offset: number
    submatches: Array<{
      match: { text: string }
      start: number
      end: number
    }>
  }
}

function buildGlobFilter(extensions: string[]): string {
  const exts = extensions.map(e => e.replace('.', '')).join(',')
  return `*.{${exts}}`
}

/**
 * Search for symbol definitions in the given directory.
 * Uses ripgrep with --json output for structured parsing.
 */
export function searchSymbols(query: string, directory?: string): SymbolResult[] {
  if (!query || query.trim().length === 0) return []

  const cwd = path.resolve(directory || getDefaultWorkspace())

  if (!isRgAvailable()) {
    return []
  }

  const results: SymbolResult[] = []
  const seen = new Set<string>() // deduplicate by name+path
  const lowerQuery = query.toLowerCase()

  // Group definitions by extension set to batch rg calls
  const extGroups = new Map<string, SymbolDef[]>()
  for (const def of SYMBOL_DEFS) {
    const key = def.extensions.join(',')
    if (!extGroups.has(key)) extGroups.set(key, [])
    extGroups.get(key)!.push(def)
  }

  for (const [, defs] of extGroups) {
    // Build a combined regex: match lines that start with optional modifiers
    // followed by any of the keywords in this group
    const keywords = [...new Set(defs.map(d => d.keyword))]
    const keywordPattern = keywords.join('|')

    // Build the glob filter from the first def's extensions
    const glob = buildGlobFilter(defs[0].extensions)

    // Regex: start of line, optional modifiers, then one of the keywords
    const modifiers = [
      'export', 'declare', 'default', 'abstract', 'async', 'final', 'static',
      'public', 'private', 'protected', 'internal', 'override', 'synchronized',
      'pub', 'inline', 'volatile', 'transient', 'native', 'strictfp',
    ]
    const modifierAlt = modifiers.map(m => `${m}\\s+`).join('|')
    const combinedPattern = `^(?:${modifierAlt})*(?:${keywordPattern})\\s+`

    let output: string
    try {
      output = execFileSync(
        'rg',
        ['--json', '--no-heading', '--max-count', '500', '--glob', glob, '-e', combinedPattern, '.'],
        {
          cwd,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 10000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
    } catch (e: unknown) {
      const code = e && typeof e === 'object' && 'status' in e ? (e as { status: number }).status : 0
      if (code === 1) continue // no matches
      if (code === 2) continue // error
      continue
    }

    // Parse JSON lines
    const lines = output.split('\n').filter(l => l.trim())
    for (const line of lines) {
      let parsed: RgMatch
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed.type !== 'match') continue

      const { path: matchPath, line_number } = parsed.data
      const filePath = matchPath.text
      const lineText = parsed.data.lines.text

      // Determine which keyword matched and extract the identifier
      for (const def of defs) {
        // Check if this line matches this specific definition
        const name = extractIdentifier(lineText, def.keyword)
        if (!name) continue

        // Filter by query
        if (!name.toLowerCase().includes(lowerQuery)) continue

        // For 'type' in TS, only match if followed by = (type alias, not type annotation)
        if (def.keyword === 'type' && def.extractPattern) {
          try {
            if (!new RegExp(def.extractPattern).test(lineText)) continue
          } catch {
            continue
          }
        }

        // For 'type' in Go, only match if followed by struct|interface
        if (def.keyword === 'type' && def.kind === KIND_CLASS) {
          if (!/type\s+[A-Za-z_][\w]*\s+(struct|interface)/.test(lineText)) continue
        }

        const dedupKey = `${name}::${filePath}::${line_number}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)

        // Find the position of the identifier in the line for range info
        const nameStart = lineText.indexOf(name)
        const nameEnd = nameStart + name.length

        results.push({
          name,
          kind: def.kind,
          path: filePath,
          location: { line: line_number },
          range: {
            start: { line: line_number - 1, character: nameStart },
            end: { line: line_number - 1, character: nameEnd },
          },
        })

        break // only match the first applicable def for this line
      }
    }
  }

  // Sort by relevance: exact match first, then prefix match, then by name length
  results.sort((a, b) => {
    const aExact = a.name.toLowerCase() === lowerQuery ? 0 : a.name.toLowerCase().startsWith(lowerQuery) ? 1 : 2
    const bExact = b.name.toLowerCase() === lowerQuery ? 0 : b.name.toLowerCase().startsWith(lowerQuery) ? 1 : 2
    if (aExact !== bExact) return aExact - bExact
    return a.name.length - b.name.length
  })

  return results.slice(0, 100)
}
