// ============================================
// LSP Hub — Language Server Protocol status
//
// Pi does not run LSP servers, but we detect
// which language servers are available in PATH
// based on the project's file types.
// ============================================

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

const execFileAsync = promisify(execFile)

// Language → file extensions
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py', '.pyi', '.pyw'],
  rust: ['.rs'],
  go: ['.go'],
  java: ['.java'],
  kotlin: ['.kt', '.kts'],
  csharp: ['.cs'],
  ruby: ['.rb', '.erb'],
  cpp: ['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp'],
  dart: ['.dart'],
  elixir: ['.ex', '.exs'],
  haskell: ['.hs'],
  lua: ['.lua'],
  php: ['.php'],
  swift: ['.swift'],
  zig: ['.zig'],
  nix: ['.nix'],
  shell: ['.sh', '.bash', '.zsh'],
}

// Language → known LSP server binaries
const LANGUAGE_SERVERS: Record<string, Array<{ binary: string; name: string; capabilities: string[] }>> = {
  typescript: [
    { binary: 'typescript-language-server', name: 'TypeScript Language Server', capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'diagnostics'] },
    { binary: 'ts-node', name: 'ts-node (basic)', capabilities: ['completion'] },
  ],
  javascript: [
    { binary: 'typescript-language-server', name: 'TypeScript Language Server', capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'diagnostics'] },
  ],
  python: [
    { binary: 'pyright', name: 'Pyright', capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'diagnostics'] },
    { binary: 'pylsp', name: 'Python LSP Server', capabilities: ['completion', 'hover', 'definition', 'references', 'diagnostics'] },
    { binary: 'pyright-langserver', name: 'Pyright LangServer', capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'diagnostics'] },
  ],
  rust: [
    { binary: 'rust-analyzer', name: 'rust-analyzer', capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'diagnostics', 'codeLens'] },
  ],
  go: [
    { binary: 'gopls', name: 'gopls', capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'diagnostics', 'codeLens'] },
  ],
  java: [
    { binary: 'jdtls', name: 'Eclipse JDT Language Server', capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'diagnostics'] },
  ],
  kotlin: [
    { binary: 'kotlin-language-server', name: 'Kotlin Language Server', capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'diagnostics'] },
  ],
  csharp: [
    { binary: 'omnisharp', name: 'OmniSharp', capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'diagnostics'] },
    { binary: 'dotnet', name: 'dotnet (C# via Roslyn)', capabilities: ['completion', 'hover', 'definition', 'references', 'diagnostics'] },
  ],
  ruby: [
    { binary: 'solargraph', name: 'Solargraph', capabilities: ['completion', 'hover', 'definition', 'references', 'diagnostics'] },
  ],
  cpp: [
    { binary: 'clangd', name: 'clangd', capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'diagnostics', 'codeLens'] },
    { binary: 'ccls', name: 'ccls', capabilities: ['completion', 'hover', 'definition', 'references', 'diagnostics'] },
  ],
  dart: [
    { binary: 'dart', name: 'Dart Analysis Server', capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'diagnostics'] },
  ],
  elixir: [
    { binary: 'elixir-ls', name: 'ElixirLS', capabilities: ['completion', 'hover', 'definition', 'references', 'diagnostics'] },
  ],
  haskell: [
    { binary: 'haskell-language-server', name: 'Haskell Language Server', capabilities: ['completion', 'hover', 'definition', 'references', 'diagnostics'] },
  ],
  lua: [
    { binary: 'lua-language-server', name: 'Lua Language Server', capabilities: ['completion', 'hover', 'definition', 'references', 'diagnostics'] },
  ],
  php: [
    { binary: 'phpactor', name: 'Phpactor', capabilities: ['completion', 'hover', 'definition', 'references', 'diagnostics'] },
    { binary: 'intelephense', name: 'Intelephense', capabilities: ['completion', 'hover', 'definition', 'references', 'rename', 'diagnostics'] },
  ],
  swift: [
    { binary: 'sourcekit-lsp', name: 'SourceKit-LSP', capabilities: ['completion', 'hover', 'definition', 'references', 'diagnostics'] },
  ],
  zig: [
    { binary: 'zls', name: 'Zig Language Server', capabilities: ['completion', 'hover', 'definition', 'references', 'diagnostics'] },
  ],
  nix: [
    { binary: 'nil', name: 'nil', capabilities: ['completion', 'hover', 'definition', 'references', 'diagnostics'] },
    { binary: 'rnix-lsp', name: 'rnix-lsp', capabilities: ['completion', 'hover', 'diagnostics'] },
  ],
  shell: [
    { binary: 'bash-language-server', name: 'Bash Language Server', capabilities: ['completion', 'hover', 'diagnostics'] },
  ],
}

