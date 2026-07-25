// ============================================
// Worktree Hub — Git worktree operations
//
// Manages git worktrees via the git CLI.
// Pi does not have native worktree support,
// so we shell out to git commands.
// ============================================

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import { publishPayload } from './events.js'

const execFileAsync = promisify(execFile)

export interface Worktree {
  name?: string
  path?: string
  directory?: string
  branch?: string
}

interface GitWorktreeEntry {
  worktree: string
  HEAD: string
  branch?: string
  detached: boolean
  bare: boolean
}

/**
 * Parse `git worktree list --porcelain` output.
 *
 * Format:
 *   worktree /path/to/worktree
 *   HEAD abc123...
 *   branch refs/heads/main
 *
 *   worktree /path/to/other
 *   HEAD def456...
 *   branch refs/heads/feature
 */
function parseWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = []
  let current: Partial<GitWorktreeEntry> = {}

  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (current.worktree) {
        entries.push({
          worktree: current.worktree,
          HEAD: current.HEAD || '',
          branch: current.branch,
          detached: current.detached ?? false,
          bare: current.bare ?? false,
        })
      }
      current = {}
      continue
    }

    if (trimmed.startsWith('worktree ')) {
      current.worktree = trimmed.slice('worktree '.length)
    } else if (trimmed.startsWith('HEAD ')) {
      current.HEAD = trimmed.slice('HEAD '.length)
    } else if (trimmed.startsWith('branch ')) {
      current.branch = trimmed.slice('branch '.length)
    } else if (trimmed === 'detached') {
      current.detached = true
    } else if (trimmed === 'bare') {
      current.bare = true
    }
  }

  // Handle last entry (no trailing newline)
  if (current.worktree) {
    entries.push({
      worktree: current.worktree,
      HEAD: current.HEAD || '',
      branch: current.branch,
      detached: current.detached ?? false,
      bare: current.bare ?? false,
    })
  }

  return entries
}

/**
 * Convert a git branch ref to a short name.
 * refs/heads/main → main
 */
function shortBranch(ref?: string): string | undefined {
  if (!ref) return undefined
  return ref.replace(/^refs\/heads\//, '')
}

/**
 * Check if a directory is inside a git repository.
 */
async function isGitRepo(directory: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: directory, timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/**
 * Get the git repository root directory.
 */
async function getGitRoot(directory: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: directory,
      timeout: 5000,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * List all git worktrees for a repository.
 * The directory should be within a git repo.
 *
 * Returns an array of directory paths (matching the frontend's expected string[] shape).
 */
export async function listWorktrees(directory: string): Promise<string[]> {
  const isRepo = await isGitRepo(directory)
  if (!isRepo) return []

  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: directory,
      timeout: 10000,
    })

    const entries = parseWorktreeList(stdout)
    return entries.map(e => e.worktree)
  } catch (err) {
    console.warn('[worktree-hub] list failed:', err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * List all git worktrees with full details.
 */
export async function listWorktreesDetailed(directory: string): Promise<Worktree[]> {
  const isRepo = await isGitRepo(directory)
  if (!isRepo) return []

  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: directory,
      timeout: 10000,
    })

    const entries = parseWorktreeList(stdout)
    return entries.map(e => ({
      name: path.basename(e.worktree),
      path: e.worktree,
      directory: e.worktree,
      branch: shortBranch(e.branch),
    }))
  } catch (err) {
    console.warn('[worktree-hub] list detailed failed:', err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * Create a new git worktree.
 *
 * @param name - The name for the new worktree (used as directory name)
 * @param directory - The git repository root directory
 * @returns The created worktree info
 */
export async function createWorktree(
  name: string,
  directory: string,
): Promise<Worktree> {
  if (!name || !name.trim()) {
    throw Object.assign(new Error('Worktree name is required'), { status: 400 })
  }

  const isRepo = await isGitRepo(directory)
  if (!isRepo) {
    throw Object.assign(new Error('Not a git repository'), { status: 400 })
  }

  const gitRoot = await getGitRoot(directory)
  if (!gitRoot) {
    throw Object.assign(new Error('Cannot determine git root'), { status: 500 })
  }

  const worktreePath = path.join(gitRoot, '..', name.trim())
  const branchName = name.trim()

  try {
    // Create a new branch and worktree
    await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', branchName], {
      cwd: gitRoot,
      timeout: 30000,
    })

    const result: Worktree = {
      name: name.trim(),
      path: worktreePath,
      directory: worktreePath,
      branch: branchName,
    }

    // Publish worktree.ready event
    publishPayload('worktree.ready', {
      name: result.name,
      directory: result.directory,
      branch: result.branch,
    }, directory)

    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // If the branch already exists, try adding worktree without -b (checkout existing branch)
    if (message.includes('already exists') || message.includes('fatal:')) {
      try {
        await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], {
          cwd: gitRoot,
          timeout: 30000,
        })

        const result: Worktree = {
          name: name.trim(),
          path: worktreePath,
          directory: worktreePath,
          branch: branchName,
        }

        publishPayload('worktree.ready', {
          name: result.name,
          directory: result.directory,
          branch: result.branch,
        }, directory)

        return result
      } catch (retryErr) {
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr)
        publishPayload('worktree.failed', { message: retryMessage }, directory)
        throw Object.assign(new Error(retryMessage), { status: 500 })
      }
    }

    publishPayload('worktree.failed', { message }, directory)
    throw Object.assign(new Error(message), { status: 500 })
  }
}

