// ============================================
// Service Store - Pi Agent bridge 进程管理
// 管理自动启动设置 + Node 路径 + 环境变量 + 运行时信息 + 进程生命周期
// 仅在 Tauri 桌面端有效
// ============================================

import { useSyncExternalStore } from 'react'

const STORAGE_KEY_AUTO_START = 'pi-auto-start-service'
const STORAGE_KEY_NODE_PATH = 'pi-node-path'
const STORAGE_KEY_ENV_VARS = 'pi-service-env-vars'

// 旧版（OpenCode fork）存储键，用于一次性迁移
const LEGACY_KEY_AUTO_START = 'opencode-auto-start-service'
const LEGACY_KEY_BINARY_PATH = 'opencode-binary-path'
const LEGACY_KEY_ENV_VARS = 'opencode-service-env-vars'

/** 环境变量键值对 */
export interface EnvVar {
  key: string
  value: string
}

/** Rust detect_pi_environment 的返回 */
export interface PiEnvironment {
  nodePath: string | null
  nodeVersion: string | null
  piPath: string | null
  piVersion: string | null
  bridgeScript: string | null
  bridgeMode: string | null
  /** Pi 配置目录（~/.pi/agent） */
  agentDir: string
  /** auth.json 中的 provider 名称（仅名称） */
  authProviders: string[]
  /** Rust 侧直接检测的认证状态（不依赖 bridge） */
  authed: boolean
}

/** bridge /global/pi-status 的返回 */
export interface PiStatus {
  agentDir: string
  authed: boolean
  authProviders: string[]
  envKeys: string[]
  /** models.json 中配置的自定义 provider 名称（仅名称） */
  customProviders: string[]
  nodeVersion: string
  version: string
}

export interface ServiceSettingsBackup {
  autoStart: boolean
  nodePath: string
  envVars: EnvVar[]
}

interface ServiceStoreSnapshot {
  autoStart: boolean
  /** 手动指定的 node 路径，空字符串表示自动检测 */
  nodePath: string
  /** 传给子进程的额外环境变量 */
  envVars: EnvVar[]
  /** 自动检测到的运行环境信息 */
  piEnv: PiEnvironment | null
  /** Pi 认证/运行状态（来自 bridge） */
  piStatus: PiStatus | null
  /** 服务是否正在运行（最后一次检测结果） */
  running: boolean
  /** 是否由我们启动（用于关闭时判断） */
  startedByUs: boolean
  /** 当前是否正在启动中 */
  starting: boolean
  /** 最近一次启动失败的错误信息 */
  lastError: string
  /** 用户手动停止过（本会话内），watchdog 不自动重启 */
  suppressAutoRestart: boolean
}

function readWithLegacyMigration(key: string, legacyKey: string): string | null {
  try {
    const value = localStorage.getItem(key)
    if (value !== null) return value
    const legacy = localStorage.getItem(legacyKey)
    if (legacy !== null) {
      localStorage.setItem(key, legacy)
      localStorage.removeItem(legacyKey)
      return legacy
    }
  } catch {
    /* ignore */
  }
  return null
}

class ServiceStore {
  private _autoStart: boolean
  private _nodePath: string
  private _envVars: EnvVar[]
  private _piEnv: PiEnvironment | null = null
  private _piStatus: PiStatus | null = null
  private _running = false
  private _startedByUs = false
  private _starting = false
  private _lastError = ''
  private _suppressAutoRestart = false
  private _listeners: Set<() => void> = new Set()
  private _snapshot: ServiceStoreSnapshot

  constructor() {
    // 桌面应用默认自动启动 bridge（首次运行没有存储值时 → true）
    this._autoStart = readWithLegacyMigration(STORAGE_KEY_AUTO_START, LEGACY_KEY_AUTO_START) !== 'false'
    this._nodePath = readWithLegacyMigration(STORAGE_KEY_NODE_PATH, LEGACY_KEY_BINARY_PATH) || ''

    try {
      let raw = localStorage.getItem(STORAGE_KEY_ENV_VARS)
      if (raw === null) {
        const legacy = localStorage.getItem(LEGACY_KEY_ENV_VARS)
        if (legacy !== null) {
          localStorage.setItem(STORAGE_KEY_ENV_VARS, legacy)
          localStorage.removeItem(LEGACY_KEY_ENV_VARS)
          raw = legacy
        }
      }
      this._envVars = raw ? JSON.parse(raw) : []
    } catch {
      this._envVars = []
    }
    this._snapshot = this._buildSnapshot()
  }

  // ---- Getters ----

