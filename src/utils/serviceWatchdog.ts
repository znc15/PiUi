// ============================================
// Service Watchdog - bridge 健康检查与自动恢复
//
// 应用只在启动时尝试一次拉起 bridge，若之后 bridge 崩溃、
// 或应用此前复用的外部服务消失，界面就会一直「未连接」。
// watchdog 定期检查健康状态，自动启动时自动（重）拉起 bridge。
// ============================================

import { serviceStore } from '../store/serviceStore'
import { serverStore } from '../store/serverStore'
import { applyLocalServiceUrl } from './localServiceUrl'
import { isTauri, isTauriMobile } from './tauri'

const CHECK_INTERVAL_MS = 15000
/** 启动失败后跳过的检查轮数（避免无 node 等场景频繁重试） */
const FAILURE_BACKOFF_CYCLES = 4

interface StartPiServiceResult {
  started: boolean
  startedByUs: boolean
  url?: string | null
}

let watchdogStarted = false
let failureCycles = 0
let busy = false

export function startServiceWatchdog() {
  if (!isTauri() || isTauriMobile() || watchdogStarted) return
  watchdogStarted = true

  setInterval(() => {
    void tick()
  }, CHECK_INTERVAL_MS)
}

async function tick() {
  if (busy || !serviceStore.autoStart || serviceStore.starting) return
  // 用户在设置里手动停止了服务 → 不自动拉起
  if (serviceStore.suppressAutoRestart) return
  if (failureCycles > 0) {
    failureCycles--
    return
  }

  busy = true
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const url = serverStore.getLocalServerUrl()
    const healthy = await invoke<boolean>('check_pi_service', { url }).catch(() => false)

    if (healthy) {
      failureCycles = 0
      if (!serviceStore.running) {
        serviceStore.setRunning(true)
        applyLocalServiceUrl(url)
      }
      return
    }

    // 服务不可用 → 尝试（重）启动
    serviceStore.setRunning(false)
    serviceStore.setStartedByUs(false)
    serviceStore.setStarting(true)
    try {
      const result = await invoke<StartPiServiceResult>('start_pi_service', {
        url,
        nodePath: serviceStore.effectiveNodePath,
        envVars: serviceStore.envVarsRecord,
      })
      applyLocalServiceUrl(result.url)
      serviceStore.setStartedByUs(result.startedByUs)
      serviceStore.setRunning(true)
      serviceStore.setLastError('')
      failureCycles = 0
      console.info('[Watchdog] Pi Agent bridge recovered')
    } catch (err) {
      failureCycles = FAILURE_BACKOFF_CYCLES
      serviceStore.setLastError(err instanceof Error ? err.message : String(err))
      console.warn('[Watchdog] Pi Agent bridge restart failed:', err)
    } finally {
      serviceStore.setStarting(false)
    }
  } finally {
    busy = false
  }
}