/**
 * Remove a git worktree.
 *
 * @param worktreeDirectory - The path of the worktree to remove
 * @param directory - The git repository root directory
 */
export async function removeWorktree(
  worktreeDirectory: string,
  directory: string,
): Promise<boolean> {
  if (!worktreeDirectory) {
    throw Object.assign(new Error('Worktree directory is required'), { status: 400 })
  }

  const isRepo = await isGitRepo(directory)
  if (!isRepo) {
    throw Object.assign(new Error('Not a git repository'), { status: 400 })
  }

  const gitRoot = await getGitRoot(directory)
  if (!gitRoot) {
    throw Object.assign(new Error('Cannot determine git root'), { status: 500 })
  }

  try {
    // Force remove to handle locked worktrees
    await execFileAsync('git', ['worktree', 'remove', worktreeDirectory, '--force'], {
      cwd: gitRoot,
      timeout: 30000,
    })
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // Try pruning if direct remove fails
    try {
      await execFileAsync('git', ['worktree', 'prune'], {
        cwd: gitRoot,
        timeout: 10000,
      })

      // Check if the worktree directory still exists
      if (fs.existsSync(worktreeDirectory)) {
        // Force remove the directory
        fs.rmSync(worktreeDirectory, { recursive: true, force: true })
      }

      return true
    } catch (pruneErr) {
      const pruneMessage = pruneErr instanceof Error ? pruneErr.message : String(pruneErr)
      publishPayload('worktree.failed', { message: pruneMessage }, directory)
      throw Object.assign(new Error(`${message}; prune also failed: ${pruneMessage}`), { status: 500 })
    }
  }
}

/**
 * Reset a worktree (re-checkout the branch, discarding local changes).
 *
 * This is a best-effort operation since git doesn't have a native
 * "reset worktree" command. We do a git checkout --force in the worktree.
 */
export async function resetWorktree(
  worktreeDirectory: string,
  directory: string,
): Promise<boolean> {
  if (!worktreeDirectory) {
    throw Object.assign(new Error('Worktree directory is required'), { status: 400 })
  }

  if (!fs.existsSync(worktreeDirectory)) {
    throw Object.assign(new Error('Worktree directory does not exist'), { status: 400 })
  }

  try {
    // Force checkout to discard local changes
    await execFileAsync('git', ['checkout', '--force'], {
      cwd: worktreeDirectory,
      timeout: 30000,
    })

    // Also clean untracked files
    await execFileAsync('git', ['clean', '-fd'], {
      cwd: worktreeDirectory,
      timeout: 30000,
    })

    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    publishPayload('worktree.failed', { message }, directory)
    throw Object.assign(new Error(message), { status: 500 })
  }
}
