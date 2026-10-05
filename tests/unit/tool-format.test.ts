import { describe, expect, it } from 'vitest'
import { detectOrderFormat, isSyntheticProductNo, normalizeDateTime, parseOrdersCsv, syntheticProductNo } from '../../src/lib/csv'
import { planImport, richOrderNos } from '../../src/lib/importPlan'
import { prepareRows, summarize } from '../../src/lib/pipeline'
import { DEFAULT_MERGES, DEFAULT_RULES_EXTENDED } from '../../src/lib/stored'
import type { OrderRow } from '../../src/lib/types'
import { fx } from '../helpers'

const settings = { rules: DEFAULT_RULES_EXTENDED, merges: DEFAULT_MERGES, overrides: { row: {}, group: {} }, dedupe: {} }
const TOOL = fx('orders_tool_fixture.csv')
const HEAD = '날짜,주문번호,상품명,수량,금액,배송비,상태'
const csv = (...rows: string[]) => [HEAD, ...rows].join('\n') + '\n'

describe('형식 감지', () => {
  it('외부 주문 도구 원본 헤더', () => {
    expect(detectOrderFormat(['날짜', '주문번호', '상품명', '수량', '금액', '배송비', '상태'])).toBe('orders-tool')
  })
  it('직접 고친 헤더(주문일시, 판매가, 빈 상품번호 열)도 같은 형식', () => {
    expect(detectOrderFormat(['주문일시', '주문번호', '상품명', '수량', '판매가', '배송비', '상태', '상품번호'])).toBe('orders-tool')
  })
  it('쿠팡 주문목록 내보내기는 그대로 쿠팡 형식', () => {
    const head = (fx('orders_fixture.csv').split(/\r?\n/)[0] ?? '').replace(/^\ufeff/, '').split(',')
    expect(detectOrderFormat(head)).toBe('coupang-export')
  })
})

