// 수집 진행 상태. 콘텐츠 스크립트가 chrome.storage.local 의 `collect` 키에 쓰고, 팝업과 대시보드가 읽는다.
// 팝업을 닫아도 상태가 남아 있어 다시 열면 이어서 보이고, 수집이 도는 중에는 새 수집을 시작하지 못한다.
export const COLLECT_KEY = 'collect'
/** 이 시간(ms) 동안 갱신이 없는 running 상태는 수집이 끊긴 것(탭 닫힘, 이동, 새로고침)으로 본다 */
export const STALE_MS = 30_000

export type CollectStatus = 'idle' | 'running' | 'done' | 'error' | 'aborted'

export interface CollectState {
  status: CollectStatus
  runId: string | null
  startedAt: number | null
  updatedAt: number | null
  years: string[]
  year: string | null
  yearIndex: number
  page: number
  /** 이번 실행에서 저장한 상품 행 수 */
  rows: number
  perYear: Record<string, number>
  /** 마지막으로 저장까지 끝낸 위치. 이어서 수집은 여기서부터 한다 */
  checkpoint: { year: string; page: number } | null
  error: string | null
}

export const IDLE_STATE: CollectState = {
  status: 'idle',
  runId: null,
  startedAt: null,
  updatedAt: null,
  years: [],
  year: null,
  yearIndex: 0,
  page: 0,
  rows: 0,
  perYear: {},
  checkpoint: null,
  error: null,
}

/** 저장된 상태를 화면에 보이는 상태로 바꾼다: 갱신이 끊긴 running 은 aborted 로 본다 */
export function effectiveState(s: CollectState | undefined, now = Date.now()): CollectState {
  const st = { ...IDLE_STATE, ...(s ?? {}) }
  if (st.status === 'running' && (st.updatedAt ?? 0) < now - STALE_MS) {
    return { ...st, status: 'aborted', error: st.error ?? '수집이 중간에 끊겼습니다(탭을 닫거나 이동한 경우). 이어서 수집할 수 있습니다.' }
  }
  return st
}

export function progressText(s: CollectState): string {
  if (s.status === 'running') return `${s.year}년 (${s.yearIndex}/${s.years.length}) ${s.page + 1}페이지 · 이번에 ${s.rows}행 저장`
  if (s.status === 'done') return '완료. ' + Object.entries(s.perYear).sort(([a], [b]) => Number(b) - Number(a)).map(([y, n]) => `${y}:${n}`).join(' ') // 최신 연도부터
  if (s.status === 'aborted') return `중단됨. ${s.checkpoint ? `${s.checkpoint.year}년 ${s.checkpoint.page + 1}페이지까지 저장됨` : '저장된 것 없음'}`
  if (s.status === 'error') return `오류: ${s.error ?? ''}`
  return '대기 중'
}
