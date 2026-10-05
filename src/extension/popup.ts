import { progressText, type CollectState } from './collectState'
import { readCollectState } from './useCollect'

// 팝업은 보기와 시작, 중단만 한다. 수집은 쿠팡 탭의 콘텐츠 스크립트가 하고 상태는 저장소에 있으므로, 팝업을 닫아도 수집은 계속된다.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const st = $('status')
const msg = $('msg')

function render(s: CollectState) {
  st.textContent = progressText(s)
  st.dataset.status = s.status
  const running = s.status === 'running'
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

const refresh = () => void readCollectState().then(render)
refresh()
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'collect' in changes) refresh()
})
window.setInterval(refresh, 5000)
