import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function resolveSafe(root: string, rel: string): string {
  const base = path.resolve(root)
  const target = path.resolve(base, rel || '.')
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw Object.assign(new Error('Path escapes workspace'), { status: 400 })
  }
  return target
}

export async function listDirectory(directory: string, relPath = '.'): Promise<
  Array<{ name: string; path: string; absolute: string; type: 'file' | 'directory'; ignored: boolean }>
> {
  const root = path.resolve(directory)
  const dir = resolveSafe(root, relPath)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store') continue
    const abs = path.join(dir, entry.name)
    const rel = path.relative(root, abs) || entry.name
    out.push({
      name: entry.name,
      path: rel.replace(/\\/g, '/'),
      absolute: abs,
      type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      ignored: false,
    })
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

export async function readFileContent(directory: string, relPath: string) {
  const abs = resolveSafe(directory, relPath)
  const buf = await fs.readFile(abs)
  const isBinary = buf.includes(0)
  if (isBinary) {
    return {
      type: 'file',
      content: buf.toString('base64'),
      encoding: 'base64',
      mimeType: 'application/octet-stream',
    }
  }
  return {
    type: 'file',
    content: buf.toString('utf8'),
    encoding: 'utf8',
    mimeType: 'text/plain',
  }
}

export async function fileStatus(directory: string) {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: directory })
    return stdout
      .split('\n')
      .map(line => line.trimEnd())
      .filter(Boolean)
      .map(line => {
        const status = line.slice(0, 2).trim()
        const filePath = line.slice(3).trim()
        return {
          path: filePath,
          added: 0,
          removed: 0,
          status: status.includes('M') ? 'modified' : status.includes('A') ? 'added' : status.includes('D') ? 'deleted' : 'unknown',
        }
      })
  } catch {
    return []
  }
}

export async function findFiles(directory: string, query: string, type?: string, limit = 50): Promise<string[]> {
  const q = query.toLowerCase()
  const results: string[] = []
  const root = path.resolve(directory)

  async function walk(dir: string) {
    if (results.length >= limit) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= limit) return
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.pi') continue
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs).replace(/\\/g, '/')
      const isDir = entry.isDirectory()
      if (type === 'directory' && !isDir) {
        // skip
      } else if (type === 'file' && isDir) {
        // skip match
      } else if (entry.name.toLowerCase().includes(q) || rel.toLowerCase().includes(q)) {
        if (!type || (type === 'directory' && isDir) || (type === 'file' && !isDir)) {
          results.push(rel)
        }
      }
      if (isDir) await walk(abs)
    }
  }

  await walk(root)
  return results
}

export async function findText(directory: string, pattern: string) {
  try {
    const { stdout } = await execFileAsync(
      'rg',
      ['-n', '--no-heading', '--color', 'never', '-m', '50', pattern, '.'],
      { cwd: directory, maxBuffer: 2 * 1024 * 1024 },
    )
    return stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const m = line.match(/^(.*?):(\d+):(.*)$/)
        if (!m) return { path: line }
        return {
          path: m[1],
          line_number: Number(m[2]),
          lines: m[3],
        }
      })
  } catch {
    // fallback naive
    return []
  }
}

export async function getVcsInfo(directory: string) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: directory })
    return { branch: stdout.trim() }
  } catch {
    return { branch: undefined }
  }
}

export async function getVcsDiff(directory: string) {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--numstat'], { cwd: directory })
    return stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [added, removed, file] = line.split('\t')
        return {
          file,
          before: '',
          after: '',
          additions: Number(added) || 0,
          deletions: Number(removed) || 0,
        }
      })
  } catch {
    return []
  }
}
