import type { ServerResponse } from 'node:http'

export type GlobalEvent = {
  directory: string
  payload: {
    type: string
    properties?: unknown
  }
}

type Listener = (event: GlobalEvent) => void

const listeners = new Set<Listener>()
let defaultDirectory = process.cwd()

export function setDefaultDirectory(dir: string): void {
  defaultDirectory = dir
}

export function publish(event: GlobalEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      console.error('[events] listener error', err)
    }
  }
}

export function publishPayload(type: string, properties: unknown, directory?: string): void {
  publish({
    directory: directory || defaultDirectory,
    payload: { type, properties: properties ?? {} },
  })
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Attach an SSE stream to a Node ServerResponse */
export function attachSse(res: ServerResponse, directory?: string): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const write = (event: GlobalEvent) => {
    if (directory && event.directory && event.directory !== directory) return
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  // initial connected event
  write({
    directory: directory || defaultDirectory,
    payload: { type: 'server.connected', properties: { timestamp: Date.now() } },
  })

  const unsub = subscribe(write)
  const heartbeat = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`)
  }, 15000)

  const cleanup = () => {
    clearInterval(heartbeat)
    unsub()
  }

  res.on('close', cleanup)
  return cleanup
}
