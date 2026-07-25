// ============================================
// Skills Hub — Pi skill discovery and slash commands
//
// Uses Pi's loadSkills() to discover skills from configured paths,
// and provides built-in slash commands.
// ============================================

import path from 'node:path'
import fs from 'node:fs'
import {
  loadSkills,
  getAgentDir,
  SettingsManager,
  type Skill as PiSkill,
} from '@earendil-works/pi-coding-agent'
import { getDefaultWorkspace } from './session-hub.js'

// ---- Frontend-facing types ----

export interface UiSkill {
  name: string
  description?: string
  location?: string
  content?: string
}

export interface UiCommand {
  name: string
  description?: string
  argumentHint?: string
  source: 'builtin' | 'skill' | 'extension'
}

// ---- Skill cache ----

interface SkillCacheEntry {
  skills: UiSkill[]
  timestamp: number
}

const CACHE_TTL_MS = 30_000 // 30 seconds
const skillCache = new Map<string, SkillCacheEntry>()

// ---- SettingsManager cache ----

const settingsManagerCache = new Map<string, SettingsManager>()

function getSettingsManager(cwd: string): SettingsManager {
  const existing = settingsManagerCache.get(cwd)
  if (existing) return existing
  const sm = SettingsManager.create(cwd)
  settingsManagerCache.set(cwd, sm)
  return sm
}

// ---- Skill loading ----

function piSkillToUi(skill: PiSkill): UiSkill {
  let content: string | undefined
  try {
    if (skill.filePath && fs.existsSync(skill.filePath)) {
      content = fs.readFileSync(skill.filePath, 'utf8')
    }
  } catch {
    // ignore read errors
  }

  return {
    name: skill.name,
    description: skill.description,
    location: skill.filePath,
    content,
  }
}

export function loadSkillsForDirectory(directory?: string): UiSkill[] {
  const cwd = path.resolve(directory || getDefaultWorkspace())
  const agentDir = getAgentDir()

  // Check cache
  const cached = skillCache.get(cwd)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.skills
  }

  try {
    const sm = getSettingsManager(cwd)
    const skillPaths = sm.getSkillPaths() ?? []
    const includeDefaults = sm.getEnableSkillCommands() !== false

    const result = loadSkills({
      cwd,
      agentDir,
      skillPaths,
      includeDefaults,
    })

    const uiSkills = result.skills.map(piSkillToUi)

    // Log diagnostics
    for (const diag of result.diagnostics) {
      if (diag.type === 'warning') {
        console.warn(`[skills-hub] ${diag.message}: ${diag.path}`)
      } else if (diag.type === 'collision') {
        console.warn(`[skills-hub] skill collision: ${diag.message}`)
      }
    }

    // Update cache
    skillCache.set(cwd, { skills: uiSkills, timestamp: Date.now() })

    return uiSkills
  } catch (err) {
    console.warn('[skills-hub] loadSkills failed:', err instanceof Error ? err.message : err)
    return []
  }
}

/** Force-refresh the skill cache for a directory. */
export function refreshSkills(directory?: string): UiSkill[] {
  const cwd = path.resolve(directory || getDefaultWorkspace())
  skillCache.delete(cwd)
  // Also refresh settings
  const sm = settingsManagerCache.get(cwd)
  if (sm) {
    try { sm.reload() } catch { /* ignore */ }
  }
  return loadSkillsForDirectory(cwd)
}

// ---- Slash commands ----

/**
 * Built-in slash commands that Pi provides.
 * These correspond to the commands the Pi agent understands natively.
 */
const BUILTIN_COMMANDS: UiCommand[] = [
  { name: 'compact', description: 'Summarize and compact the conversation to free context', source: 'builtin' },
  { name: 'fork', description: 'Fork the conversation at a specific message', argumentHint: '[messageID]', source: 'builtin' },
  { name: 'summarize', description: 'Generate a summary of the conversation', source: 'builtin' },
  { name: 'model', description: 'Switch the model for this session', argumentHint: '<provider>/<model>', source: 'builtin' },
  { name: 'trust', description: 'Set project trust level', argumentHint: '<always|ask|never>', source: 'builtin' },
  { name: 'skill', description: 'Invoke a skill by name', argumentHint: '<skill-name> [args]', source: 'builtin' },
  { name: 'help', description: 'Show available commands and skills', source: 'builtin' },
]

export function getCommands(directory?: string): UiCommand[] {
  const cwd = path.resolve(directory || getDefaultWorkspace())
  const commands: UiCommand[] = [...BUILTIN_COMMANDS]

  // Add skill-based commands if skill commands are enabled
  try {
    const sm = getSettingsManager(cwd)
    if (sm.getEnableSkillCommands() !== false) {
      const skills = loadSkillsForDirectory(cwd)
      for (const skill of skills) {
        commands.push({
          name: skill.name,
          description: skill.description,
          source: 'skill',
        })
      }
    }
  } catch {
    // ignore — built-in commands still available
  }

  return commands
}

/** Invalidate all caches (e.g. after settings change). */
export function invalidateCaches(): void {
  skillCache.clear()
  settingsManagerCache.clear()
}
