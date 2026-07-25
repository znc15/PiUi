// ============================================
// PiSetupGuide - Pi 未配置时的引导浮层
// 当 bridge 已运行但未检测到任何认证信息（auth.json / API Key）时显示
// ============================================

import { memo, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useServerStore } from '../../hooks'
import { LOCAL_SERVER_ID } from '../../store/serverStore'
import { API_BASE_URL } from '../../constants'
import { serviceStore, useServiceStore, type PiStatus } from '../../store/serviceStore'
import { isTauri } from '../../utils/tauri'

const DISMISS_KEY = 'pi-setup-guide-dismissed'

interface PiSetupGuideProps {
  onOpenSettings: () => void
}

export const PiSetupGuide = memo(function PiSetupGuide({ onOpenSettings }: PiSetupGuideProps) {
  const { t } = useTranslation('onboarding')
  const { running, piStatus, piEnv } = useServiceStore()
  const { servers } = useServerStore()
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [checking, setChecking] = useState(false)

  const serverUrl = servers.find(server => server.id === LOCAL_SERVER_ID)?.url || API_BASE_URL

  const fetchStatus = useCallback(async () => {
    setChecking(true)
    try {
      const response = await fetch(`${serverUrl}/global/pi-status`, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const status = (await response.json()) as PiStatus
      serviceStore.setPiStatus(status)
    } catch {
      // bridge 未就绪时不打扰用户
    } finally {
      setChecking(false)
    }
  }, [serverUrl])

  // bridge 运行中但尚无状态 → 轮询直到拿到状态
  useEffect(() => {
    if (!running || piStatus || dismissed) return
    void fetchStatus()
    const timer = setInterval(() => {
      if (!serviceStore.piStatus) void fetchStatus()
    }, 5000)
    return () => clearInterval(timer)
  }, [running, piStatus, dismissed, fetchStatus])

  // 认证状态：优先 bridge pi-status，回退 Rust 侧直接检测（bridge 不可用时也能引导）
  const authed = piStatus ? piStatus.authed : piEnv?.authed
  if (!isTauri() || !running || dismissed || authed === undefined || authed) {
    return null
  }

  const handleDismiss = () => {
    setDismissed(true)
    try {
      sessionStorage.setItem(DISMISS_KEY, 'true')
    } catch {
      /* */
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4">
      <div className="w-full max-w-lg rounded-2xl border border-border-200/60 bg-bg-100 shadow-2xl">
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-2.5 mb-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-warning-bg text-warning-100 text-base">
              ⚠️
            </span>
            <h2 className="text-[length:var(--fs-lg)] font-semibold text-text-100">{t('title')}</h2>
          </div>
          <p className="text-[length:var(--fs-sm)] text-text-300 leading-relaxed">{t('description')}</p>
        </div>

        <div className="px-6 pb-4 flex flex-col gap-3">
          <div className="rounded-xl border border-border-200/50 bg-bg-200/30 px-4 py-3">
            <div className="text-[length:var(--fs-sm)] font-medium text-text-100 mb-1.5">
              {t('optionA')} <span className="text-accent-main-100 text-[length:var(--fs-xs)]">{t('recommended')}</span>
            </div>
            <ol className="text-[length:var(--fs-xs)] text-text-300 leading-relaxed list-decimal list-inside flex flex-col gap-1">
              <li>
                {t('installCli')}
                <code className="ml-1 px-1.5 py-0.5 rounded bg-bg-000 font-mono text-[length:var(--fs-xxs)] text-text-200 break-all">
                  npm i -g @earendil-works/pi-coding-agent
                </code>
              </li>
              <li>{t('loginCli')}</li>
            </ol>
          </div>

          <div className="rounded-xl border border-border-200/50 bg-bg-200/30 px-4 py-3">
            <div className="text-[length:var(--fs-sm)] font-medium text-text-100 mb-1.5">{t('optionB')}</div>
            <p className="text-[length:var(--fs-xs)] text-text-300 leading-relaxed">
              {t('envVarsHint')}
              <code className="ml-1 px-1.5 py-0.5 rounded bg-bg-000 font-mono text-[length:var(--fs-xxs)] text-text-200">
                ANTHROPIC_API_KEY
              </code>
            </p>
          </div>

          <p className="text-[length:var(--fs-xs)] text-text-500 leading-relaxed font-mono break-all">
            {t('agentDir')}: {piStatus?.agentDir || piEnv?.agentDir}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 pb-5">
          <button
            type="button"
            onClick={handleDismiss}
            className="h-8 px-3 rounded-lg text-[length:var(--fs-sm)] text-text-300 hover:text-text-100 hover:bg-bg-200/60 transition-colors"
          >
            {t('dismiss')}
          </button>
          <button
            type="button"
            onClick={() => void fetchStatus()}
            disabled={checking}
            className="h-8 px-3 rounded-lg text-[length:var(--fs-sm)] text-text-200 bg-bg-200/60 hover:bg-bg-200 transition-colors disabled:opacity-50"
          >
            {checking ? t('rechecking') : t('recheck')}
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="h-8 px-4 rounded-lg text-[length:var(--fs-sm)] font-medium text-oncolor-100 bg-accent-main-100 hover:bg-accent-main-200 transition-colors"
          >
            {t('openSettings')}
          </button>
        </div>
      </div>
    </div>
  )
})
