import { monthsBetween } from './dates'
import type { EnrichedRow } from './types'

export interface Coverage {
  start: string
  end: string
  /** 월별 기록이 드문 구간(없으면 null) */
  sparse: { from: string; to: string; rows: number } | null
  /** 매달 기록이 있는 구간(없으면 null) */
  dense: { from: string; to: string; rows: number } | null
}

/** 끝에서부터 거슬러 올라가 "매달 1건 이상 있는" 구간을 찾고, 그 앞을 드문 구간으로 본다 */
export function coverage(rows: EnrichedRow[]): Coverage | null {
  if (!rows.length) return null
  let start = rows[0].date
  let end = rows[0].date
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (r.date < start) start = r.date
    if (r.date > end) end = r.date
    const m = r.date.slice(0, 7)
    counts.set(m, (counts.get(m) ?? 0) + 1)
  }
  const months = monthsBetween(start, end)
  let i = months.length
  while (i > 0 && (counts.get(months[i - 1]) ?? 0) > 0) i -= 1
  const sum = (ms: string[]) => ms.reduce((a, m) => a + (counts.get(m) ?? 0), 0)
  const sparseMonths = months.slice(0, i)
  const denseMonths = months.slice(i)
  return {
    start,
    end,
    sparse: sparseMonths.length ? { from: sparseMonths[0], to: sparseMonths[sparseMonths.length - 1], rows: sum(sparseMonths) } : null,
    dense: denseMonths.length ? { from: denseMonths[0], to: denseMonths[denseMonths.length - 1], rows: sum(denseMonths) } : null,
  }
}

export const yymm = (m: string) => `${m.slice(2, 4)}.${m.slice(5, 7)}`