export interface LspStatusItem {
  id: string
  name: string
  root?: string
  status: 'available' | 'unavailable' | 'connected'
  running: boolean
  language: string
  capabilities: string[]
}

// Cache binary availability checks for 30 seconds
const binaryCache = new Map<string, { available: boolean; checkedAt: number }>()
const CACHE_TTL = 30_000

async function isBinaryAvailable(binary: string): Promise<boolean> {
  const cached = binaryCache.get(binary)
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL) {
    return cached.available
  }

  try {
    const command = process.platform === 'win32' ? 'where' : 'which'
    await execFileAsync(command, [binary], { timeout: 5000 })
    const available = true
    binaryCache.set(binary, { available, checkedAt: Date.now() })
    return available
  } catch {
    binaryCache.set(binary, { available: false, checkedAt: Date.now() })
    return false
  }
}

/**
 * Quick scan of a directory to detect which languages are in use.
 * Scans up to 2 levels deep, checks file extensions.
 */
function detectLanguages(directory: string): Set<string> {
  const languages = new Set<string>()
  const extToLanguage = new Map<string, string>()
  for (const [lang, exts] of Object.entries(LANGUAGE_EXTENSIONS)) {
    for (const ext of exts) {
      extToLanguage.set(ext, lang)
    }
  }

  try {
    const entries = fs.readdirSync(directory, { withFileTypes: true, recursive: false })
    for (const entry of entries) {
      // Skip hidden dirs and common non-project dirs
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor' || entry.name === '__pycache__') {
        continue
      }

      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        const lang = extToLanguage.get(ext)
        if (lang) languages.add(lang)
      } else if (entry.isDirectory()) {
        try {
          const subEntries = fs.readdirSync(path.join(directory, entry.name), { withFileTypes: true })
          for (const sub of subEntries) {
            if (sub.isFile()) {
              const ext = path.extname(sub.name).toLowerCase()
              const lang = extToLanguage.get(ext)
              if (lang) languages.add(lang)
            }
          }
        } catch {
          // permission denied, skip
        }
      }
    }

    // Also check for well-known config files that indicate a language
    const configFiles: Record<string, string> = {
      'tsconfig.json': 'typescript',
      'package.json': 'javascript',
      'Cargo.toml': 'rust',
      'go.mod': 'go',
      'pom.xml': 'java',
      'build.gradle': 'java',
      'build.gradle.kts': 'kotlin',
      'requirements.txt': 'python',
      'pyproject.toml': 'python',
      'Gemfile': 'ruby',
      'CMakeLists.txt': 'cpp',
      'pubspec.yaml': 'dart',
      'mix.exs': 'elixir',
      'stack.yaml': 'haskell',
      'composer.json': 'php',
      'Package.swift': 'swift',
      'build.zig': 'zig',
      'flake.nix': 'nix',
      '.nix': 'nix',
    }
    for (const [file, lang] of Object.entries(configFiles)) {
      if (fs.existsSync(path.join(directory, file))) {
        languages.add(lang)
      }
    }
  } catch {
    // directory not readable
  }

  return languages
}

/**
 * Get LSP status for a project directory.
 * Returns a list of detected language servers with their availability.
 */
export async function getLspStatus(directory: string): Promise<LspStatusItem[]> {
  const languages = detectLanguages(directory)
  const results: LspStatusItem[] = []

  for (const language of languages) {
    const servers = LANGUAGE_SERVERS[language]
    if (!servers) continue

    for (const server of servers) {
      const available = await isBinaryAvailable(server.binary)
      results.push({
        id: `${language}-${server.binary}`,
        name: server.name,
        root: directory,
        status: available ? 'available' : 'unavailable',
        running: false,
        language,
        capabilities: server.capabilities,
      })
    }
  }

  // Sort: available first, then by language name
  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'available' ? -1 : 1
    return a.language.localeCompare(b.language)
  })

  return results
}
