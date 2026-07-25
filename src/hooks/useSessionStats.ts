import { useEffect, useSyncExternalStore, useState } from 'react'
import { messageStore } from '../store/messageStore'
import { paneLayoutStore } from '../store/paneLayoutStore'
import type { SessionStats } from './sessionStatsTypes'
import { getSessionStats } from '../api/session'

export type { SessionStats } from './sessionStatsTypes'
export { formatTokens, formatCost } from './sessionStatsUtils'

function emptyStats(contextLimit: number): SessionStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    contextUsed: 0,
    contextLimit,
    contextPercent: 0,
    contextEstimated: false,
  }
}

function subscribeFocusedSession(onStoreChange: () => void) {
  const unsubPane = paneLayoutStore.subscribe(onStoreChange)
  const unsubMessages = messageStore.subscribe(onStoreChange)
  return () => {
    unsubPane()
    unsubMessages()
  }
}

function getFocusedSessionSignature(): string {
  const sessionId = paneLayoutStore.getFocusedSessionId() ?? ''
  const state = messageStore.getSessionState(sessionId)
  const last = state?.messages.at(-1)
  return [
    sessionId,
    state?.isStreaming ? 'streaming' : 'idle',
    state?.messages.length ?? 0,
    last?.info.id ?? '',
    last?.info.time?.completed ?? '',
  ].join('|')
}

/** Current focused-session usage reported by Pi. No character-based fallback. */
export function useSessionStats(contextLimit: number = 200000): SessionStats {
  const signature = useSyncExternalStore(
    subscribeFocusedSession,
    getFocusedSessionSignature,
    getFocusedSessionSignature,
  )
  const [stats, setStats] = useState<SessionStats>(() => emptyStats(contextLimit))

  useEffect(() => {
    const [sessionId, streamState] = signature.split('|')
    if (!sessionId) {
      setStats(emptyStats(contextLimit))
      return
    }

    // Pi finalizes authoritative usage at message_end. Keep the previous real
    // values while streaming, then refresh immediately after settlement.
    if (streamState === 'streaming') return

    let cancelled = false
    void getSessionStats(sessionId)
      .then(next => {
        if (!cancelled) setStats(next)
      })
      .catch(() => {
        if (!cancelled) setStats(emptyStats(contextLimit))
      })
    return () => {
      cancelled = true
    }
  }, [contextLimit, signature])

  return stats
}
