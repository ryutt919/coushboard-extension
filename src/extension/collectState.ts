// 수집 진행 상태. 콘텐츠 스크립트가 chrome.storage.local 의 `collect` 키에 쓰고, 팝업과 대시보드가 읽는다.
// 팝업을 닫아도 상태가 남아 있어 다시 열면 이어서 보이고, 수집이 도는 중에는 새 수집을 시작하지 못한다.
export const COLLECT_KEY = 'collect'
/** 전체 수집을 끝낸 시각과 마지막 수집 시각: { lastFullAt, lastRunAt } */
export const SYNC_KEY = 'sync'
/** 이 시간(ms) 동안 갱신이 없는 running 상태는 수집이 끊긴 것(탭 닫힘, 이동, 새로고침)으로 본다 */
export const STALE_MS = 30_000

export type CollectStatus = 'idle' | 'running' | 'done' | 'error' | 'aborted'
/** full: 전체 수집, new: 이미 가진 주문을 만나면 멈추는 새 주문만 가져오기 */
export type CollectMode = 'full' | 'new'

export interface SyncInfo {
  lastFullAt?: number | null
  lastRunAt?: number | null
}

export interface CollectState {
  status: CollectStatus
  /** 이번 수집 방식. 이전 버전이 남긴 상태에는 없다(전체 수집으로 본다) */
  mode?: CollectMode
  /** 새 주문만 가져오기에서 이번에 새로 저장한 주문 수 */
  newOrders?: number
  /** 새 주문만 가져오기가 이미 가진 주문을 만나 멈췄으면 'known' */
  stopReason?: 'known' | null
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

/**
 * 새 주문만 가져오기를 쓸 수 있는지: 전체 수집을 한 번 끝냈고 저장된 주문이 있어야 한다.
 * 전체 수집이 중간에 끊겼거나 CSV만 있으면, 이미 가진 주문을 만나 멈출 때 그보다 오래된 주문이 비어 있을 수 있어서 전체 수집으로 한다.
 * 이전 버전이 끝낸 전체 수집(sync 기록 없음, 상태가 done 이고 mode 없음)도 인정한다.
 */
export function canIncremental(sync: SyncInfo | undefined, collect: CollectState | undefined, orderCount: number): boolean {
  if (orderCount <= 0) return false
  if (sync?.lastFullAt) return true
  return collect?.status === 'done' && collect.mode !== 'new'
}

export function progressText(s: CollectState): string {
  const isNew = s.mode === 'new'
  if (s.status === 'running' && isNew) return `새 주문 확인 중, ${s.year ?? ''}년 ${s.page + 1}페이지, 새 주문 ${s.newOrders ?? 0}건`
  if (s.status === 'running') return `${s.year}년 (${s.yearIndex}/${s.years.length}) ${s.page + 1}페이지, 이번에 ${s.rows}행 저장`
  if (s.status === 'done' && isNew) return (s.newOrders ?? 0) > 0 ? `완료. 새 주문 ${s.newOrders}건을 추가했습니다(${s.rows}행 확인)` : '완료. 새 주문이 없습니다'
  if (s.status === 'done') return '완료. ' + Object.entries(s.perYear).sort(([a], [b]) => Number(b) - Number(a)).map(([y, n]) => `${y}:${n}`).join(' ') // 최신 연도부터
  if (s.status === 'aborted') return `중단됨. ${s.checkpoint ? `${s.checkpoint.year}년 ${s.checkpoint.page + 1}페이지까지 저장됨` : '저장된 것 없음'}`
  if (s.status === 'error') return `오류: ${s.error ?? ''}`
  return '대기 중'
}

export type StepState = 'done' | 'current' | 'pending'
export interface YearStep {
  year: string
  state: StepState
  /** 이 연도에서 저장한 행 수(끝났거나 진행 중일 때) */
  rows: number
}

/**
 * 연도별 진행 칸. 연도는 최신부터 가져오므로 현재 연도 앞은 끝난 것이다(이어서 수집으로 건너뛴 연도 포함).
 * 연도별 전체 페이지 수는 끝까지 읽어 봐야 알 수 있어서, 퍼센트가 아니라 연도 단위 칸으로 보여 준다.
 */
export function yearSteps(s: CollectState): YearStep[] {
  return s.years.map((year, i) => ({
    year,
    rows: s.perYear[year] ?? 0,
    state: s.status === 'done' || i < s.yearIndex - 1 ? 'done' : i === s.yearIndex - 1 ? 'current' : 'pending',
  }))
}

/** 경과 시간: 1:05, 12:30, 1:02:03 */
export function formatElapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** 마지막 저장 시각: 방금, 7초 전, 3분 전, 5시간 전, 2일 전 */
export function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 3) return '방금'
  if (s < 60) return `${s}초 전`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}분 전`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`
}

/** 시작부터 지금까지(진행 중) 또는 마지막 저장까지(끝났거나 멈춘 경우) 걸린 시간 */
export function elapsedMs(s: CollectState, now = Date.now()): number {
  if (s.startedAt == null) return 0
  return (s.status === 'running' ? now : (s.updatedAt ?? now)) - s.startedAt
}
