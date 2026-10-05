import { round2 } from './normalize'
import type { EnrichedRow, ProductSummary } from './types'

export interface UnitStats {
  /** 상품 1개당 가격(판매가)이 가장 큰 행. 같으면 더 최근 거래 */
  top: EnrichedRow | null
  totalQty: number
  /** 총 지출 / 총 수량 = 상품 1개당 평균 가격 */
  avgUnit: number
}

/** 요약 지표는 가격 x 수량(금액)이 아니라 상품 1개당 가격 기준이다 */
export function unitStats(rows: EnrichedRow[]): UnitStats {
  let top: EnrichedRow | null = null
  let totalQty = 0
  let total = 0
  for (const r of rows) {
    if (!top || r.price > top.price || (r.price === top.price && r.dt > top.dt)) top = r
    totalQty += r.qty
    total += r.amount
  }
  return { top, totalQty, avgUnit: totalQty ? total / totalQty : 0 }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** 품목(group)별 요약. 한 번만 산 품목도 포함한다(검색 결과용). summarize 의 products 와 같은 필드 */
export function groupSummaries(rows: EnrichedRow[]): ProductSummary[] {
  const groups = new Map<string, EnrichedRow[]>()
  for (const r of rows) {
    const arr = groups.get(r.group)
    if (arr) arr.push(r)
    else groups.set(r.group, [r])
  }
  const out: ProductSummary[] = []
  for (const [group, ls] of groups) {
    const days = [...new Set(ls.map((l) => l.date))].sort(cmp)
    out.push({
      group,
      n: ls.length,
      amount: ls.reduce((a, l) => a + l.amount, 0),
      order_days: days.length,
      last: days[days.length - 1],
      min_unit_price: round2(Math.min(...ls.map((l) => l.unit_price))),
      max_unit_price: round2(Math.max(...ls.map((l) => l.unit_price))),
      aliases: [...new Set(ls.map((l) => l.base))].sort(cmp),
    })
  }
  return out
}

/** 검색어가 상품 이름(품목, 원래 이름, 옵션 포함 전체 이름)에 들어 있는지 */
export function matchesNeedle(r: EnrichedRow, needle: string): boolean {
  return r.group.toLowerCase().includes(needle) || r.base.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle)
}
