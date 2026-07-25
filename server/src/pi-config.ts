import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getDefaultWorkspace } from './session-hub.js'

export type JsonRecord = Record<string, unknown>

function agentDir(): string {
  return process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
}

function globalSettingsPath(): string {
  return path.join(agentDir(), 'settings.json')
}

function projectSettingsPath(directory?: string): string {
  const root = directory || getDefaultWorkspace()
  return path.join(root, '.pi', 'settings.json')
}

function mcpPath(): string {
  return path.join(agentDir(), 'mcp.json')
}

async function readJsonFile(filePath: string, fallback: JsonRecord = {}): Promise<JsonRecord> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonRecord) : fallback
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
    if (code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJsonFile(filePath: string, data: JsonRecord): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, filePath)
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Deep-merge plain objects; arrays and scalars replace. */
export function deepMerge(base: JsonRecord, patch: JsonRecord): JsonRecord {
  const out: JsonRecord = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isRecord(value) && isRecord(out[key])) {
      out[key] = deepMerge(out[key] as JsonRecord, value)
    } else {
      out[key] = value
    }
  }
  return out
}

export async function getGlobalConfig(): Promise<JsonRecord> {
  return readJsonFile(globalSettingsPath(), {})
}

export async function updateGlobalConfig(patch: JsonRecord): Promise<JsonRecord> {
  const current = await getGlobalConfig()
  const next = deepMerge(current, patch)
  await writeJsonFile(globalSettingsPath(), next)
  return next
}

export async function replaceGlobalConfig(next: JsonRecord): Promise<JsonRecord> {
  await writeJsonFile(globalSettingsPath(), next)
  return next
}

export async function getProjectConfig(directory?: string): Promise<JsonRecord> {
  return readJsonFile(projectSettingsPath(directory), {})
}

export async function updateProjectConfig(patch: JsonRecord, directory?: string): Promise<JsonRecord> {
  const current = await getProjectConfig(directory)
  const next = deepMerge(current, patch)
  await writeJsonFile(projectSettingsPath(directory), next)
  return next
}

/** Effective config = global deep-merged with project overrides. */
export async function getEffectiveConfig(directory?: string): Promise<JsonRecord> {
  const global = await getGlobalConfig()
  const project = await getProjectConfig(directory)
  return deepMerge(global, project)
}

export async function getMcpConfig(): Promise<JsonRecord> {
  return readJsonFile(mcpPath(), { mcpServers: {} })
}

export async function updateMcpConfig(next: JsonRecord): Promise<JsonRecord> {
  await writeJsonFile(mcpPath(), next)
  return next
}

export function getConfigPaths(directory?: string) {
  return {
    agentDir: agentDir(),
    globalSettings: globalSettingsPath(),
    projectSettings: projectSettingsPath(directory),
    mcp: mcpPath(),
  }
}
