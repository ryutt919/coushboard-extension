import { useState } from 'react'
import { progressText } from './collectState'
import { useCollectActions, useCollectState } from './useCollect'

/** 쿠팡에서 주문을 가져오는 막대. 상태는 저장소에 있어 이 탭이나 팝업을 닫았다 열어도 그대로 이어서 보인다 */
export function CollectBar() {
  const s = useCollectState()
  const { start, abort } = useCollectActions()
  const [msg, setMsg] = useState<string | null>(null)
  const running = s.status === 'running'
  const canResume = (s.status === 'aborted' || s.status === 'error') && s.checkpoint !== null

  async function go(fn: () => Promise<string | null>) {
    setMsg(await fn())
  }

  return (
    <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--line)' }} data-testid="collect-bar">
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '10px 24px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>쿠팡에서 가져오기</strong>
        <span role="status" data-testid="collect-status" data-status={s.status} style={{ fontSize: 14, color: 'var(--muted)' }}>
          {progressText(s)}
        </span>
        <span style={{ flex: 1 }} />
        {running ? (
          <button type="button" className="btn sm" data-testid="collect-abort" onClick={() => void go(abort)}>
            중단
          </button>
        ) : (
          <>
            {canResume && (
              <button type="button" className="btn sm primary" data-testid="collect-resume" onClick={() => void go(() => start('resume'))}>
                이어서 수집
              </button>
            )}
            <button type="button" className={'btn sm' + (canResume ? '' : ' primary')} data-testid="collect-start" onClick={() => void go(() => start('fresh'))}>
              {canResume ? '처음부터 다시' : s.status === 'done' ? '다시 가져오기' : '가져오기 시작'}
            </button>
          </>
        )}
      </div>
      {msg && (
        <div style={{ maxWidth: 1240, margin: '0 auto', padding: '0 24px 10px', fontSize: 13, color: 'var(--bad)' }} role="alert" data-testid="collect-msg">
          {msg}
        </div>
      )}
    </div>
  )
}
