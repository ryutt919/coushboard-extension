import { describe, expect, it } from 'vitest'
import { runPipeline } from '../src/lib/pipeline'
import { fx, MERGES, PERIODS, RULES, STATUSES3 } from './helpers'

const run = (receipts: boolean) =>
  runPipeline({
    ordersCsv: fx('orders_fixture.csv'),
    receiptsCsv: receipts ? fx('receipts_fixture.csv') : null,
    rules: RULES,
    merges: MERGES,
    periods: PERIODS,
    statuses: [...STATUSES3],
  })

describe('골든: 픽스처 vs oracle 기대값', () => {
  it('영수증 있음', () => {
    expect(run(true)).toEqual(JSON.parse(fx('expected_with_receipts.json')))
  })
  it('영수증 없음', () => {
    expect(run(false)).toEqual(JSON.parse(fx('expected_without_receipts.json')))
  })
  it('손으로 검산한 값', () => {
    const r = run(true)
    expect(r.dedupe).toMatchObject({ removed: 2, restored: 1, restored_orders: ['1000000000003'] })
    expect(r.rows_after_dedupe).toBe(19)
    expect(r.unclassified).toBe(1)
    const all = r.summaries[0]
    expect(all.rows).toBe(17)
    expect(all.total).toBe(361540)
    expect(all.by_category['식품·음료']).toEqual({ n: 9, amount: 134660 })
    expect(all.by_category['건강·의료']).toEqual({ n: 2, amount: 89500 })
    expect(r.summaries[2]).toMatchObject({ status: 'ret', rows: 2, total: 1074000 })
    const pepsi = all.products.find((p) => p.group === '펩시 제로 슈거 라임향')!
    expect(pepsi).toMatchObject({ n: 4, amount: 92580, min_unit_price: 790 })
    expect(pepsi.aliases).toHaveLength(3)
    expect(r.reconcile).toMatchObject({ matched: 3, exact: 2 })
    expect(r.reconcile!.diffs[0]).toMatchObject({ order_no: '1000000000010', diff: -3000 })
    const noRec = run(false)
    expect(noRec.dedupe.removed).toBe(3)
    expect(noRec.summaries[0]).toMatchObject({ rows: 16, total: 341050 })
  })
})
