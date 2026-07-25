import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import { TrashIcon, WifiIcon, WifiOffIcon, SpinnerIcon, StopIcon, CheckIcon, AlertCircleIcon } from '../../../components/Icons'
import { useServerStore, useIsMobile } from '../../../hooks'
import { API_BASE_URL } from '../../../constants'
import { LOCAL_SERVER_ID } from '../../../store/serverStore'
import { serviceStore, useServiceStore, type PiEnvironment, type PiStatus } from '../../../store/serviceStore'
import { isTauri } from '../../../utils/tauri'
import { apiErrorHandler } from '../../../utils'
import { applyLocalServiceUrl } from '../../../utils/localServiceUrl'
import { settingsFieldClass, Toggle, SettingRow, SettingField, SettingsSection } from './SettingsUI'

interface StartPiServiceResult {
  started: boolean
  startedByUs: boolean
  url?: string | null
}

export function ServiceSettings() {
  const { t } = useTranslation(['settings', 'common'])
  const isMobile = useIsMobile()
  const {
    autoStart: autoStartService,
    nodePath,
    piEnv,
    piStatus,
    envVars,
    running: serviceRunning,
    startedByUs,
    starting: serviceStarting,
    lastError,
  } = useServiceStore()
  const { servers } = useServerStore()
  const localServer = servers.find(server => server.id === LOCAL_SERVER_ID)
  const isTauriDesktop = isTauri() && !isMobile

  // 本地编辑状态（debounce 保存）
  const [localNodePath, setLocalNodePath] = useState(nodePath)
  const pathDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingNodePathRef = useRef<string | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [checkingService, setCheckingService] = useState(false)
  const [stoppingService, setStoppingService] = useState(false)
  const serviceOperationRef = useRef(0)
  const mountedRef = useRef(true)
  const [serviceError, setServiceError] = useState('')

  // 同步外部变化
  useEffect(() => {
    if (pathDebounceRef.current) {
      clearTimeout(pathDebounceRef.current)
      pathDebounceRef.current = null
    }
    pendingNodePathRef.current = null
    setLocalNodePath(nodePath)
  }, [nodePath])

  useEffect(
    () => () => {
      if (pathDebounceRef.current) clearTimeout(pathDebounceRef.current)
      if (pendingNodePathRef.current !== null) serviceStore.setNodePath(pendingNodePathRef.current)
    },
    [],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const getServerUrl = () => localServer?.url || API_BASE_URL

  const handleDetectEnvironment = useCallback(async () => {
    if (!isTauriDesktop) return
    setDetecting(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const env = await invoke<PiEnvironment>('detect_pi_environment', {
        envVars: serviceStore.envVarsRecord,
      })
      serviceStore.setPiEnv(env)
    } catch (e) {
      apiErrorHandler('detect Pi environment', e)
    } finally {
      if (mountedRef.current) setDetecting(false)
    }
  }, [isTauriDesktop])

  const handleRefreshPiStatus = useCallback(async () => {
    try {
      const response = await fetch(`${getServerUrl()}/global/pi-status`, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const status = (await response.json()) as PiStatus
      serviceStore.setPiStatus(status)
    } catch {
      serviceStore.setPiStatus(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localServer?.url])

  // 打开设置页时检测一次
  useEffect(() => {
    if (!isTauriDesktop) return
    void handleCheckService()
    void handleDetectEnvironment()
    void handleRefreshPiStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTauriDesktop])

  // 服务运行中但尚未拿到 pi-status → 定期重试
  // （覆盖 bridge 还在启动、或外部服务版本较旧的情况）
  useEffect(() => {
    if (!isTauriDesktop || !serviceRunning || piStatus) return
    void handleRefreshPiStatus()
    const timer = setInterval(() => {
      if (!serviceStore.piStatus) void handleRefreshPiStatus()
    }, 5000)
    return () => clearInterval(timer)
  }, [isTauriDesktop, serviceRunning, piStatus, handleRefreshPiStatus])

  const handleAutoStartToggle = () => {
    serviceStore.setAutoStart(!autoStartService)
  }

  const handleNodePathChange = (v: string) => {
    setLocalNodePath(v)
    pendingNodePathRef.current = v
    if (pathDebounceRef.current) clearTimeout(pathDebounceRef.current)
    pathDebounceRef.current = setTimeout(() => {
      pathDebounceRef.current = null
      pendingNodePathRef.current = null
      serviceStore.setNodePath(v)
    }, 400)
  }

  const handleStartService = async () => {
    const operation = ++serviceOperationRef.current
    setServiceError('')
    serviceStore.setStarting(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke<StartPiServiceResult>('start_pi_service', {
        url: getServerUrl(),
        nodePath: serviceStore.effectiveNodePath,
        envVars: serviceStore.envVarsRecord,
      })
      if (operation !== serviceOperationRef.current) return
      applyLocalServiceUrl(result.url)
      serviceStore.setSuppressAutoRestart(false)
      serviceStore.setStartedByUs(result.startedByUs)
      serviceStore.setRunning(true)
      serviceStore.setLastError('')
      void handleRefreshPiStatus()
    } catch (e) {
      if (operation !== serviceOperationRef.current) return
      const msg = String(e)
      serviceStore.setLastError(msg)
      apiErrorHandler('start service', msg)
      if (mountedRef.current) setServiceError(msg)
    } finally {
      serviceStore.setStarting(false)
    }
  }

  const handleStopService = async () => {
    const operation = ++serviceOperationRef.current
    setServiceError('')
    setStoppingService(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('stop_pi_service')
      serviceStore.setSuppressAutoRestart(true)
      if (operation !== serviceOperationRef.current) return
      serviceStore.setStartedByUs(false)
      serviceStore.setRunning(false)
      serviceStore.setPiStatus(null)
    } catch (e) {
      if (operation !== serviceOperationRef.current) return
      apiErrorHandler('stop service', e)
    } finally {
      if (operation === serviceOperationRef.current && mountedRef.current) setStoppingService(false)
    }
  }

  const handleCheckService = async () => {
    const operation = ++serviceOperationRef.current
    setCheckingService(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const running = await invoke<boolean>('check_pi_service', { url: getServerUrl() })
      if (operation !== serviceOperationRef.current) return
      serviceStore.setRunning(running)
      if (running) {
        const byUs = await invoke<boolean>('get_service_started_by_us')
        if (operation !== serviceOperationRef.current) return
        serviceStore.setStartedByUs(byUs)
        void handleRefreshPiStatus()
      } else {
        serviceStore.setStartedByUs(false)
        serviceStore.setPiStatus(null)
      }
    } catch (e) {
      if (operation !== serviceOperationRef.current) return
      apiErrorHandler('check service', e)
    } finally {
      if (operation === serviceOperationRef.current && mountedRef.current) setCheckingService(false)
    }
  }

  if (!isTauriDesktop) {
    return (
      <SettingsSection title={t('service.localService')} description={t('service.desktopOnlyDesc')}>
        <div className="text-[length:var(--fs-xs)] text-text-300 leading-relaxed">{t('service.webModeDesc')}</div>
      </SettingsSection>
    )
  }

  const displayedError = serviceError || lastError

  // 认证状态：优先用 bridge 的 pi-status；bridge 不可用时回退到 Rust 侧直接检测结果
  const authInfo = piStatus
    ? { authed: piStatus.authed, names: [...piStatus.authProviders, ...piStatus.envKeys] }
    : piEnv
      ? { authed: piEnv.authed, names: piEnv.authProviders }
      : null

  return (
    <SettingsSection title={t('service.localService')} description={t('service.localServiceDesc')}>
      {/* 运行环境信息 */}
      <SettingField
        label={t('service.runtimeInfo')}
        description={t('service.runtimeInfoDesc')}
        actions={
          <button
            type="button"
            className="h-7 px-2 rounded-md text-[length:var(--fs-xs)] font-medium text-accent-main-100 hover:bg-accent-main-100/10 transition-colors disabled:opacity-50"
            onClick={handleDetectEnvironment}
            disabled={detecting}
          >
            {detecting ? t('service.detectingRuntime') : t('service.detectRuntime')}
          </button>
        }
      >
        <div className="flex flex-col gap-1.5 text-[length:var(--fs-xs)] font-mono">
          <RuntimeInfoRow
            label="Node.js"
            value={piEnv?.nodePath ? `${piEnv.nodeVersion ?? ''} · ${piEnv.nodePath}` : null}
            missingHint={t('service.nodeMissing')}
          />
          <RuntimeInfoRow
            label="pi CLI"
            value={piEnv?.piPath ? `${piEnv.piVersion ?? ''} · ${piEnv.piPath}` : null}
            missingHint={t('service.piMissing')}
          />
          <RuntimeInfoRow
            label={t('service.authStatus')}
            value={
              authInfo
                ? authInfo.authed
                  ? `${t('service.authed')}${authInfo.names.length > 0 ? ` (${authInfo.names.join(', ')})` : ''}`
                  : t('service.notAuthed')
                : null
            }
            missingHint={serviceRunning ? t('service.authUnknownRunning') : t('service.authUnknown')}
            danger={authInfo ? !authInfo.authed : false}
          />
        </div>
      </SettingField>

      <SettingRow
        label={t('service.autoStart')}
        description={t('service.autoStartDesc')}
        onClick={handleAutoStartToggle}
      >
        <Toggle enabled={autoStartService} onChange={handleAutoStartToggle} />
      </SettingRow>

      <SettingRow
        label={t('service.serviceStatus')}
        description={
          serviceStarting
            ? t('service.starting')
            : serviceRunning
              ? startedByUs
                ? t('service.runningStartedByApp')
                : t('service.runningExternal')
              : t('service.notRunning')
        }
        icon={
          serviceStarting ? (
            <SpinnerIcon size={14} className="animate-spin text-text-400" />
          ) : serviceRunning ? (
            <WifiIcon size={14} className="text-success-100" />
          ) : (
            <WifiOffIcon size={14} className="text-text-400" />
          )
        }
      >
        <div className="flex items-center gap-1.5">
          {!serviceStarting && !serviceRunning && (
            <Button size="sm" variant="ghost" onClick={handleStartService} disabled={checkingService || stoppingService}>
              {t('common:start')}
            </Button>
          )}
          {!serviceStarting && serviceRunning && startedByUs && (
            <Button size="sm" variant="ghost" onClick={handleStopService} disabled={checkingService || stoppingService}>
              <StopIcon size={12} className="mr-1" />
              {t('common:stop')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={handleCheckService} disabled={serviceStarting || checkingService || stoppingService}>
            {t('common:refresh')}
          </Button>
        </div>
      </SettingRow>

      <SettingField
        label={t('service.nodePath')}
        description={t('service.nodePathHelp')}
      >
        <input
          type="text"
          value={localNodePath}
          onChange={e => handleNodePathChange(e.target.value)}
          placeholder={t('service.nodePathPlaceholder')}
          className={`${settingsFieldClass} font-mono`}
        />
        <div className="text-[length:var(--fs-xs)] text-text-500 mt-1.5 font-mono break-all">
          {localNodePath.trim()
            ? t('service.usingManualNode')
            : piEnv?.nodePath
              ? t('service.detectedNode', { path: piEnv.nodePath })
              : t('service.detectedNodeMissing')}
        </div>
      </SettingField>

      <SettingField
        label={t('service.envVars')}
        description={t('service.envVarsDesc')}
        actions={
          <button
            type="button"
            className="h-7 px-2 rounded-md text-[length:var(--fs-xs)] font-medium text-accent-main-100 hover:bg-accent-main-100/10 transition-colors"
            onClick={() => serviceStore.setEnvVars([...envVars, { key: '', value: '' }])}
          >
            + {t('common:add')}
          </button>
        }
      >
        {envVars.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {envVars.map((env, idx) => (
              <div
                key={idx}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1.5fr)_auto] items-center gap-1.5 sm:flex sm:items-center"
              >
                <input
                  type="text"
                  value={env.key}
                  onChange={e => {
                    const updated = [...envVars]
                    updated[idx] = { ...updated[idx], key: e.target.value }
                    serviceStore.setEnvVars(updated)
                  }}
                  placeholder={t('service.keyPlaceholder')}
                  className={`${settingsFieldClass} min-w-0 font-mono text-[length:var(--fs-xs)] sm:w-[120px] sm:shrink-0`}
                />
                <span className="text-text-500 text-[length:var(--fs-xs)] shrink-0">=</span>
                <input
                  type="text"
                  value={env.value}
                  onChange={e => {
                    const updated = [...envVars]
                    updated[idx] = { ...updated[idx], value: e.target.value }
                    serviceStore.setEnvVars(updated)
                  }}
                  placeholder={t('service.valuePlaceholder')}
                  className={`${settingsFieldClass} min-w-0 font-mono text-[length:var(--fs-xs)] sm:flex-1`}
                />
                <button
                  type="button"
                  className="shrink-0 w-8 h-8 flex items-center justify-center text-text-400 hover:text-danger-100
                    hover:bg-danger-100/10 rounded-lg transition-colors"
                  onClick={() => {
                    const updated = envVars.filter((_, i) => i !== idx)
                    serviceStore.setEnvVars(updated)
                  }}
                  title={t('common:remove')}
                >
                  <TrashIcon size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </SettingField>

      {displayedError && (
        <div className="text-[length:var(--fs-sm)] text-danger-100 bg-danger-100/10 border border-danger-100/20 rounded-lg px-3 py-2.5 leading-relaxed break-all">
          {displayedError}
        </div>
      )}
    </SettingsSection>
  )
}

function RuntimeInfoRow({
  label,
  value,
  missingHint,
  danger,
}: {
  label: string
  value: string | null
  missingHint: string
  danger?: boolean
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="shrink-0 w-20 text-text-400">{label}</span>
      {value ? (
        <span className={`break-all flex items-start gap-1 ${danger ? 'text-warning-100' : 'text-text-200'}`}>
          {danger ? <AlertCircleIcon size={11} className="mt-0.5 shrink-0" /> : <CheckIcon size={11} className="mt-0.5 shrink-0 text-success-100" />}
          <span className="break-all">{value}</span>
        </span>
      ) : (
        <span className="text-text-500 break-all">{missingHint}</span>
      )}
    </div>
  )
}
