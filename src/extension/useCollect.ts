import { useCallback, useEffect, useState } from 'react'
import { canIncremental, COLLECT_KEY, type CollectState, effectiveState, IDLE_STATE, SYNC_KEY, type SyncInfo } from './collectState'

export type StartMode = 'resume' | 'fresh' | 'new'

export interface CollectInfo {
  state: CollectState
  sync: SyncInfo | undefined
  /** 새 주문만 가져오기를 쓸 수 있는지(전체 수집을 한 번 끝냈고 저장된 주문이 있음) */
  canNew: boolean
}

/** 수집 상태와 마지막 수집 기록을 읽고 바뀔 때마다 갱신한다. 갱신이 끊긴 running 은 5초마다 다시 판정한다 */
export function useCollectInfo(): CollectInfo {
  const [info, setInfo] = useState<CollectInfo>({ state: IDLE_STATE, sync: undefined, canNew: false })
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      const d = await chrome.storage.local.get([COLLECT_KEY, SYNC_KEY, 'orders'])
      if (!alive) return
      const raw = d[COLLECT_KEY] as CollectState | undefined
      const count = Array.isArray(d.orders) ? d.orders.length : 0
      setInfo({ state: effectiveState(raw), sync: d[SYNC_KEY], canNew: canIncremental(d[SYNC_KEY], raw, count) })
    }
    void refresh()
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && (COLLECT_KEY in changes || SYNC_KEY in changes || 'orders' in changes)) void refresh()
    }
    chrome.storage.onChanged.addListener(onChanged)
    const t = window.setInterval(() => void refresh(), 5000)
    return () => {
      alive = false
      window.clearInterval(t)
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [])
  return info
}

export function useCollectActions(): { start: (m: StartMode) => Promise<string | null>; abort: () => Promise<string | null> } {
  const call = useCallback(async (message: Record<string, unknown>) => {
    const res = await chrome.runtime.sendMessage(message)
    return res?.ok ? null : ((res?.error as string) ?? '요청을 처리하지 못했습니다.')
  }, [])
  return {
    start: (mode) => call({ type: 'START_COLLECT', mode }),
    abort: () => call({ type: 'ABORT_COLLECT' }),
  }
}
