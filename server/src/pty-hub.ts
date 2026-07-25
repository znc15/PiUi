import { newPtyId } from './ids.js'
import { publishPayload } from './events.js'

export type PtyRecord = {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: 'running' | 'exited'
  pid?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proc?: any
}

const ptys = new Map<string, PtyRecord>()

export function listPtys() {
  return [...ptys.values()].map(p => ({
    id: p.id,
    title: p.title,
    command: p.command,
    args: p.args,
    cwd: p.cwd,
    status: p.status,
    pid: p.pid,
  }))
}

export function getPty(id: string) {
  const p = ptys.get(id)
  if (!p) return null
  return {
    id: p.id,
    title: p.title,
    command: p.command,
    args: p.args,
    cwd: p.cwd,
    status: p.status,
    pid: p.pid,
  }
}

export async function createPty(params: {
  command?: string
  args?: string[]
  cwd?: string
  title?: string
  env?: Record<string, string>
}) {
  const id = newPtyId()
  const command = params.command || process.env.SHELL || '/bin/zsh'
  const args = params.args || []
  const cwd = params.cwd || process.cwd()
  const title = params.title || command

  let proc: unknown
  let pid: number | undefined
  let status: 'running' | 'exited' = 'running'

  try {
    const pty = await import('node-pty')
    proc = pty.spawn(command, args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, ...params.env } as Record<string, string>,
    })
    pid = (proc as { pid: number }).pid
    ;(proc as { onExit: (cb: () => void) => void }).onExit(() => {
      const rec = ptys.get(id)
      if (rec) {
        rec.status = 'exited'
        publishPayload('pty.exited', { ptyID: id })
        publishPayload('pty.updated', { info: getPty(id) })
      }
    })
  } catch (err) {
    console.warn('[pty] node-pty unavailable, creating stub terminal', err)
    status = 'exited'
  }

  const rec: PtyRecord = { id, title, command, args, cwd, status, pid, proc }
  ptys.set(id, rec)
  const info = getPty(id)
  publishPayload('pty.created', { info })
  return info
}

export function updatePty(id: string, patch: { title?: string; size?: { rows?: number; cols?: number } }) {
  const rec = ptys.get(id)
  if (!rec) return null
  if (patch.title) rec.title = patch.title
  if (patch.size && rec.proc) {
    try {
      ;(rec.proc as { resize: (cols: number, rows: number) => void }).resize(patch.size.cols ?? 80, patch.size.rows ?? 24)
    } catch {
      // ignore
    }
  }
  const info = getPty(id)
  publishPayload('pty.updated', { info })
  return info
}

export function removePty(id: string) {
  const rec = ptys.get(id)
  if (!rec) return true
  try {
    ;(rec.proc as { kill?: () => void } | undefined)?.kill?.()
  } catch {
    // ignore
  }
  ptys.delete(id)
  publishPayload('pty.deleted', { ptyID: id })
  return true
}

export function getPtyProc(id: string) {
  return ptys.get(id)?.proc
}
