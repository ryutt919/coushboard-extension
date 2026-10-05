import { useCallback, useEffect, useState } from 'react'
import { COLLECT_KEY, type CollectState, effectiveState, IDLE_STATE } from './collectState'

export type StartMode = 'resume' | 'fresh'

export async function readCollectState(): Promise<CollectState> {
  const d = await chrome.storage.local.get(COLLECT_KEY)
  return effectiveState(d[COLLECT_KEY])
}

/** 수집 상태를 읽고 바뀔 때마다 갱신한다. 갱신이 끊긴 running 은 5초마다 다시 판정한다 */
export function useCollectState(): CollectState {
  const [state, setState] = useState<CollectState>(IDLE_STATE)
  useEffect(() => {
    let alive = true
    const refresh = () => void readCollectState().then((s) => alive && setState(s))
    refresh()
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && COLLECT_KEY in changes) refresh()
    }
    chrome.storage.onChanged.addListener(onChanged)
    const t = window.setInterval(refresh, 5000)
    return () => {
      alive = false
      window.clearInterval(t)
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [])
  return state
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
