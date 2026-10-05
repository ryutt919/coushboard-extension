import { COLLECT_KEY, type CollectState, canIncremental, effectiveState, elapsedMs, formatAgo, formatElapsed, progressText, SYNC_KEY, type SyncInfo, yearSteps } from './collectState'

// 팝업은 보기와 시작, 중단만 한다. 수집은 쿠팡 탭의 콘텐츠 스크립트가 하고 상태는 저장소에 있으므로, 팝업을 닫아도 수집은 계속된다.
// 진행 중에는 1초마다 다시 그려, 경과 시간과 마지막 저장 시각이 흐르는 것으로 살아 있음을 보여 준다.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const st = $('status')
const msg = $('msg')

let raw: CollectState | undefined
let sync: SyncInfo | undefined
let orderCount = 0

function renderSteps(s: CollectState) {
  const steps = yearSteps(s)
  const box = $('steps')
  const done = steps.filter((x) => x.state === 'done').length
  box.setAttribute('aria-valuemax', String(Math.max(1, steps.length)))
  box.setAttribute('aria-valuenow', String(done))
  const cur = steps.find((x) => x.state === 'current')
  box.setAttribute('aria-valuetext', cur ? `${steps.length}개 연도 중 ${done}개 완료, ${cur.year}년 진행 중` : `${steps.length}개 연도 중 ${done}개 완료`)
  box.replaceChildren(
    ...steps.map((x) => {
      const step = document.createElement('div')
      step.className = 'step'
      step.dataset.state = x.state
      step.dataset.year = x.year
      const bar = document.createElement('div')
      bar.className = 'bar'
      const lab = document.createElement('div')
      lab.className = 'lab'
      lab.append(x.year)
      const cnt = document.createElement('span')
      cnt.className = 'cnt'
      cnt.textContent = x.state === 'pending' ? '' : String(x.rows)
      lab.append(cnt)
      step.append(bar, lab)
      return step
    }),
  )
}

const when = (ts: number) => new Date(ts).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })

function render() {
  const now = Date.now()
  const s = effectiveState(raw, now)
  $('stext').textContent = progressText(s)
  st.dataset.status = s.status
  const running = s.status === 'running'
  $('spinner').hidden = !running
  const isNew = s.mode === 'new'

  const showProgress = s.status !== 'idle'
  const prog = $('progress')
  prog.hidden = !showProgress
  prog.dataset.status = s.status
  if (showProgress) {
    // 새 주문만 가져오기는 어디서 멈출지 모르므로 연도별 칸 대신 숫자만 보여 준다
    $('steps').hidden = isNew
    if (!isNew) renderSteps(s)
    $('wait').hidden = isNew || s.years.length > 0
    $('elapsed').textContent = formatElapsed(elapsedMs(s, now))
    $('rowsLabel').textContent = isNew ? '새 주문' : '저장한 행'
    $('rows').textContent = isNew ? `${s.newOrders ?? 0}건` : String(s.rows)
    $('ago').textContent = s.updatedAt ? formatAgo(now - s.updatedAt) : '-'
  }

  const canResume = (s.status === 'aborted' || s.status === 'error') && s.checkpoint !== null
  const incremental = !running && !canResume && canIncremental(sync, raw, orderCount)
  $('newbtn').hidden = !incremental
  $('collect').hidden = running || canResume
  $('collect').className = incremental ? '' : 'primary'
  $('collect').textContent = incremental ? '전체 다시 가져오기' : s.status === 'done' ? '다시 가져오기' : '가져오기 시작'
  $('resume').hidden = !canResume
  $('fresh').hidden = !canResume
  $('abort').hidden = !running
  const last = $('last')
  last.hidden = !sync?.lastFullAt
  if (sync?.lastFullAt) last.textContent = `마지막 전체 수집: ${when(sync.lastFullAt)}${sync.lastRunAt && sync.lastRunAt !== sync.lastFullAt ? ` / 마지막 확인: ${when(sync.lastRunAt)}` : ''}`
}

async function call(message: Record<string, unknown>) {
  const res = await chrome.runtime.sendMessage(message)
  msg.textContent = res?.ok ? '' : (res?.error ?? '요청을 처리하지 못했습니다.')
}

$('newbtn').onclick = () => void call({ type: 'START_COLLECT', mode: 'new' })
$('collect').onclick = () => void call({ type: 'START_COLLECT', mode: 'fresh' })
$('resume').onclick = () => void call({ type: 'START_COLLECT', mode: 'resume' })
$('fresh').onclick = () => void call({ type: 'START_COLLECT', mode: 'fresh' })
$('abort').onclick = () => void call({ type: 'ABORT_COLLECT' })
$('open').onclick = () => void call({ type: 'OPEN_DASHBOARD' })

const load = async () => {
  const d = await chrome.storage.local.get([COLLECT_KEY, SYNC_KEY, 'orders'])
  raw = d[COLLECT_KEY]
  sync = d[SYNC_KEY]
  orderCount = Array.isArray(d.orders) ? d.orders.length : 0
  render()
}
void load()
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (COLLECT_KEY in changes || SYNC_KEY in changes || 'orders' in changes)) void load()
})
window.setInterval(render, 1000)
window.setInterval(() => void load(), 5000)
