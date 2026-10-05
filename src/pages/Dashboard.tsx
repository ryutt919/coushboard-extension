import { useMemo, useState } from 'react'
import { Layout } from '../components/Layout'
import { presetRange, type PresetName } from '../lib/dates'

// 상단 기간 버튼: 전체, 데이터가 있는 연도별, 직접 지정. 이번 달, 최근 3개월, 올해 버튼은 두지 않는다
const TOP_PRESETS: PresetName[] = ['전체']
import { selectRows, summarize } from '../lib/pipeline'
import type { StatusFilter } from '../lib/types'
import { useApp } from '../state/AppState'
import { Detail } from './dashboard/Detail'
import { Overview } from './dashboard/Overview'

export interface Period {
  from: string
  to: string
  status: StatusFilter
}

export function Dashboard() {
  const app = useApp()
  const { prep, range } = app
  // 프리셋 이름('전체' 등) 또는 연도('2026')
  const [preset, setPreset] = useState<string>('전체')
  const [custom, setCustom] = useState<[string, string] | null>(null)
  const [status, setStatus] = useState<StatusFilter>('ok')
  const [tab, setTab] = useState<'개요' | '세부 내역'>('개요')

  const [from0, to0] = useMemo<[string, string]>(() => {
    if (!app.hasData) return ['', '']
    if (preset === '직접 지정') return custom ?? [range.start, range.end]
    if (/^\d{4}$/.test(preset)) return [`${preset}-01-01`, `${preset}-12-31`]
    return presetRange(preset as Exclude<PresetName, '직접 지정'>, range.start, range.end)
  }, [preset, custom, range, app.hasData])
  const [from, to] = from0 > to0 ? [to0, from0] : [from0, to0]

  // 데이터가 있는 연도만, 최신 연도부터
  const years = useMemo(() => [...new Set(prep.kept.map((r) => r.date.slice(0, 4)))].sort().reverse(), [prep.kept])

  const sel = useMemo(() => selectRows(prep.kept, from, to, status), [prep.kept, from, to, status])
  const summary = useMemo(() => summarize(prep.kept, from, to, status, range.end), [prep.kept, from, to, status, range.end])
  const period: Period = { from, to, status }

  if (app.loading && !app.hasData) {
    return (
      <Layout route="dashboard">
        <main className="main">
          <div className="card card-pad" role="status">
            데이터를 불러오는 중…
          </div>
        </main>
      </Layout>
    )
  }
  if (app.loadError) {
    return (
      <Layout route="dashboard">
        <main className="main">
          <div className="notice err" role="alert">
            {app.loadError}
            <button type="button" className="btn sm" style={{ marginLeft: 12 }} onClick={() => void app.reload()}>
              다시 시도
            </button>
          </div>
        </main>
      </Layout>
    )
  }
  if (!app.hasData) {
    return (
      <Layout route="dashboard">
        <main className="main narrow">
          <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h1 style={{ fontSize: 24, fontWeight: 700 }}>아직 올린 주문이 없습니다</h1>
            <p className="sub" style={{ margin: 0, lineHeight: 1.6, fontSize: 15 }}>
              위의 가져오기 시작으로 쿠팡 주문을 가져오거나, 주문목록 CSV를 올리면 기간별, 카테고리별, 품목별 지출이 여기에 나타납니다. 모두 이 브라우저에서 읽고 계산합니다.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <a className="btn primary" href="#/upload">
                CSV 올리기
              </a>
            </div>
          </div>
        </main>
      </Layout>
    )
  }

  return (
    <Layout route="dashboard">
      <main className="main">
        <section aria-label="기간 선택" className="card" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="기간 프리셋">
            {[...TOP_PRESETS, ...years, '직접 지정'].map((p) => (
              <button
                key={p}
                type="button"
                className={'pill' + (preset === p ? ' on' : '')}
                aria-pressed={preset === p}
                data-testid={/^\d{4}$/.test(p) ? `year-${p}` : undefined}
                aria-label={/^\d{4}$/.test(p) ? `${p}년 전체` : undefined}
                onClick={() => {
                  if (p === '직접 지정') setCustom([from, to])
                  setPreset(p)
                }}
              >
                {/^\d{4}$/.test(p) ? `${p}년` : p}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label className="field">
              시작일
              <input
                className="input"
                type="date"
                value={from}
                min={`${range.start.slice(0, 4)}-01-01`}
                max={`${range.end.slice(0, 4)}-12-31`}
                onChange={(e) => {
                  if (!e.target.value) return
                  setCustom([e.target.value, to])
                  setPreset('직접 지정')
                }}
              />
            </label>
            <span style={{ paddingTop: 16, color: 'var(--muted)' }} aria-hidden="true">
              ~
            </span>
            <label className="field">
              종료일
              <input
                className="input"
                type="date"
                value={to}
                min={`${range.start.slice(0, 4)}-01-01`}
                max={`${range.end.slice(0, 4)}-12-31`}
                onChange={(e) => {
                  if (!e.target.value) return
                  setCustom([from, e.target.value])
                  setPreset('직접 지정')
                }}
              />
            </label>
            <label className="field">
              주문 상태
              <select className="input" style={{ height: 42, background: '#fff' }} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                <option value="ok">받은 상품만 (배송·교환완료)</option>
                <option value="all">반품·취소 포함</option>
                <option value="ret">반품·취소만</option>
              </select>
            </label>
          </div>
        </section>

        <section aria-label="지출 보기" className="card" style={{ overflow: 'hidden' }}>
          <div role="tablist" aria-label="보기 전환" className="tabs">
            {(['개요', '세부 내역'] as const).map((t) => (
              <button key={t} type="button" role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls="tabpanel" className="tab" onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} style={{ background: 'var(--surface-2)', padding: 20 }}>
            {tab === '개요' ? (
              <Overview period={period} sel={sel} summary={summary} />
            ) : (
              <Detail period={period} sel={sel} onWidenPeriod={() => setPreset('전체')} />
            )}
          </div>
        </section>
      </main>
    </Layout>
  )
}
