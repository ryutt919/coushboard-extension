import { describe, expect, it } from 'vitest'
import { generateDemo, ordersToCsv } from '../../src/lib/demo'
import { parseOrdersCsv } from '../../src/lib/csv'
import { prepareRows, summarize } from '../../src/lib/pipeline'
import { DEFAULT_MERGES, DEFAULT_RULES } from '../../src/lib/stored'

describe('예시(mock) 데이터', () => {
  const { orders, receipts } = generateDemo()
  it('항상 같은 결과(시드 고정)', () => {
    expect(generateDemo().orders).toEqual(orders)
  })
  it('실제 쿠팡 주문번호 형식(321로 시작하는 14자리)이 아니다', () => {
    expect(orders.every((o) => !/^321\d{11}$/.test(o.order_no))).toBe(true)
  })
  it('CSV로 내보냈다가 다시 읽어도 같다', () => {
    const parsed = parseOrdersCsv(ordersToCsv(orders))
    expect(parsed.missing).toEqual([])
    expect(parsed.issues).toEqual([])
    expect(parsed.rows).toEqual(orders)
  })
  it('중복 제거, 영수증 복원, 분류, 반품/취소가 모두 예시에 나타난다', () => {
    const prep = prepareRows(orders, receipts, { rules: DEFAULT_RULES, merges: DEFAULT_MERGES, overrides: { row: {}, group: {} }, dedupe: {} })
    expect(prep.removed.length + prep.restored.length).toBeGreaterThan(0)
    expect(prep.restored.length).toBeGreaterThan(0)
    const end = prep.kept.reduce((m, r) => (r.date > m ? r.date : m), '')
    const s = summarize(prep.kept, '2024-11-04', end, 'all', end)
    expect(Object.keys(s.by_category).length).toBeGreaterThanOrEqual(6)
    expect(s.by_category['미분류']?.n).toBeGreaterThan(0)
    expect(summarize(prep.kept, '2024-11-04', end, 'ret', end).rows).toBeGreaterThan(0)
    expect(s.products.length).toBeGreaterThan(5)
    console.log('demo', orders.length, 'rows', prep.kept.length, 'kept', receipts.length, 'receipts', end)
  })
})