describe('외부 주문 도구 형식 변환', () => {
  const p = parseOrdersCsv(TOOL)

  it('BOM과 CRLF가 있어도 7행을 읽고 문제가 없다', () => {
    expect(p.format).toBe('orders-tool')
    expect(p.missing).toEqual([])
    expect(p.issues).toEqual([])
    expect(p.unknownStatuses).toEqual([])
    expect(p.rows).toHaveLength(7)
  })

  it('날짜만 있으면 00:00:00을 붙인다', () => {
    expect(p.rows[0].ordered_at).toBe('2026-06-03 00:00:00')
    expect(p.notes.join(' ')).toContain('00:00:00')
  })

  it('금액은 줄 합계라서 수량으로 나눠 1개당 가격을 만든다', () => {
    const r = p.rows.filter((x) => x.order_no === '2000000000002')
    expect(r[0]).toMatchObject({ qty: 2, sale_price: 6000 }) // 12,000원 / 2
    expect(r[0].sale_price * r[0].qty).toBe(12000)
    expect(r[1]).toMatchObject({ qty: 1, sale_price: 7900 })
  })

  it('나누어떨어지지 않으면 금액을 지키려고 수량 1로 둔다', () => {
    const r = p.rows.find((x) => x.order_no === '2000000000004')!
    expect(r).toMatchObject({ qty: 1, sale_price: 10000 }) // 10,000원 / 3 은 정수가 아님
    expect(p.notes.join(' ')).toContain('나누어떨어지지 않는 1행')
  })

  it('주문취소는 취소완료, 배송완료는 그대로', () => {
    expect(p.rows.find((x) => x.order_no === '2000000000003')!.status).toBe('취소완료')
    expect(p.rows.find((x) => x.order_no === '2000000000001')!.status).toBe('배송완료')
    expect(p.notes.join(' ')).toContain('주문취소')
  })

  it('배송비를 행에 담고, 안내에 합계를 보여 준다(총 지출에는 더하지 않음)', () => {
    expect(p.rows.map((r) => r.shipping_fee)).toEqual([0, 0, 0, 3000, 0, 2500, 0])
    expect(p.notes.join(' ')).toContain('5,500원')
  })

  it('상품번호가 없으면 행마다 고유한 임시 번호를 붙이고, 같은 입력이면 같은 번호다', () => {
    const nos = p.rows.map((r) => r.product_no)
    expect(new Set(nos).size).toBe(nos.length)
    expect(nos.every(isSyntheticProductNo)).toBe(true)
    expect(parseOrdersCsv(TOOL).rows.map((r) => r.product_no)).toEqual(nos)
    expect(syntheticProductNo('123', 0)).not.toBe(syntheticProductNo('123', 1))
    expect(isSyntheticProductNo('86681535514')).toBe(false) // 실제 상품번호는 임시 번호가 아니다
  })

  it('직접 고친 헤더로 읽어도 결과가 같다', () => {
    const edited = TOOL.replace(HEAD, '주문일시,주문번호,상품명,수량,판매가,배송비,상태, 상품번호')
    const q = parseOrdersCsv(edited)
    expect(q.format).toBe('orders-tool')
    expect(q.rows).toEqual(p.rows)
  })

  it('시각이 같이 있거나 점, 슬래시 구분이어도 표준 형식으로 맞춘다', () => {
    expect(normalizeDateTime('2026-06-03')?.value).toBe('2026-06-03 00:00:00')
    expect(normalizeDateTime('2026.6.3')?.value).toBe('2026-06-03 00:00:00')
    expect(normalizeDateTime('2026/06/03 14:05')?.value).toBe('2026-06-03 14:05:00')
    expect(normalizeDateTime('2026-06-03T14:05:09')?.value).toBe('2026-06-03 14:05:09')
    expect(normalizeDateTime('2026-06-03T14:05:09')?.timeMissing).toBe(false)
    expect(normalizeDateTime('어제')).toBeNull()
  })

  it('형식이 틀린 행은 줄 번호와 사유만 보고한다(상품명은 담지 않는다)', () => {
    const q = parseOrdersCsv(csv('어제,2000000000009,비밀상품,1,1000,0,배송완료', '2026-06-03,2000000000009,비밀상품,1,천원,0,배송완료', '2026-06-03,abc,비밀상품,1,1000,x,배송완료'))
    expect(q.rows).toHaveLength(0)
    expect(q.issues.map((i) => i.line)).toEqual([2, 3, 4])
    expect(JSON.stringify(q.issues)).not.toContain('비밀상품')
  })

  it('필요한 열이 없으면 알려 주고, 짝짓기로 해결한다', () => {
    const q = parseOrdersCsv('일자,주문번호,상품명,수량,금액,배송비,상태\n2026-06-03,2000000000009,가,1,1000,0,배송완료\n')
    expect(q.missing).toEqual(['주문일시'])
    const fixed = parseOrdersCsv('일자,주문번호,상품명,수량,금액,배송비,상태\n2026-06-03,2000000000009,가,1,1000,0,배송완료\n', { 주문일시: '일자' })
    expect(fixed.missing).toEqual([])
    expect(fixed.rows).toHaveLength(1)
  })
})

describe('알 수 없는 상태값', () => {
  it('외부 도구 형식: 모르는 상태는 보류하고, 짝지으면 올린다', () => {
    const text = csv('2026-06-03,2000000000009,가,1,1000,0,발송준비', '2026-06-03,2000000000008,나,1,2000,0,배송완료')
    const q = parseOrdersCsv(text)
    expect(q.unknownStatuses).toEqual(['발송준비'])
    expect(q.issues).toEqual([])
    expect(q.rows).toHaveLength(1)
    const mapped = parseOrdersCsv(text, {}, { 발송준비: '배송중' })
    expect(mapped.unknownStatuses).toEqual([])
    expect(mapped.rows.map((r) => r.status).sort()).toEqual(['배송완료', '배송중'])
  })

  it('쿠팡 형식도 모르는 상태를 줄마다 오류로 막지 않고 짝짓게 한다', () => {
    const text = '주문번호,주문일시,상품번호,상태,상품명,수량,판매가\n1,2026-01-01 10:00:00,2,발송준비,가,1,100\n'
    const q = parseOrdersCsv(text)
    expect(q.format).toBe('coupang-export')
    expect(q.unknownStatuses).toEqual(['발송준비'])
    expect(q.issues).toEqual([])
    expect(parseOrdersCsv(text, {}, { 발송준비: '배송중' }).rows).toHaveLength(1)
  })
})

