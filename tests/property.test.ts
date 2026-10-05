import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { addDays } from '../src/lib/dates'
import { prepareRows, summarize } from '../src/lib/pipeline'
import type { OrderRow, Settings, StatusFilter } from '../src/lib/types'
import { STATUSES } from '../src/lib/types'
import { MERGES, RULES } from './helpers'

const settings: Settings = { rules: RULES, merges: MERGES, overrides: { row: {}, group: {} }, dedupe: {} }
const NAMES = ['탐사수 무라벨, 2L, 12개', '펩시 제로 슈거 라임향, 500ml, 24개', '로지텍 마우스, 블랙', '핸드워시 청포도향, 450ml, 3개', '쿠쿠 에그밥솥', '신신파스, 20매', '곰곰 대란, 30구, 1개', '라운드랩 클렌저']

const rowArb = fc.record({
  order: fc.integer({ min: 1, max: 12 }),
  product: fc.integer({ min: 1, max: 6 }),
  day: fc.integer({ min: 0, max: 800 }),
  status: fc.constantFrom(...STATUSES),
  name: fc.constantFrom(...NAMES),
  qty: fc.integer({ min: 1, max: 4 }),
  price: fc.integer({ min: 100, max: 90000 }),
})

type Gen = { order: number; product: number; day: number; status: string; name: string; qty: number; price: number }

function toRows(gen: Gen[]): OrderRow[] {
  const seqs = new Map<string, number>()
  return gen.map((g) => {
    const order_no = String(1000 + g.order)
    const seq = seqs.get(order_no) ?? 0
    seqs.set(order_no, seq + 1)
    return {
      order_no, seq,
      ordered_at: `${addDays('2024-01-01', g.order * 60 + (g.day % 5))} 12:00:00`, // 주문번호당 같은 날짜대에 몰리도록
      bundle_no: null,
      product_no: String(g.product),
      status: g.status,
      raw_name: g.name,
      qty: g.qty,
      list_price: null,
      sale_price: g.price,
      seller: null,
    }
  })
}

const rowsArb = fc.array(rowArb, { minLength: 1, maxLength: 40 }).map((g) => toRows(g))
const run = { numRuns: 200 }

function sums(rows: OrderRow[], from: string, to: string, st: StatusFilter) {
  const prep = prepareRows(rows, null, settings)
  const end = prep.kept.reduce((m, r) => (r.date > m ? r.date : m), '0000-00-00')
  return { prep, end, s: summarize(prep.kept, from, to, st, end) }
}
const FROM = '2024-01-01'
const TO = '2027-12-31'

describe('성질 테스트', () => {
  it('1. 카테고리 합 == 총계, 건수 합 == 행 수', () => {
    fc.assert(fc.property(rowsArb, (rows) => {
      const { s } = sums(rows, FROM, TO, 'all')
      const cats = Object.values(s.by_category)
      expect(cats.reduce((a, c) => a + c.amount, 0)).toBe(s.total)
      expect(cats.reduce((a, c) => a + c.n, 0)).toBe(s.rows)
    }), run)
  })

  it('2. 구간 합 == 총계', () => {
    fc.assert(fc.property(rowsArb, (rows) => {
      const { s } = sums(rows, FROM, TO, 'all')
      expect(Object.values(s.buckets).reduce((a, b) => a + b.amount, 0)).toBe(s.total)
      expect(Object.values(s.buckets).reduce((a, b) => a + b.n, 0)).toBe(s.rows)
    }), run)
  })

  it('3. ok + ret == all', () => {
    fc.assert(fc.property(rowsArb, (rows) => {
      const ok = sums(rows, FROM, TO, 'ok').s
      const ret = sums(rows, FROM, TO, 'ret').s
      const all = sums(rows, FROM, TO, 'all').s
      expect(ok.total + ret.total).toBe(all.total)
      expect(ok.rows + ret.rows).toBe(all.rows)
    }), run)
  })

  it('4. 행 순서를 섞어도 합계가 같다', () => {
    fc.assert(fc.property(rowsArb.chain((rows) => fc.tuple(fc.constant(rows), fc.shuffledSubarray(rows, { minLength: rows.length, maxLength: rows.length }))), ([rows, shuffled]) => {
      const reseq = (list: OrderRow[]) => {
        const seqs = new Map<string, number>()
        return list.map((r) => {
          const seq = seqs.get(r.order_no) ?? 0
          seqs.set(r.order_no, seq + 1)
          return { ...r, seq }
        })
      }
      const a = sums(rows, FROM, TO, 'all').s
      const b = sums(reseq(shuffled), FROM, TO, 'all').s
      expect(b.total).toBe(a.total)
      expect(b.rows).toBe(a.rows)
      expect(b.by_category).toEqual(a.by_category)
      expect(b.buckets).toEqual(a.buckets)
    }), run)
  })

  it('5. 영수증 없이 기존 행을 그대로 한 번 더 추가해도 합계가 같다', () => {
    fc.assert(fc.property(rowsArb, fc.integer({ min: 0, max: 39 }), (rows, i) => {
      const dup = rows[i % rows.length]
      const same = rows.filter((r) => r.order_no === dup.order_no)
      const extra: OrderRow = { ...dup, seq: same.length }
      const a = sums(rows, FROM, TO, 'all').s
      const b = sums([...rows, extra], FROM, TO, 'all').s
      expect(b.total).toBe(a.total)
      expect(b.rows).toBe(a.rows)
    }), run)
  })

  it('6. 기간 [a,c] == [a,b] + [b+1일,c]', () => {
    fc.assert(fc.property(rowsArb, fc.integer({ min: 0, max: 1400 }), (rows, off) => {
      const b = addDays(FROM, off)
      const whole = sums(rows, FROM, TO, 'all').s
      const left = sums(rows, FROM, b, 'all').s
      const right = sums(rows, addDays(b, 1), TO, 'all').s
      expect(left.total + right.total).toBe(whole.total)
      expect(left.rows + right.rows).toBe(whole.rows)
    }), run)
  })

  it('7. 중복 제거는 멱등', () => {
    fc.assert(fc.property(rowsArb, (rows) => {
      const once = prepareRows(rows, null, settings)
      const keptRows: OrderRow[] = once.kept.map((k, i) => {
        const o = rows[k.idx]
        void i
        return o
      })
      const reseq = new Map<string, number>()
      const again = prepareRows(
        keptRows.map((r) => {
          const seq = reseq.get(r.order_no) ?? 0
          reseq.set(r.order_no, seq + 1)
          return { ...r, seq }
        }),
        null,
        settings,
      )
      expect(again.removed).toHaveLength(0)
      expect(again.kept).toHaveLength(once.kept.length)
    }), run)
  })
})
