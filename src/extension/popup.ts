import { COLLECT_KEY, type CollectState, effectiveState, elapsedMs, formatAgo, formatElapsed, progressText, yearSteps } from './collectState'

// 팝업은 보기와 시작, 중단만 한다. 수집은 쿠팡 탭의 콘텐츠 스크립트가 하고 상태는 저장소에 있으므로, 팝업을 닫아도 수집은 계속된다.
// 진행 중에는 1초마다 다시 그려, 경과 시간과 마지막 저장 시각이 흐르는 것으로 살아 있음을 보여 준다.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const st = $('status')
const msg = $('msg')

let raw: CollectState | undefined

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

function render() {
  const now = Date.now()
  const s = effectiveState(raw, now)
  $('stext').textContent = progressText(s)
  st.dataset.status = s.status
  const running = s.status === 'running'
  $('spinner').hidden = !running

  const showProgress = s.status !== 'idle'
  const prog = $('progress')
  prog.hidden = !showProgress
  prog.dataset.status = s.status
  if (showProgress) {
    renderSteps(s)
    $('wait').hidden = s.years.length > 0
    $('elapsed').textContent = formatElapsed(elapsedMs(s, now))
    $('rows').textContent = String(s.rows)
    $('ago').textContent = s.updatedAt ? formatAgo(now - s.updatedAt) : '-'
  }

  const canResume = (s.status === 'aborted' || s.status === 'error') && s.checkpoint !== null
  $('collect').hidden = running || canResume
  $('collect').textContent = s.status === 'done' ? '다시 가져오기' : '가져오기 시작'
  $('resume').hidden = !canResume
  $('fresh').hidden = !canResume
  $('abort').hidden = !running
}

async function call(message: Record<string, unknown>) {
  const res = await chrome.runtime.sendMessage(message)
  msg.textContent = res?.ok ? '' : (res?.error ?? '요청을 처리하지 못했습니다.')
}

$('collect').onclick = () => void call({ type: 'START_COLLECT', mode: 'fresh' })
$('resume').onclick = () => void call({ type: 'START_COLLECT', mode: 'resume' })
$('fresh').onclick = () => void call({ type: 'START_COLLECT', mode: 'fresh' })
$('abort').onclick = () => void call({ type: 'ABORT_COLLECT' })
$('open').onclick = () => void call({ type: 'OPEN_DASHBOARD' })

const load = async () => {
  raw = (await chrome.storage.local.get(COLLECT_KEY))[COLLECT_KEY]
  render()
}
void load()
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && COLLECT_KEY in changes) void load()
})
window.setInterval(render, 1000)
window.setInterval(() => void load(), 5000)
