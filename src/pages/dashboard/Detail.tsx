import { useMemo, useRef, useState } from 'react'
import { Modal, SearchIcon } from '../../components/Common'
import { addMonths, daysBetween, dot, planBuckets } from '../../lib/dates'
import { fmt } from '../../lib/format'
import { selectRows } from '../../lib/pipeline'
import { round2 } from '../../lib/normalize'
import { groupSummaries, matchesNeedle } from '../../lib/stats'
import type { EnrichedRow, ProductSummary } from '../../lib/types'
import { useApp } from '../../state/AppState'
import type { Period } from '../Dashboard'
import { labeler } from './chart'

type Sort = 'count' | 'amount'

export function Detail({ period, sel, onWidenPeriod }: { period: Period; sel: EnrichedRow[]; onWidenPeriod?: () => void }) {
  const app = useApp()
  const { from, to } = period
  const [sort, setSort] = useState<Sort>('count')
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  // 그래프만의 기간과 단위. 비워 두면 위쪽에서 고른 기간을 따른다
  const [cFrom, setCFrom] = useState<string | null>(null)
  const [cTo, setCTo] = useState<string | null>(null)
  const [unit, setUnit] = useState<'auto' | 'month' | 'year'>('auto')
  const [trim, setTrim] = useState(true) // 데이터가 없는 앞뒤 구간은 x축에서 줄인다
  const [hover, setHover] = useState<{ key: string; left: number } | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  const needle = q.trim().toLowerCase()

  // 검색어가 있으면 이 기간의 일치 구매만, 없으면 이 기간의 모든 구매(한 번만 산 품목 포함)
  const matchRows = useMemo(() => (needle ? sel.filter((r) => matchesNeedle(r, needle)) : []), [sel, needle])

  const products = useMemo(() => {
    const list = groupSummaries(needle ? matchRows : sel)
    return list.sort((a, b) => (sort === 'count' ? b.n - a.n || b.amount - a.amount : b.amount - a.amount || b.n - a.n))
  }, [sel, matchRows, sort, needle])

  // 이 기간 밖(다른 기간)에도 일치하는 품목이 있으면 알려 준다
  const outsideCount = useMemo(() => {
    if (!needle) return 0
    const inPeriod = new Set(matchRows.map((r) => r.group))
    const everywhere = selectRows(app.prep.kept, app.range.start, app.range.end, period.status).filter((r) => matchesNeedle(r, needle))
    return new Set(everywhere.map((r) => r.group).filter((g) => !inPeriod.has(g))).size
  }, [needle, matchRows, app.prep.kept, app.range.start, app.range.end, period.status])

  // 검색어가 있으면 그 단어가 들어간 모든 구매(한 번만 산 품목 포함)를 한 번에 보여 주는 "전체" 항목을 만든다
  const allView = useMemo<ProductSummary | null>(() => {
    if (!needle) return null
    const rows = matchRows
    const groups = [...new Set(rows.map((r) => r.group))]
    if (groups.length < 2) return null
    const days = [...new Set(rows.map((r) => r.date))].sort()
    return {
      group: `'${q.trim()}' 검색 결과 전체`,
      n: rows.length,
      amount: rows.reduce((a, r) => a + r.amount, 0),
      order_days: days.length,
      last: days[days.length - 1],
      min_unit_price: round2(Math.min(...rows.map((r) => r.unit_price))),
      max_unit_price: round2(Math.max(...rows.map((r) => r.unit_price))),
      aliases: groups.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    }
  }, [matchRows, needle, q])

  if (sel.length === 0) {
    return (
      <div className="card" style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--muted)', fontSize: 15 }}>
        이 기간에 산 품목이 없습니다. 기간을 넓혀 보세요.
      </div>
    )
  }

  // 기본 선택: 검색 중이면 "전체", 아니면 첫 품목. 아래 개별 품목을 누르면 그 품목만 본다
  const cur = (picked ? products.find((p) => p.group === picked) : null) ?? allView ?? products[0]
  const isAll = !!cur && cur === allView
  const lines = !cur
    ? []
    : isAll
      ? [...matchRows].sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : a.idx - b.idx))
      : sel.filter((r) => r.group === cur.group).sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : a.idx - b.idx))
  const days = [...new Set(lines.map((l) => l.date))].sort()
  const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d))
  const [cf0, ct0] = [cFrom ?? from, cTo ?? to]
  const [chartFrom, chartTo] = cf0 > ct0 ? [ct0, cf0] : [cf0, ct0]
  const force = unit === 'auto' ? undefined : unit
  const plan = planBuckets(chartFrom, chartTo, force)
  const lab = labeler(chartFrom, chartTo, force)
  // 그래프는 위쪽 기간과 별개로 자기 기간의 구매를 다시 모은다(같은 상태 필터 적용)
  const inView = (r: EnrichedRow) =>
    isAll ? matchesNeedle(r, needle) : !!cur && r.group === cur.group
  const chartLines = selectRows(app.prep.kept, chartFrom, chartTo, period.status).filter(inView)
  const pb: Record<string, { a: number; n: number }> = {}
  for (const k of plan.keys) pb[k] = { a: 0, n: 0 }
  for (const l of chartLines) {
    const k = plan.keyOf(l.date)
    if (pb[k]) {
      pb[k].a += l.amount
      pb[k].n += 1
    }
  }
  // x축 자동 조정: 데이터가 있는 첫 구간부터 마지막 구간까지만 보여 준다(중간에 빈 달은 그대로 둠)
  const firstIdx = plan.keys.findIndex((k) => pb[k].n > 0)
  const lastIdx = plan.keys.length - 1 - [...plan.keys].reverse().findIndex((k) => pb[k].n > 0)
  const hasChartData = firstIdx >= 0
  const shownKeys = trim && hasChartData ? plan.keys.slice(firstIdx, lastIdx + 1) : plan.keys
  const trimmed = shownKeys.length < plan.keys.length
  const dense = shownKeys.length > 18
  const labelStep = Math.max(1, Math.ceil(shownKeys.length / 16))
  const chartPresets: { label: string; from: string | null; to: string | null }[] = [
    { label: '위에서 고른 기간', from: null, to: null },
    { label: '전체 기간', from: app.range.start, to: app.range.end },
    { label: '최근 12개월', from: `${addMonths(app.range.end, -11).slice(0, 7)}-01`, to: app.range.end },
    { label: '올해', from: `${app.range.end.slice(0, 4)}-01-01`, to: app.range.end },
  ]
  const pmax = Math.max(1, ...shownKeys.map((k) => pb[k].a))
  const minUnit = cur ? cur.min_unit_price : 0
  const cats = [...new Set(lines.map((l) => l.category))]
  const category = isAll ? (cats.length === 1 ? cats[0] : `여러 카테고리 (${cats.length}개)`) : lines.length ? lines[lines.length - 1].category : ''

  return (
    <>
      <div className="split">
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '16px 16px 12px' }}>
            <h2 style={{ fontSize: 16, fontWeight: 700 }}>구매 품목</h2>
            <div className="sub" style={{ marginTop: 2 }}>
              {needle ? `선택한 기간의 검색 결과 · ${products.length}개 품목 (한 번만 산 품목 포함)` : `선택한 기간에 산 모든 품목 · ${products.length}개 (한 번만 산 품목 포함)`}
            </div>
            <div className="seg" style={{ marginTop: 12 }} role="group" aria-label="정렬">
              {([['count', '구매 횟수순'], ['amount', '지출 금액순']] as const).map(([k, label]) => (
                <button key={k} type="button" className={sort === k ? 'on' : ''} aria-pressed={sort === k} onClick={() => setSort(k)}>
                  {label}
                </button>
              ))}
            </div>
            <label className="search" style={{ marginTop: 10 }}>
              <SearchIcon />
              <input type="search" placeholder="품목 검색 (예: 펩시)" aria-label="품목 검색" value={q} onChange={(e) => { setQ(e.target.value); setPicked(null) }} />
            </label>
          </div>
          <div style={{ borderTop: '1px solid var(--line-2)', maxHeight: 640, overflowY: 'auto' }} data-testid="product-list">
            {outsideCount > 0 && (
              <div data-testid="outside-notice" className="notice info" style={{ margin: 12, padding: '10px 12px', fontSize: 13, alignItems: 'center' }}>
                <div>
                  선택한 기간 밖에도 '{q.trim()}' 품목이 <strong>{outsideCount}개</strong> 더 있습니다.
                  {onWidenPeriod && (
                    <>
                      {' '}
                      <button type="button" className="btn ghost" style={{ height: 'auto', padding: 0, fontSize: 13 }} onClick={onWidenPeriod}>
                        전체 기간으로 보기
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
            {products.length === 0 && !allView && (
              <div className="sub" style={{ padding: 20 }}>
                검색 결과가 없습니다.
              </div>
            )}
            {allView && (
              <button type="button" data-testid="all-item" className={'listbtn' + (isAll ? ' on' : '')} aria-pressed={isAll} onClick={() => setPicked(null)} style={{ background: isAll ? undefined : 'var(--surface-2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <span className="ellipsis" style={{ fontSize: 14, fontWeight: 700 }}>
                    {allView.group}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap' }}>{fmt(allView.amount)}원</span>
                </div>
                <div className="sub" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 3, fontSize: 12 }}>
                  <span>
                    {allView.n}건 · {allView.aliases.length}개 품목 합계
                  </span>
                  <span>개당 {fmt(allView.min_unit_price)}원~</span>
                </div>
              </button>
            )}
            {products.map((p) => (
              <button key={p.group} type="button" className={'listbtn' + (cur && !isAll && cur.group === p.group ? ' on' : '')} aria-pressed={!!cur && !isAll && cur.group === p.group} onClick={() => setPicked(p.group)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <span className="ellipsis" style={{ fontSize: 14, fontWeight: 600 }}>
                    {p.group}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(p.amount)}원</span>
                </div>
                <div className="sub" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 3, fontSize: 12 }}>
                  <span>
                    {p.n}건 · 마지막 {dot(p.last).slice(2)}
                  </span>
                  <span>개당 {fmt(p.min_unit_price)}원~</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {cur && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="product-detail">
            <div className="card" style={{ padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div className="sub" style={{ fontSize: 12 }}>
                    {category}
                  </div>
                  <h2 style={{ margin: '2px 0 0', fontSize: 22, fontWeight: 700, letterSpacing: -0.3 }} data-testid="product-name">
                    {cur.group}
                  </h2>
                </div>
                {!isAll && (
                <button type="button" className="btn sm" onClick={() => setMergeOpen(true)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8 3H5a2 2 0 00-2 2v3" />
                    <path d="M16 3h3a2 2 0 012 2v3" />
                    <path d="M12 8v8" />
                    <path d="M8 12h8" />
                  </svg>
                  다른 이름 합치기
                </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
                <span className="sub" style={{ fontSize: 12 }}>
                  {isAll ? `포함된 품목 ${cur.aliases.length}개 · 한 번만 산 품목도 포함` : '주문목록상 이름'}
                </span>
                {(isAll ? cur.aliases.slice(0, 12) : cur.aliases).map((a) => (
                  <span key={a} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 28, padding: '0 10px', borderRadius: 14, background: '#f1f2f4', fontSize: 12, color: 'var(--ink-2)' }} data-testid="alias">
                    {a}
                    {app.stored.merges[a] && (
                      <button
                        type="button"
                        aria-label={`${a} 합치기 해제`}
                        onClick={() => void app.setMerge(a, null).then(() => app.notify('합치기를 해제했습니다')).catch(() => undefined)}
                        style={{ width: 18, height: 18, border: 0, borderRadius: 9, background: '#e1e3e8', color: 'var(--muted)', fontSize: 11, padding: 0 }}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                ))}
              </div>

              {isAll && cur.aliases.length > 12 && (
                <div className="sub" style={{ fontSize: 12, marginTop: 6 }}>
                  … 외 {cur.aliases.length - 12}개 품목은 아래 구매 이력에서 확인할 수 있습니다
                </div>
              )}

              <div className="stat4" style={{ marginTop: 18 }}>
                <div>
                  <div className="l">기간 내 지출</div>
                  <div className="v" data-testid="prod-amount">
                    {fmt(cur.amount)}
                    <small>원</small>
                  </div>
                  <div className="n" data-testid="prod-unit-range">
                    개당 {fmt(cur.min_unit_price)}원 ~ {fmt(cur.max_unit_price)}원
                  </div>
                </div>
                <div>
                  <div className="l">구매</div>
                  <div className="v" data-testid="prod-count">
                    {cur.n}
                    <small>건</small>
                  </div>
                  <div className="n">주문일 {cur.order_days}일</div>
                </div>
                <div>
                  <div className="l">평균 구매 간격</div>
                  <div className="v">
                    {gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : '—'}
                    <small>일</small>
                  </div>
                  <div className="n">{gaps.length ? `최소 ${Math.min(...gaps)}일 · 최대 ${Math.max(...gaps)}일` : '주문일 하루'}</div>
                </div>
                <div>
                  <div className="l">마지막 구매</div>
                  <div className="v">{dot(cur.last).slice(2)}</div>
                  <div className="n">{daysBetween(cur.last, app.range.end)}일 전</div>
                </div>
              </div>

              <div style={{ marginTop: 20 }} data-testid="detail-chart">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 700 }} data-testid="chart-title">
                    {lab.yearly ? '연도별' : '월별'} 구매 · {dot(chartFrom)} – {dot(chartTo)}
                  </h3>
                  <span className="sub" style={{ fontSize: 12 }}>
                    {dense ? '막대에 마우스를 올리면 금액과 건수가 보입니다' : '막대 위 = 지출(원) · 아래 = 구매 건수 · 마우스를 올려도 볼 수 있습니다'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="그래프 기간 바로 선택">
                    {chartPresets.map((c) => {
                      const on = c.from === null ? cFrom === null && cTo === null : cFrom === c.from && cTo === c.to
                      return (
                        <button
                          key={c.label}
                          type="button"
                          className={'pill' + (on ? ' on' : '')}
                          style={{ height: 32, fontSize: 13, padding: '0 10px' }}
                          aria-pressed={on}
                          onClick={() => {
                            setCFrom(c.from)
                            setCTo(c.to)
                          }}
                        >
                          {c.label}
                        </button>
                      )
                    })}
                  </div>
                  <label className="field">
                    그래프 시작일
                    <input className="input" style={{ height: 34 }} type="date" data-testid="chart-from" value={chartFrom} onChange={(e) => e.target.value && setCFrom(e.target.value)} />
                  </label>
                  <label className="field">
                    그래프 종료일
                    <input className="input" style={{ height: 34 }} type="date" data-testid="chart-to" value={chartTo} onChange={(e) => e.target.value && setCTo(e.target.value)} />
                  </label>
                  <div className="seg" style={{ width: 240, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }} role="group" aria-label="그래프 단위">
                    {([['auto', '자동'], ['month', '월별'], ['year', '연도별']] as const).map(([k, label]) => (
                      <button key={k} type="button" className={unit === k ? 'on' : ''} aria-pressed={unit === k} data-testid={`chart-unit-${k}`} onClick={() => setUnit(k)} style={{ height: 30 }}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, minHeight: 34 }}>
                    <input type="checkbox" data-testid="chart-trim" checked={trim} onChange={(e) => setTrim(e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
                    데이터가 있는 구간만 보기
                  </label>
                </div>
                {!hasChartData ? (
                  <div className="sub" style={{ marginTop: 12, padding: '36px 0', textAlign: 'center', borderBottom: '1px solid #c9cdd5' }} data-testid="chart-empty">
                    이 기간에는 구매가 없습니다. 그래프 기간을 넓혀 보세요.
                  </div>
                ) : (
                  <>
                    <div
                      ref={gridRef}
                      role="group"
                      aria-label="품목 구매 막대 그래프"
                      onMouseLeave={() => setHover(null)}
                      style={{ position: 'relative', display: 'grid', gridTemplateColumns: `repeat(${shownKeys.length}, minmax(0, 1fr))`, gap: dense ? 2 : 6, alignItems: 'end', height: 180, marginTop: 12, borderBottom: '1px solid #c9cdd5' }}
                    >
                      {shownKeys.map((k) => {
                        const fut = plan.isFuture(k, app.range.end)
                        const text = fut ? `${lab.label(k)}: 데이터 없음` : `${lab.label(k)}: ${fmt(pb[k].a)}원, ${pb[k].n}건`
                        return (
                          <div
                            key={k}
                            role="img"
                            aria-label={text}
                            data-testid="pbar"
                            onMouseEnter={(e) => setHover({ key: k, left: e.currentTarget.offsetLeft + e.currentTarget.offsetWidth / 2 })}
                            style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 4, minWidth: 0, background: hover?.key === k ? '#eef2fd' : undefined, borderRadius: 4 }}
                          >
                            {!dense && (
                              <span className="bar-val" style={{ color: fut ? '#6b7180' : 'var(--ink)' }}>
                                {fut ? '—' : pb[k].a ? fmt(pb[k].a) : ''}
                              </span>
                            )}
                            <div className="bar" style={{ maxWidth: 40, height: fut || !pb[k].a ? 0 : Math.max(4, Math.round((pb[k].a / pmax) * (dense ? 160 : 140))) }} />
                          </div>
                        )
                      })}
                      {hover && pb[hover.key] && (
                        <div
                          role="tooltip"
                          data-testid="chart-tip"
                          style={{
                            position: 'absolute',
                            top: 4,
                            left: Math.min(Math.max(hover.left, 70), Math.max(70, (gridRef.current?.offsetWidth ?? 0) - 70)),
                            transform: 'translateX(-50%)',
                            background: 'var(--ink)',
                            color: '#fff',
                            padding: '8px 12px',
                            borderRadius: 8,
                            fontSize: 12,
                            lineHeight: 1.5,
                            whiteSpace: 'nowrap',
                            pointerEvents: 'none',
                            zIndex: 5,
                            boxShadow: '0 4px 12px rgba(21, 23, 28, 0.25)',
                          }}
                        >
                          <div style={{ fontWeight: 700 }}>{lab.label(hover.key)}</div>
                          {plan.isFuture(hover.key, app.range.end) ? (
                            <div>데이터 없음</div>
                          ) : (
                            <>
                              <div>지출 {fmt(pb[hover.key].a)}원</div>
                              <div>구매 {pb[hover.key].n}건</div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${shownKeys.length}, minmax(0, 1fr))`, gap: dense ? 2 : 6, marginTop: 6 }} aria-hidden="true">
                      {shownKeys.map((k, i) => (
                        <div key={k} style={{ textAlign: 'center', minWidth: 0 }}>
                          <div style={{ fontSize: dense ? 10 : 12, color: 'var(--ink-2)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'visible' }}>{i % labelStep === 0 ? lab.label(k) : ''}</div>
                          {!dense && (
                            <div className="sub" style={{ fontSize: 11, marginTop: 1 }}>
                              {plan.isFuture(k, app.range.end) ? '' : `${pb[k].n}건`}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <div className="sub" style={{ fontSize: 12, marginTop: 10 }}>
                  {trimmed && hasChartData && `데이터가 있는 ${lab.label(shownKeys[0])} – ${lab.label(shownKeys[shownKeys.length - 1])}만 보여 줍니다(앞뒤의 빈 구간은 줄였습니다). `}
                  {chartTo > app.range.end && `데이터는 ${dot(app.range.end)}까지입니다. `}
                  {unit === 'auto' && lab.yearly && '18개월이 넘는 기간은 자동으로 연도별로 묶습니다. 월별로 보려면 위의 월별 버튼을 누르거나 그래프 기간을 줄이세요.'}
                </div>
              </div>
            </div>

            <div className="card" style={{ overflow: 'hidden' }}>
              <div className="card-head" style={{ alignItems: 'baseline' }}>
                <h3 style={{ fontSize: 15, fontWeight: 700 }}>구매 이력</h3>
                <span className="sub">최근 순</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="tbl" style={{ minWidth: 640 }} data-testid="history">
                  <thead>
                    <tr>
                      <th scope="col">거래일시</th>
                      <th scope="col">주문목록 상품명 · 옵션</th>
                      <th scope="col">개당 가격</th>
                      <th scope="col">수량</th>
                      <th scope="col" style={{ textAlign: 'right' }}>
                        금액
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...lines].reverse().map((l) => {
                      const best = Math.round(l.unit_price * 100) / 100 === minUnit || Math.abs(l.unit_price - minUnit) < 0.005
                      return (
                        <tr key={l.key + (l.restored ? 'r' : '')}>
                          <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{dot(l.date)}</td>
                          <td style={{ maxWidth: 320 }}>
                            <div className="ellipsis">{l.base}</div>
                            <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>
                              {l.opt}
                              {l.status === '반품완료' || l.status === '취소완료' ? ` · ${l.status}` : ''}
                            </div>
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <span
                              data-testid={best ? 'unit-best' : 'unit'}
                              style={{ display: 'inline-flex', alignItems: 'center', height: 26, padding: '0 8px', borderRadius: 6, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', background: best ? 'var(--good-soft)' : '#f1f2f4', color: best ? 'var(--good)' : 'var(--ink-2)' }}
                            >
                              {fmt(l.unit_price)}원
                            </span>
                          </td>
                          <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{l.qty}개</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600 }}>{fmt(l.amount)}원</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="sub" style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', background: 'var(--surface-2)', lineHeight: 1.55 }}>
                개당 가격은 옵션의 'N개'로 나눈 값입니다. 가장 싸게 산 주문은 초록색으로 표시합니다. 같은 날 같은 상품이 여러 줄이면 각각 따로 산 것으로 셉니다.
              </div>
            </div>
          </div>
        )}
      </div>
      {mergeOpen && cur && <MergeDialog group={cur.group} onClose={() => setMergeOpen(false)} />}
    </>
  )
}

function MergeDialog({ group, onClose }: { group: string; onClose: () => void }) {
  const app = useApp()
  const [q, setQ] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const groups = useMemo(() => {
    const m = new Map<string, { bases: Set<string>; n: number }>()
    for (const r of app.prep.kept) {
      if (r.group === group) continue
      const e = m.get(r.group) ?? { bases: new Set<string>(), n: 0 }
      e.bases.add(r.base)
      e.n += 1
      m.set(r.group, e)
    }
    const needle = q.trim().toLowerCase()
    return [...m.entries()]
      .filter(([g]) => !needle || g.toLowerCase().includes(needle))
      .sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
      .slice(0, 50)
  }, [app.prep.kept, group, q])

  async function save() {
    setBusy(true)
    try {
      const all = new Map(groups)
      for (const g of chosen) {
        for (const base of all.get(g)?.bases ?? []) await app.setMerge(base, group)
      }
      app.notify(`${chosen.size}개 품목을 '${group}'에 합쳤습니다`)
      onClose()
    } catch {
      /* 알림은 이미 표시됨 */
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`다른 이름 합치기 · ${group}`} onClose={onClose}>
      <p className="sub" style={{ marginTop: 0, lineHeight: 1.6 }}>
        주문목록에서 이름이 다르지만 같은 상품인 것을 골라 이 품목으로 합칩니다. 합친 결과는 이후 업로드에도 적용됩니다.
      </p>
      <label className="search">
        <SearchIcon />
        <input type="search" aria-label="합칠 품목 검색" placeholder="이름으로 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div style={{ marginTop: 10, border: '1px solid var(--line-2)', borderRadius: 10, maxHeight: 320, overflowY: 'auto' }}>
        {groups.map(([g, v]) => (
          <label key={g} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--line-2)', fontSize: 14 }}>
            <input
              type="checkbox"
              checked={chosen.has(g)}
              onChange={(e) => {
                const n = new Set(chosen)
                if (e.target.checked) n.add(g)
                else n.delete(g)
                setChosen(n)
              }}
              style={{ width: 18, height: 18, accentColor: 'var(--accent)', flexShrink: 0 }}
            />
            <span className="ellipsis" style={{ flexGrow: 1 }}>
              {g}
            </span>
            <span className="sub">{v.n}건</span>
          </label>
        ))}
        {groups.length === 0 && <div className="sub" style={{ padding: 16 }}>찾는 품목이 없습니다.</div>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button type="button" className="btn sm" onClick={onClose}>
          취소
        </button>
        <button type="button" className="btn sm primary" disabled={busy || chosen.size === 0} onClick={() => void save()}>
          {chosen.size}개 합치기
        </button>
      </div>
    </Modal>
  )
}