describe('중복 제거는 이 형식에 적용하지 않는다', () => {
  it('같은 주문의 같은 상품, 같은 금액 두 줄을 모두 센다', () => {
    const q = parseOrdersCsv(csv('2026-06-03,2000000000009,가,1,1000,0,배송완료', '2026-06-03,2000000000009,가,1,1000,0,배송완료'))
    const prep = prepareRows(q.rows, null, settings)
    expect(prep.removed).toHaveLength(0)
    expect(prep.kept).toHaveLength(2)
  })
})

describe('겹치는 주문 처리', () => {
  const rich: OrderRow = {
    order_no: '1000000000001', seq: 0, ordered_at: '2024-11-03 10:00:00', bundle_no: null, product_no: '501',
    status: '배송완료', raw_name: '탐사수 무라벨, 2L, 12개', qty: 1, list_price: 6790, sale_price: 6790, seller: null,
  }
  const tool = parseOrdersCsv(TOOL).rows

  it('실제 상품번호가 있는 주문을 자세한 데이터로 본다', () => {
    expect(richOrderNos([rich, ...tool])).toEqual(new Set(['1000000000001']))
  })

  it('기본은 건너뛰기: 이미 자세한 주문은 빼고 새 주문만 올린다', () => {
    const plan = planImport(tool, [rich, { ...rich, order_no: '1000000000002' }], 'orders-tool', 'skip')
    expect(plan.skippedOrders).toBe(2)
    expect(plan.newOrders).toBe(4)
    expect(plan.replacedOrders).toBe(0)
    // 건너뛴 주문이라도 배송비는 기존 주문에 합쳐 넣는다(기존 데이터에는 배송비가 없다)
    expect(plan.shippingUpdates).toEqual([{ order_no: '1000000000002', fee: 2500 }])
    expect(new Set(plan.rows.map((r) => r.order_no))).toEqual(new Set(['2000000000001', '2000000000002', '2000000000003', '2000000000004']))
  })

  it('이미 같은 배송비가 있으면 다시 합치지 않는다', () => {
    const existing = [{ ...rich, order_no: '1000000000002', shipping_fee: 2500 }, rich]
    expect(planImport(tool, existing, 'orders-tool', 'skip').shippingUpdates).toEqual([])
  })

  it('덮어쓰기를 고르면 모두 올린다', () => {
    const plan = planImport(tool, [rich], 'orders-tool', 'overwrite')
    expect(plan.rows).toHaveLength(tool.length)
    expect(plan.skippedOrders).toBe(0)
    expect(plan.replacedOrders).toBe(1)
  })

  it('같은 도구로 먼저 올린 주문(임시 번호)은 같은 수준이라 새 내용으로 바꾼다', () => {
    const plan = planImport(tool, tool, 'orders-tool', 'skip')
    expect(plan.skippedOrders).toBe(0)
    expect(plan.replacedOrders).toBe(6)
    expect(plan.shippingUpdates).toEqual([])
  })

  it('쿠팡 내보내기는 지금까지처럼 교체하고 건너뛰지 않는다', () => {
    const plan = planImport([rich], [rich], 'coupang-export', 'skip')
    expect(plan.rows).toHaveLength(1)
    expect(plan.skippedOrders).toBe(0)
    expect(plan.replacedOrders).toBe(1)
  })
})

describe('집계에는 영향을 주지 않고 배송비는 따로 센다', () => {
  it('총 지출은 금액만, 배송비는 별도', () => {
    const prep = prepareRows(parseOrdersCsv(TOOL).rows.filter((r) => r.order_no.startsWith('2')), null, settings)
    const s = summarize(prep.kept, '2026-06-01', '2026-06-30', 'ok', '2026-06-03')
    // 배송완료: 9,900 + 12,000 + 7,900 + 10,000 (주문취소 24,900은 제외)
    expect(s.total).toBe(39800)
    expect(s.rows).toBe(4)
    expect(prep.kept.reduce((a, r) => a + r.shipping_fee, 0)).toBe(3000)
  })
})
