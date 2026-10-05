import { Fragment, useMemo, useState } from 'react'
import { CatChip, SearchIcon } from '../../components/Common'
import { dot } from '../../lib/dates'
import { csvEscape, downloadText, fmt, man } from '../../lib/format'
import { unitStats } from '../../lib/stats'
import type { EnrichedRow, Summary } from '../../lib/types'
import { useApp } from '../../state/AppState'
import type { Period } from '../Dashboard'
import { labeler } from './chart'
import { EditPanel } from './EditPanel'

const PAGE = 10

type SortKey = 'dt' | 'price' | 'amount'
type SortDir = 'asc' | 'desc'
const SORT_LABEL: Record<SortKey, [string, string]> = {
  dt: ['거래일시 오래된 순', '거래일시 최근 순'],
  price: ['1개당 가격 낮은 순', '1개당 가격 높은 순'],
  amount: ['금액 낮은 순', '금액 높은 순'],
}

export function Overview({ period, sel, summary }: { period: Period; sel: EnrichedRow[]; summary: Summary }) {
  const app = useApp()
  const { from, to } = period
  const fallback = app.settings.rules.fallback
  const [cat, setCat] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [edit, setEdit] = useState<EnrichedRow | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'dt', dir: 'desc' })
  const [grouped, setGrouped] = useState(true)

  const total = summary.total
  // 가장 큰 구매와 상품당 평균은 상품 1개당 가격(판매가) 기준이다. 가격 x 수량(금액)이 아니다.
  const { top, avgUnit } = unitStats(sel)
  // 배송비는 총 지출에 더하지 않고 별도로 보여 준다(외부 주문 도구 형식에만 있음)
  const shipping = sel.reduce((a, r) => a + r.shipping_fee, 0)
  const shownEnd = to > app.range.end ? app.range.end : to

  const cats = Object.entries(summary.by_category)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => Number(a.name === fallback) - Number(b.name === fallback) || b.amount - a.amount)
  const cmax = Math.max(1, ...cats.map((c) => c.amount))

  const lab = labeler(from, to)
  const keys = Object.keys(summary.buckets)
  const bmax = Math.max(1, ...keys.map((k) => summary.buckets[k].amount))
  const best = keys.filter((k) => summary.buckets[k].amount).sort((a, b) => summary.buckets[b].amount - summary.buckets[a].amount)[0]

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return sel
      .filter((r) => !cat || r.category === cat)
      .filter((r) => !needle || r.name.toLowerCase().includes(needle))
      .sort((a, b) => {
        // 정렬 기준이 같으면 항상 최근 거래가 먼저 오게 해서 순서가 흔들리지 않게 한다
        const byDate = a.dt < b.dt ? 1 : a.dt > b.dt ? -1 : b.idx - a.idx
        if (sort.key === 'dt') return sort.dir === 'desc' ? byDate : -byDate
        const av = sort.key === 'price' ? a.price : a.amount
        const bv = sort.key === 'price' ? b.price : b.amount
        return av === bv ? byDate : sort.dir === 'desc' ? bv - av : av - bv
      })
  }, [sel, cat, q, sort])

  // 카테고리별로 묶어 보기: 묶음은 지출이 큰 순(미분류는 맨 뒤), 묶음 안의 순서는 위에서 고른 정렬을 따른다
  const { display, groupStats } = useMemo(() => {
    const stats = new Map<string, { n: number; amount: number; rows: EnrichedRow[] }>()
    for (const r of filtered) {
      const g = stats.get(r.category) ?? { n: 0, amount: 0, rows: [] }
      g.n += 1
      g.amount += r.amount
      g.rows.push(r)
      stats.set(r.category, g)
    }
    if (!grouped) return { display: filtered, groupStats: stats }
    const order = [...stats.entries()].sort((a, b) => Number(a[0] === fallback) - Number(b[0] === fallback) || b[1].amount - a[1].amount)
    return { display: order.flatMap(([, g]) => g.rows), groupStats: stats }
  }, [filtered, grouped, fallback])

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }))
    setShown(PAGE)
  }

  const sortTh = (key: SortKey, label: string, align: 'left' | 'right' = 'left') => {
    const on = sort.key === key
    return (
      <th scope="col" aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} style={{ textAlign: align }}>
        <button
          type="button"
          onClick={() => toggleSort(key)}
          data-testid={`sort-${key}`}
          aria-label={`${label} 정렬${on ? (sort.dir === 'asc' ? ', 오름차순' : ', 내림차순') : ''}`}
          style={{ border: 0, background: 'transparent', padding: 0, font: 'inherit', fontWeight: on ? 700 : 600, color: on ? 'var(--ink)' : 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
        >
          {label}
          <span aria-hidden="true" style={{ fontSize: 10, opacity: on ? 1 : 0.45 }}>
            {on ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
          </span>
        </button>
      </th>
    )
  }

  function exportCsv() {
    const head = '거래일시,상품명,카테고리,판매가,수량,금액,상태'
    const lines = filtered.map((r) => [r.dt, r.name, r.category, r.price, r.qty, r.amount, r.status].map(csvEscape).join(','))
    downloadText('분류된_결제내역.csv', '﻿' + [head, ...lines].join('\r\n') + '\r\n', 'text/csv;charset=utf-8')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <section aria-label="요약" className="kpis">
        <div className="kpi">
          <div className="l">총 지출</div>
          <div className="v" data-testid="kpi-total">
            {fmt(total)}
            <small>원</small>
          </div>
          <div className="n">
            {dot(from)} – {dot(shownEnd)}
          </div>
          {shipping > 0 && (
            <div className="n" data-testid="kpi-shipping" style={{ marginTop: 2 }}>
              배송비 별도 {fmt(shipping)}원
            </div>
          )}
        </div>
        <div className="kpi">
          <div className="l">주문 상품</div>
          <div className="v" data-testid="kpi-count">
            {fmt(sel.length)}
            <small>건</small>
          </div>
          <div className="n">{summary.order_days}일에 나눠 주문</div>
        </div>
        <div className="kpi">
          <div className="l">상품당 평균</div>
          <div className="v">
            <span data-testid="kpi-avg">{fmt(avgUnit)}</span>
            <small>원</small>
          </div>
          <div className="n">1개당 가격 기준 (수량 반영)</div>
        </div>
        <div className="kpi">
          <div className="l">가장 큰 구매 (1개당 가격)</div>
          <div className="v">
            <span data-testid="kpi-max">{top ? fmt(top.price) : '0'}</span>
            <small>원</small>
          </div>
          <div className="n">{top ? top.base : '—'}</div>
        </div>
      </section>

      <section className="grid2">
        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 className="h2">카테고리별 지출</h2>
            <span className="sub">항목을 누르면 아래 표가 걸러집니다</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 16 }}>
            {cats.length === 0 && <div className="sub">이 기간에는 주문이 없습니다.</div>}
            {cats.map((c) => {
              const on = cat === c.name
              return (
                <button
                  key={c.name}
                  type="button"
                  className={'catrow' + (on ? ' on' : '') + (cat && !on ? ' dim' : '')}
                  aria-pressed={on}
                  data-testid={`cat-${c.name}`}
                  onClick={() => {
                    setCat(on ? null : c.name)
                    setShown(PAGE)
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>
                      {c.name} <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 13 }}>{c.n}건</span>
                    </span>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>
                      {fmt(c.amount)}원{' '}
                      <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 13, display: 'inline-block', width: 44, textAlign: 'right' }}>
                        {total ? ((c.amount / total) * 100).toFixed(1) : '0.0'}%
                      </span>
                    </span>
                  </div>
                  <div className="meter">
                    <div style={{ width: `${Math.max(1.5, (c.amount / cmax) * 100).toFixed(1)}%`, background: c.name === fallback ? '#6b7180' : undefined }} />
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 className="h2">{lab.yearly ? '연도별' : '월별'} 지출</h2>
            <span className="sub">
              {dot(from).slice(0, 7)} – {dot(to).slice(0, 7)}
            </span>
          </div>
          <div className="bars" role="img" aria-label={`${lab.yearly ? '연도별' : '월별'} 지출 막대 그래프`} data-testid="bars">
            {keys.map((k) => {
              const b = summary.buckets[k]
              return (
                <div className="bar-col" key={k}>
                  <span className="bar-val" style={{ color: b.future ? '#6b7180' : 'var(--ink)' }}>
                    {b.future ? '—' : b.amount ? man(b.amount) : ''}
                  </span>
                  <div className="bar" data-testid="bar" data-future={b.future} style={{ height: b.future || !b.amount ? 0 : Math.max(3, Math.round((b.amount / bmax) * 200)) }} />
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }} aria-hidden="true">
            {keys.map((k) => (
              <span className="bar-label" key={k}>
                {lab.label(k)}
              </span>
            ))}
          </div>
          <div className="sub" style={{ marginTop: 12 }}>
            {best ? `가장 많이 쓴 ${lab.yearly ? '해' : '달'}: ${lab.label(best)} ${fmt(summary.buckets[best].amount)}원 (${summary.buckets[best].n}건)` : '이 기간에는 주문이 없습니다.'}
            {to > app.range.end && ` · 데이터는 ${dot(app.range.end)}까지입니다`}
          </div>
        </div>
      </section>

      <section className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 className="h2">결제 내역</h2>
            {cat && (
              <button type="button" onClick={() => setCat(null)} style={{ height: 32, padding: '0 10px', border: '1px solid var(--accent-line)', background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 16, fontSize: 13, fontWeight: 600 }}>
                {cat} ✕
              </button>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className={'btn sm' + (grouped ? ' primary' : '')} aria-pressed={grouped} data-testid="group-toggle" onClick={() => setGrouped((g) => !g)}>
            카테고리별로 묶기
          </button>
          <label className="search" style={{ width: 260, maxWidth: '100%' }}>
            <SearchIcon />
            <input type="search" placeholder="상품명 검색" aria-label="상품명 검색" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE) }} />
          </label>
          </div>
        </div>
        {edit && <EditPanel key={edit.key} row={edit} onClose={() => setEdit(null)} />}
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl" style={{ minWidth: 820 }} data-testid="rows">
            <thead>
              <tr>
                {sortTh('dt', '거래일시')}
                <th scope="col">상품</th>
                <th scope="col">카테고리</th>
                {sortTh('price', '1개당 가격')}
                <th scope="col">수량</th>
                {sortTh('amount', '금액', 'right')}
              </tr>
            </thead>
            <tbody>
              {display.slice(0, shown).map((r, i, arr) => (
                <Fragment key={r.key + (r.restored ? 'r' : '')}>
                  {grouped && (i === 0 || arr[i - 1].category !== r.category) && (
                    <tr data-testid="group-head">
                      <td colSpan={6} style={{ background: 'var(--surface-2)', padding: '10px 20px', borderTop: '1px solid var(--line)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
                            <CatChip category={r.category}>{r.category}</CatChip>
                            <span className="sub" style={{ fontWeight: 400 }}>{groupStats.get(r.category)?.n}건</span>
                          </span>
                          <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{fmt(groupStats.get(r.category)?.amount ?? 0)}원</span>
                        </div>
                      </td>
                    </tr>
                  )}
                <tr data-testid="row">
                  <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{dot(r.date)}</td>
                  <td style={{ maxWidth: 380 }}>
                    <div className="ellipsis">{r.name}</div>
                    {(r.status === '반품완료' || r.status === '취소완료' || r.restored) && (
                      <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>
                        {r.status === '반품완료' || r.status === '취소완료' ? r.status : ''}
                        {r.restored ? ' 영수증으로 되살린 행' : ''}
                      </div>
                    )}
                  </td>
                  <td>
                    <button type="button" aria-label={`카테고리 변경: ${r.category}`} onClick={() => setEdit(r)} style={{ border: 0, background: 'transparent', padding: 0 }}>
                      <CatChip category={r.category}>
                        {r.category}
                        {r.manual && <span title="직접 지정">✎</span>}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </CatChip>
                    </button>
                  </td>
                  <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }} data-testid="row-price">
                    {fmt(r.price)}원
                  </td>
                  <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{r.qty}개</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }} data-testid="row-amount">
                    {fmt(r.amount)}원
                  </td>
                </tr>
                </Fragment>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="sub" style={{ textAlign: 'center', padding: 28 }}>
                    조건에 맞는 결제 내역이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} className="sub">
          <span data-testid="count-label">
            {sel.length}건 중 {filtered.length}건 · {grouped ? '카테고리별, 묶음 안에서 ' : ''}{SORT_LABEL[sort.key][sort.dir === 'asc' ? 0 : 1]} {Math.min(shown, filtered.length)}건 표시
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {filtered.length > shown && (
              <button type="button" className="btn sm" onClick={() => setShown(shown + 20)}>
                더 보기
              </button>
            )}
            <button type="button" className="btn sm" onClick={exportCsv}>
              수정한 카테고리 CSV로 내려받기
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
