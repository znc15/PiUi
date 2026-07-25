import { useCallback, useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircleIcon, CheckIcon, ChevronDownIcon, SettingsIcon, UndoIcon } from '../../../components/Icons'
import { Button } from '../../../components/ui/Button'
import { Dialog } from '../../../components/ui/Dialog'
import { getConfig, getGlobalConfig, getProviderConfigs } from '../../../api'
import { http } from '../../../api/httpClient'
import { unwrap } from '../../../api/sdk'
import { useCurrentDirectory } from '../../../hooks'
import {
  SegmentedControl,
  SettingField,
  SettingRow,
  SettingsSection,
  SettingsSubgroup,
  Toggle,
  settingsFieldAreaClass,
  settingsFieldClass,
} from './SettingsUI'

type JsonRecord = Record<string, unknown>
type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type TrustLevel = 'ask' | 'always' | 'never'
type QueueMode = 'all' | 'one-at-a-time'

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const TRUST_LEVELS: TrustLevel[] = ['ask', 'always', 'never']
const QUEUE_MODES: QueueMode[] = ['all', 'one-at-a-time']

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function getNested(config: JsonRecord, path: string[]): unknown {
  let cur: unknown = config
  for (const key of path) {
    if (!isRecord(cur)) return undefined
    cur = cur[key]
  }
  return cur
}

function setNested(config: JsonRecord, path: string[], value: unknown): JsonRecord {
  const next = clone(config)
  let cur: JsonRecord = next
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    const child = cur[key]
    cur[key] = isRecord(child) ? { ...child } : {}
    cur = cur[key] as JsonRecord
  }
  const last = path[path.length - 1]
  if (value === undefined) delete cur[last]
  else cur[last] = value
  return next
}

function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${settingsFieldClass} ${props.className || ''}`} />
}

function NumberInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="number" {...props} className={`${settingsFieldClass} ${props.className || ''}`} />
}

function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className={`${settingsFieldClass} h-10 appearance-none bg-bg-100/80 pl-3 pr-10 shadow-sm hover:bg-bg-200/45 hover:border-border-300 focus-visible:bg-bg-100 cursor-pointer ${props.className || ''}`}
      />
      <ChevronDownIcon
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-400"
      />
    </div>
  )
}

function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${settingsFieldAreaClass} ${props.className || ''}`} />
}

async function saveGlobalConfigReplace(config: JsonRecord): Promise<JsonRecord> {
  return unwrap(await http.patch('/global/config', { replace: true, config })) as JsonRecord
}

function PiConfigEditorDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation('settings')
  const lang = i18n.language?.startsWith('zh') ? 'zh' : 'en'
  const directory = useCurrentDirectory()
  const [config, setConfig] = useState<JsonRecord>({})
  const [original, setOriginal] = useState<JsonRecord>({})
  const [paths, setPaths] = useState<JsonRecord>({})
  const [providers, setProviders] = useState<{ id: string; models: string[] }[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  const loadReq = useRef(0)
  const dirty = !sameValue(config, original)

  const tx = useCallback((en: string, zh: string) => (lang === 'zh' ? zh : en), [lang])

  const load = useCallback(async () => {
    if (!isOpen) return
    const req = ++loadReq.current
    setLoading(true)
    setError(null)
    try {
      const [global, effective, providerRes] = await Promise.all([
        getGlobalConfig(),
        getConfig(directory).catch(() => ({})),
        getProviderConfigs(directory).catch(() => undefined),
      ])
      if (req !== loadReq.current) return
      const globalRec = isRecord(global) ? global : {}
      setOriginal(clone(globalRec))
      setConfig(clone(globalRec))
      if (isRecord(effective) && isRecord(effective._paths)) setPaths(effective._paths as JsonRecord)

      const list: { id: string; models: string[] }[] = []
      if (isRecord(providerRes) && Array.isArray(providerRes.providers)) {
        for (const item of providerRes.providers) {
          if (!isRecord(item)) continue
          const id = asString(item.id)
          if (!id) continue
          const models = isRecord(item.models) ? Object.keys(item.models) : []
          list.push({ id, models })
        }
      }
      setProviders(list)
    } catch (err) {
      if (req !== loadReq.current) return
      setError(err instanceof Error ? err.message : t('config.loadFailed'))
    } finally {
      if (req === loadReq.current) setLoading(false)
    }
  }, [directory, isOpen, t])

  useEffect(() => {
    if (isOpen) void load()
    else loadReq.current += 1
  }, [isOpen, load])

  const setField = useCallback((path: string[], value: unknown) => {
    setConfig(prev => setNested(prev, path, value))
  }, [])

  const modelOptions = useMemo(() => {
    const provider = asString(config.defaultProvider)
    return providers.find(p => p.id === provider)?.models ?? []
  }, [config.defaultProvider, providers])

  const packagesText = useMemo(() => {
    const packages = config.packages
    if (!Array.isArray(packages)) return ''
    return packages.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n')
  }, [config.packages])

  const requestClose = () => {
    if (saving) return
    if (dirty && !window.confirm(t('config.discardChangesConfirm'))) return
    onClose()
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const saved = await saveGlobalConfigReplace(config)
      setOriginal(clone(saved))
      setConfig(clone(saved))
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 1600)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('config.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const compaction = isRecord(config.compaction) ? config.compaction : {}
  const retry = isRecord(config.retry) ? config.retry : {}
  const images = isRecord(config.images) ? config.images : {}

  return (
    <Dialog isOpen={isOpen} onClose={requestClose} title={t('config.sourceTitle')} width={920} className="w-full">
      <div className="flex flex-col gap-5 animate-in fade-in duration-200">
        {error && (
          <div className="rounded-lg bg-error-100/10 px-3 py-2 text-[length:var(--fs-sm)] text-error-100 animate-in fade-in">
            {error}
          </div>
        )}

        <div className="rounded-lg border border-border-200/50 bg-bg-200/20 px-3.5 py-3 text-[length:var(--fs-xs)] text-text-400">
          <div className="mb-1 font-medium text-text-300">{tx('Pi Agent settings files', 'Pi Agent 配置文件')}</div>
          <div className="break-all font-mono">{asString(paths.globalSettings, '~/.pi/agent/settings.json')}</div>
          {asString(paths.projectSettings) ? (
            <div className="mt-1 break-all font-mono opacity-80">{asString(paths.projectSettings)}</div>
          ) : null}
        </div>

        {loading ? (
          <div className="text-[length:var(--fs-sm)] text-text-400">{t('config.loading')}</div>
        ) : (
          <div className="space-y-6">
            <SettingsSection
              title={tx('Model & Thinking', '模型与思考')}
              description={tx('Default model selection for new Pi Agent sessions.', '新建 Pi Agent 会话时的默认模型。')}
            >
              <SettingsSubgroup>
                <SettingField label={tx('Default provider', '默认 Provider')}>
                  <SelectInput
                    value={asString(config.defaultProvider)}
                    onChange={e => {
                      const provider = e.target.value
                      setConfig(prev => {
                        let next = setNested(prev, ['defaultProvider'], provider || undefined)
                        const models = providers.find(p => p.id === provider)?.models ?? []
                        if (models.length && !models.includes(asString(next.defaultModel))) {
                          next = setNested(next, ['defaultModel'], models[0])
                        }
                        return next
                      })
                    }}
                  >
                    <option value="">{tx('Not set', '未设置')}</option>
                    {providers.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                      </option>
                    ))}
                  </SelectInput>
                </SettingField>

                <SettingField label={tx('Default model', '默认模型')}>
                  <SelectInput
                    value={asString(config.defaultModel)}
                    onChange={e => setField(['defaultModel'], e.target.value || undefined)}
                  >
                    <option value="">{tx('Not set', '未设置')}</option>
                    {modelOptions.map(id => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </SelectInput>
                </SettingField>

                <SettingField label={tx('Thinking level', '思考级别')}>
                  <SelectInput
                    value={
                      THINKING_LEVELS.includes(asString(config.defaultThinkingLevel) as ThinkingLevel)
                        ? asString(config.defaultThinkingLevel)
                        : 'medium'
                    }
                    onChange={e => setField(['defaultThinkingLevel'], e.target.value)}
                  >
                    {THINKING_LEVELS.map(level => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </SelectInput>
                </SettingField>

                <SettingRow
                  label={tx('Hide thinking blocks', '隐藏思考块')}
                  description={tx('Hide model reasoning in the transcript.', '在对话中隐藏模型思考过程。')}
                >
                  <Toggle
                    enabled={asBoolean(config.hideThinkingBlock)}
                    onChange={() => setField(['hideThinkingBlock'], !asBoolean(config.hideThinkingBlock) || undefined)}
                  />
                </SettingRow>
              </SettingsSubgroup>
            </SettingsSection>

            <SettingsSection
              title={tx('Session behavior', '会话行为')}
              description={tx('Steering, follow-up, and project trust defaults.', '引导消息、追问与项目信任默认值。')}
            >
              <SettingsSubgroup>
                <SettingField label={tx('Steering mode', '引导模式')}>
                  <SegmentedControl
                    value={
                      (QUEUE_MODES.includes(asString(config.steeringMode) as QueueMode)
                        ? asString(config.steeringMode)
                        : 'all') as QueueMode
                    }
                    options={QUEUE_MODES.map(v => ({ value: v, label: v }))}
                    onChange={value => setField(['steeringMode'], value)}
                  />
                </SettingField>

                <SettingField label={tx('Follow-up mode', '追问模式')}>
                  <SegmentedControl
                    value={
                      (QUEUE_MODES.includes(asString(config.followUpMode) as QueueMode)
                        ? asString(config.followUpMode)
                        : 'all') as QueueMode
                    }
                    options={QUEUE_MODES.map(v => ({ value: v, label: v }))}
                    onChange={value => setField(['followUpMode'], value)}
                  />
                </SettingField>

                <SettingField
                  label={tx('Default project trust', '默认项目信任')}
                  description={tx('Global only. Controls loading project .pi resources.', '仅全局生效，控制是否加载项目 .pi 资源。')}
                >
                  <SelectInput
                    value={
                      TRUST_LEVELS.includes(asString(config.defaultProjectTrust) as TrustLevel)
                        ? asString(config.defaultProjectTrust)
                        : 'ask'
                    }
                    onChange={e => setField(['defaultProjectTrust'], e.target.value)}
                  >
                    <option value="ask">{tx('Ask every time', '每次询问')}</option>
                    <option value="always">{tx('Always trust', '始终信任')}</option>
                    <option value="never">{tx('Never trust', '从不信任')}</option>
                  </SelectInput>
                </SettingField>

                <SettingRow label={tx('Enable skill commands', '启用 Skill 命令')}>
                  <Toggle
                    enabled={asBoolean(config.enableSkillCommands, true)}
                    onChange={() => setField(['enableSkillCommands'], !asBoolean(config.enableSkillCommands, true))}
                  />
                </SettingRow>
              </SettingsSubgroup>
            </SettingsSection>

            <SettingsSection
              title={tx('Compaction', '上下文压缩')}
              description={tx('Auto-summarize long sessions to free context.', '自动摘要长会话以释放上下文。')}
            >
              <SettingsSubgroup>
                <SettingRow label={tx('Enabled', '启用')}>
                  <Toggle
                    enabled={asBoolean(compaction.enabled, true)}
                    onChange={() => setField(['compaction', 'enabled'], !asBoolean(compaction.enabled, true))}
                  />
                </SettingRow>
                <SettingField label={tx('Reserve tokens', '预留 tokens')}>
                  <NumberInput
                    min={0}
                    value={asNumber(compaction.reserveTokens, 16384)}
                    onChange={e => setField(['compaction', 'reserveTokens'], Number(e.target.value))}
                  />
                </SettingField>
                <SettingField label={tx('Keep recent tokens', '保留最近 tokens')}>
                  <NumberInput
                    min={0}
                    value={asNumber(compaction.keepRecentTokens, 20000)}
                    onChange={e => setField(['compaction', 'keepRecentTokens'], Number(e.target.value))}
                  />
                </SettingField>
              </SettingsSubgroup>
            </SettingsSection>

            <SettingsSection title={tx('Shell & network', 'Shell 与网络')}>
              <SettingsSubgroup>
                <SettingField label={tx('Shell path', 'Shell 路径')}>
                  <TextInput
                    value={asString(config.shellPath)}
                    placeholder="/bin/zsh"
                    onChange={e => setField(['shellPath'], e.target.value || undefined)}
                  />
                </SettingField>
                <SettingField label={tx('Shell command prefix', 'Shell 命令前缀')}>
                  <TextInput
                    value={asString(config.shellCommandPrefix)}
                    placeholder="source ~/.zshrc &&"
                    onChange={e => setField(['shellCommandPrefix'], e.target.value || undefined)}
                  />
                </SettingField>
                <SettingField
                  label={tx('HTTP proxy', 'HTTP 代理')}
                  description={tx('Applied as HTTP_PROXY / HTTPS_PROXY for Pi.', '作为 Pi 的 HTTP_PROXY / HTTPS_PROXY。')}
                >
                  <TextInput
                    value={asString(config.httpProxy)}
                    placeholder="http://127.0.0.1:7890"
                    onChange={e => setField(['httpProxy'], e.target.value || undefined)}
                  />
                </SettingField>
              </SettingsSubgroup>
            </SettingsSection>

            <SettingsSection
              title={tx('Packages', '扩展包')}
              description={tx('One package per line, e.g. npm:pi-subagents@0.35.1', '每行一个包，例如 npm:pi-subagents@0.35.1')}
            >
              <TextArea
                rows={6}
                value={packagesText}
                onChange={e => {
                  const lines = e.target.value
                    .split('\n')
                    .map(line => line.trim())
                    .filter(Boolean)
                  setField(['packages'], lines.length ? lines : undefined)
                }}
              />
            </SettingsSection>

            <SettingsSection title={tx('Retry & images', '重试与图片')}>
              <SettingsSubgroup>
                <SettingRow label={tx('Retry enabled', '启用重试')}>
                  <Toggle
                    enabled={asBoolean(getNested(retry, ['enabled']), true)}
                    onChange={() => setField(['retry', 'enabled'], !asBoolean(getNested(retry, ['enabled']), true))}
                  />
                </SettingRow>
                <SettingField label={tx('Max retries', '最大重试次数')}>
                  <NumberInput
                    min={0}
                    value={asNumber(getNested(retry, ['maxRetries']), 3)}
                    onChange={e => setField(['retry', 'maxRetries'], Number(e.target.value))}
                  />
                </SettingField>
                <SettingRow label={tx('Auto resize images', '自动缩放图片')}>
                  <Toggle
                    enabled={asBoolean(images.autoResize, true)}
                    onChange={() => setField(['images', 'autoResize'], !asBoolean(images.autoResize, true))}
                  />
                </SettingRow>
              </SettingsSubgroup>
            </SettingsSection>

            <SettingsSection
              title={tx('Raw JSON', '原始 JSON')}
              description={tx('Advanced: edit the full Pi settings.json payload.', '高级：直接编辑完整 Pi settings.json。')}
            >
              <TextArea
                rows={12}
                spellCheck={false}
                value={JSON.stringify(config, null, 2)}
                onChange={e => {
                  try {
                    const parsed = JSON.parse(e.target.value)
                    if (!isRecord(parsed)) throw new Error('root must be object')
                    setConfig(parsed)
                    setError(null)
                  } catch (parseErr) {
                    setError(parseErr instanceof Error ? parseErr.message : 'Invalid JSON')
                  }
                }}
                className="font-mono text-[length:var(--fs-xs)]"
              />
            </SettingsSection>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border-200/40 pt-3">
          {dirty && <span className="mr-auto text-[length:var(--fs-xs)] text-warning-100">{t('config.unsaved')}</span>}
          {savedFlash && (
            <span className="mr-auto inline-flex items-center gap-1 text-[length:var(--fs-xs)] text-success-100 animate-in fade-in">
              <CheckIcon size={12} />
              {tx('Saved', '已保存')}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || loading || saving}
            onClick={() => {
              setConfig(clone(original))
              setError(null)
            }}
          >
            <UndoIcon size={13} />
            {t('config.reset')}
          </Button>
          <Button variant="secondary" size="sm" disabled={saving} onClick={requestClose}>
            {tx('Close', '关闭')}
          </Button>
          <Button variant="primary" size="sm" isLoading={saving} disabled={!dirty || loading} onClick={() => void save()}>
            {t('config.saveAll')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function PiConfigSettings() {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)

  return (
    <div className="animate-in fade-in duration-200">
      <SettingsSection
        title={t('config.sourceTitle')}
        description={t('config.sourceDesc')}
        actions={
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <SettingsIcon size={14} />
            {t('config.openEditor')}
          </Button>
        }
      >
        <div className="flex items-start gap-2.5 rounded-lg border border-accent-main-100/20 bg-accent-main-100/5 px-3.5 py-3 text-[length:var(--fs-sm)] leading-relaxed text-text-300">
          <AlertCircleIcon size={14} className="mt-0.5 shrink-0 text-accent-main-100" />
          <span>{t('config.sdkOnlyWarning')}</span>
        </div>
      </SettingsSection>
      <PiConfigEditorDialog isOpen={open} onClose={() => setOpen(false)} />
    </div>
  )
}

/** Keep old export name for SettingsDialog compatibility. */
export function ConfigSettings() {
  return <PiConfigSettings />
}
