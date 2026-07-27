import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// ============================================
// Pi runtime status detection
// - auth.json (written by `pi` /login)
// - well-known provider API keys from env
// - custom providers configured in models.json (e.g. self-hosted gateway)
// ============================================

const KNOWN_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'ZHIPU_AI_API_KEY',
  'MOONSHOT_API_KEY',
  'DASHSCOPE_API_KEY',
  'DEEPSEEK_API_KEY',
  'CEREBRAS_API_KEY',
]

export interface PiStatus {
  /** Pi agent dir (~/.pi/agent or PI_AGENT_DIR) */
  agentDir: string
  /** true when any auth entry or API key is present */
  authed: boolean
  /** provider names found in auth.json (names only, never secrets) */
  authProviders: string[]
  /** well-known API key env var names that are set (names only) */
  envKeys: string[]
  /** custom provider names configured in models.json (names only, never secrets) */
  customProviders: string[]
  /** node version running the bridge */
  nodeVersion: string
  /** bridge version */
  version: string
}

export function getAgentDir(): string {
  return process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')
}

export async function getPiStatus(version = '0.1.0-pi'): Promise<PiStatus> {
  const agentDir = getAgentDir()
  let authProviders: string[] = []
  try {
    const raw = await fs.readFile(path.join(agentDir, 'auth.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      authProviders = Object.keys(parsed as Record<string, unknown>)
    }
  } catch {
    // no auth.json → not logged in via pi CLI
  }

  const envKeys = KNOWN_ENV_KEYS.filter(key => {
    const value = process.env[key]
    return typeof value === 'string' && value.length > 0
  })

  // models.json 里的自定义 provider（如自建 gateway，内嵌 apiKey/baseUrl）也视为已配置
  let customProviders: string[] = []
  try {
    const raw = await fs.readFile(path.join(agentDir, 'models.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const providers = parsed?.providers
    if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
      customProviders = Object.keys(providers as Record<string, unknown>)
    }
  } catch {
    // no models.json or no custom providers
  }

  return {
    agentDir,
    authed: authProviders.length > 0 || envKeys.length > 0 || customProviders.length > 0,
    authProviders,
    envKeys,
    customProviders,
    nodeVersion: process.version,
    version,
  }
}