  get autoStart() {
    return this._autoStart
  }
  get nodePath() {
    return this._nodePath
  }
  get envVars() {
    return this._envVars
  }
  get piEnv() {
    return this._piEnv
  }
  get piStatus() {
    return this._piStatus
  }
  get running() {
    return this._running
  }
  get startedByUs() {
    return this._startedByUs
  }
  get starting() {
    return this._starting
  }
  get lastError() {
    return this._lastError
  }
  get suppressAutoRestart() {
    return this._suppressAutoRestart
  }

  /** 实际要用的 node 路径：手动路径 > 自动检测（空字符串交给 Rust 检测） */
  get effectiveNodePath() {
    return this._nodePath.trim() || this._piEnv?.nodePath || ''
  }

  /** 将 envVars 转为 Record<string, string>，方便传给 Rust */
  get envVarsRecord(): Record<string, string> {
    const record: Record<string, string> = {}
    for (const { key, value } of this._envVars) {
      const k = key.trim()
      if (k) record[k] = value
    }
    return record
  }

  // ---- Setters ----

  setAutoStart(v: boolean) {
    this._autoStart = v
    try {
      localStorage.setItem(STORAGE_KEY_AUTO_START, String(v))
    } catch {
      /* 忽略 localStorage 持久化失败（隐私模式/配额超限），仅影响下次启动默认值 */
    }
    this._notify()
  }

  setNodePath(v: string) {
    this._nodePath = v
    try {
      localStorage.setItem(STORAGE_KEY_NODE_PATH, v)
    } catch {
      /* 忽略 localStorage 持久化失败（隐私模式/配额超限），仅影响下次启动默认值 */
    }
    this._notify()
  }

  setEnvVars(vars: EnvVar[]) {
    this._envVars = vars
    try {
      localStorage.setItem(STORAGE_KEY_ENV_VARS, JSON.stringify(vars))
    } catch {
      /* 忽略 localStorage 持久化失败（隐私模式/配额超限），仅影响下次启动默认值 */
    }
    this._notify()
  }

  setPiEnv(env: PiEnvironment | null) {
    this._piEnv = env
    this._notify()
  }

  setPiStatus(status: PiStatus | null) {
    this._piStatus = status
    this._notify()
  }

  setRunning(v: boolean) {
    this._running = v
    this._notify()
  }

  setStartedByUs(v: boolean) {
    this._startedByUs = v
    this._notify()
  }

  setStarting(v: boolean) {
    this._starting = v
    this._notify()
  }

  setLastError(v: string) {
    this._lastError = v
    this._notify()
  }
  setSuppressAutoRestart(v: boolean) {
    this._suppressAutoRestart = v
    this._notify()
  }

  // ---- React useSyncExternalStore 接口 ----

  subscribe = (fn: () => void) => {
    this._listeners.add(fn)
    return () => {
      this._listeners.delete(fn)
    }
  }

  getSnapshot = (): ServiceStoreSnapshot => this._snapshot

  // ---- Internal ----

  private _buildSnapshot(): ServiceStoreSnapshot {
    return {
      autoStart: this._autoStart,
      nodePath: this._nodePath,
      envVars: this._envVars,
      piEnv: this._piEnv,
      piStatus: this._piStatus,
      running: this._running,
      startedByUs: this._startedByUs,
      starting: this._starting,
      lastError: this._lastError,
      suppressAutoRestart: this._suppressAutoRestart,
    }
  }

  private _notify() {
    this._snapshot = this._buildSnapshot()
    this._listeners.forEach(fn => fn())
  }
}

export const serviceStore = new ServiceStore()

export function exportServiceSettingsBackup(): ServiceSettingsBackup {
  return {
    autoStart: serviceStore.autoStart,
    nodePath: serviceStore.nodePath,
    envVars: serviceStore.envVars.map(item => ({ ...item })),
  }
}

export function importServiceSettingsBackup(raw: unknown): void {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const envVars = Array.isArray(parsed?.envVars)
    ? parsed.envVars
        .filter(
          (item): item is EnvVar =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).key === 'string' &&
            typeof (item as Record<string, unknown>).value === 'string',
        )
        .map(item => ({ key: item.key, value: item.value }))
    : []

  serviceStore.setAutoStart(parsed?.autoStart === true)
  // 兼容旧备份字段 binaryPath
  const nodePath = typeof parsed?.nodePath === 'string' ? parsed.nodePath : typeof parsed?.binaryPath === 'string' ? parsed.binaryPath : ''
  serviceStore.setNodePath(nodePath)
  serviceStore.setEnvVars(envVars)
}

/** React hook */
export function useServiceStore() {
  return useSyncExternalStore(serviceStore.subscribe, serviceStore.getSnapshot)
}
