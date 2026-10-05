import { compileRules } from './classify'
import { parseOrdersCsv, parseReceiptsCsv } from './csv'
import { planBuckets } from './dates'
import { mergeGroup, piecesOf, round2, splitName } from './normalize'
import type {
  Bucket,
  EnrichedRow,
  OrderRow,
  Overrides,
  PipelineResult,
  ProductSummary,
  ReceiptRow,
  Reconcile,
  RulesConfig,
  Settings,
  StatusFilter,
  Summary,
} from './types'
import { OK_STATUSES, RET_STATUSES } from './types'

export const EMPTY_OVERRIDES: Overrides = { row: {}, group: {} }

export function rowKey(order_no: string, seq: number): string {
  return `${order_no}:${seq}`
}

interface RawRow extends OrderRow {
  idx: number
  date: string
}

export interface Prepared {
  rawCount: number
  orderCount: number
  /** 중복 제거 후 남은 행(파일 순서). 영수증으로 되살린 행 포함 */
  kept: EnrichedRow[]
  /** 중복으로 제거된 행 */
  removed: EnrichedRow[]
  /** 영수증 검증으로 되살린 행(kept에도 들어 있음) */
  restored: EnrichedRow[]
  receiptsGiven: boolean
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 3-1 중복 제거 + 영수증 복원 + 사용자 되돌리기. oracle.dedupe와 같은 규칙 */
function dedupeRaw(rows: RawRow[], receipts: ReceiptRow[] | null, dedupeOverrides: Settings['dedupe']) {
  const seen = new Set<string>()
  let kept: RawRow[] = []
  let removed: RawRow[] = []
  for (const r of rows) {
    const k = `${r.order_no}\u0000${r.product_no}\u0000${r.sale_price}\u0000${r.qty}`
    if (seen.has(k)) removed.push(r)
    else kept.push(r)
    seen.add(k)
  }
  const restored: RawRow[] = []
  if (receipts) {
    const recItems = new Map<string, number>()
    for (const rc of receipts) recItems.set(rc.order_no, (recItems.get(rc.order_no) ?? 0) + (rc.item_count ?? 1))
    const keptCount = new Map<string, number>()
    for (const r of kept) keptCount.set(r.order_no, (keptCount.get(r.order_no) ?? 0) + 1)
    for (const [o, n] of recItems) {
      const gap = n - (keptCount.get(o) ?? 0)
      if (gap <= 0) continue
      const cands = removed.filter((r) => r.order_no === o).slice(0, gap)
      for (const r of cands) {
        removed = removed.filter((x) => x !== r)
        kept.push(r)
        restored.push(r)
      }
    }
    kept.sort((a, b) => a.idx - b.idx)
  }
  // 사용자가 개별로 되돌린 행
  const key = (r: RawRow) => rowKey(r.order_no, r.seq)
  const forceKeep = removed.filter((r) => dedupeOverrides[key(r)] === 'keep')
  if (forceKeep.length) {
    removed = removed.filter((r) => !forceKeep.includes(r))
    kept = [...kept, ...forceKeep].sort((a, b) => a.idx - b.idx)
  }
  const forceDrop = kept.filter((r) => dedupeOverrides[key(r)] === 'drop')
  if (forceDrop.length) {
    kept = kept.filter((r) => !forceDrop.includes(r))
    removed = [...removed, ...forceDrop].sort((a, b) => a.idx - b.idx)
  }
  return { kept, removed, restored }
}

function enrich(rows: RawRow[], settings: Settings, restoredSet: Set<RawRow>): EnrichedRow[] {
  const clf = compileRules(settings.rules)
  const { row: rowOv, group: groupOv } = settings.overrides
  return rows.map((r) => {
    const { name, base, opt } = splitName(r.raw_name)
    const group = mergeGroup(base, settings.merges)
    const pieces = piecesOf(opt)
    const key = rowKey(r.order_no, r.seq)
    const auto = clf.classify(name, base)
    const manualCat = rowOv[key] ?? groupOv[base] ?? groupOv[group]
    return {
      idx: r.idx,
      key,
      order_no: r.order_no,
      seq: r.seq,
      dt: r.ordered_at,
      date: r.date,
      product_no: r.product_no,
      status: r.status,
      raw_name: r.raw_name,
      name,
      base,
      opt,
      group,
      pieces,
      unit_price: r.sale_price / pieces,
      price: r.sale_price,
      qty: r.qty,
      amount: r.sale_price * r.qty,
      shipping_fee: r.shipping_fee ?? 0,
      category: manualCat ?? auto,
      auto_category: auto,
      manual: manualCat !== undefined,
      restored: restoredSet.has(r),
      seller: r.seller,
    }
  })
}

/** DB 행(또는 CSV 파싱 결과)에서 정리된 행 목록을 만든다. 화면과 runPipeline이 함께 쓴다. */
export function prepareRows(orders: OrderRow[], receipts: ReceiptRow[] | null, settings: Settings): Prepared {
  const raw: RawRow[] = orders.map((o, idx) => ({ ...o, idx, date: o.ordered_at.slice(0, 10) }))
  const { kept, removed, restored } = dedupeRaw(raw, receipts, settings.dedupe)
  const restoredSet = new Set(restored)
  return {
    rawCount: raw.length,
    orderCount: new Set(raw.map((r) => r.order_no)).size,
    kept: enrich(kept, settings, restoredSet),
    removed: enrich(removed, settings, restoredSet),
    restored: enrich(restored, settings, restoredSet),
    receiptsGiven: receipts !== null,
  }
}

export function statusPass(status: string, filter: StatusFilter): boolean {
  if (filter === 'ok') return OK_STATUSES.has(status)
  if (filter === 'ret') return RET_STATUSES.has(status)
  return true
}

export function selectRows(rows: EnrichedRow[], from: string, to: string, filter: StatusFilter): EnrichedRow[] {
  return rows.filter((r) => r.date >= from && r.date <= to && statusPass(r.status, filter))
}

export function summarize(rows: EnrichedRow[], from: string, to: string, status: StatusFilter, dataEnd: string): Summary {
  const sel = selectRows(rows, from, to, status)
  const plan = planBuckets(from, to)
  const buckets: Record<string, Bucket> = {}
  for (const k of plan.keys) buckets[k] = { n: 0, amount: 0, future: plan.isFuture(k, dataEnd) }
  for (const r of sel) {
    const b = buckets[plan.keyOf(r.date)]
    if (b) {
      b.n += 1
      b.amount += r.amount
    }
  }
  const byCat: Record<string, { n: number; amount: number }> = {}
  for (const r of sel) {
    const c = (byCat[r.category] ??= { n: 0, amount: 0 })
    c.n += 1
    c.amount += r.amount
  }
  const sortedCat: Summary['by_category'] = {}
  for (const k of Object.keys(byCat).sort(cmp)) sortedCat[k] = byCat[k]

  const groups = new Map<string, EnrichedRow[]>()
  for (const r of sel) {
    const arr = groups.get(r.group)
    if (arr) arr.push(r)
    else groups.set(r.group, [r])
  }
  const products: ProductSummary[] = []
  for (const [group, ls] of groups) {
    if (ls.length < 2) continue
    const days = [...new Set(ls.map((l) => l.date))].sort(cmp)
    products.push({
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
  products.sort((a, b) => b.n - a.n || b.amount - a.amount || cmp(a.group, b.group))
  return {
    from,
    to,
    status,
    rows: sel.length,
    total: sel.reduce((a, r) => a + r.amount, 0),
    order_days: new Set(sel.map((r) => r.date)).size,
    granularity: plan.granularity,
    buckets,
    by_category: sortedCat,
    products,
  }
}

export function reconcile(rows: EnrichedRow[], receipts: ReceiptRow[] | null): Reconcile | null {
  if (!receipts) return null
  const ord = new Map<string, number>()
  for (const r of rows) ord.set(r.order_no, (ord.get(r.order_no) ?? 0) + r.amount)
  const rec = new Map<string, number>()
  for (const rc of receipts) rec.set(rc.order_no, (rec.get(rc.order_no) ?? 0) + rc.total)
  const matched = [...ord.keys()].filter((o) => rec.has(o)).sort(cmp)
  const diffs = matched
    .filter((o) => ord.get(o) !== rec.get(o))
    .map((o) => ({ order_no: o, orders: ord.get(o)!, receipts: rec.get(o)!, diff: ord.get(o)! - rec.get(o)! }))
  const missing = [...rec.keys()].filter((o) => !ord.has(o)).length
  return { matched: matched.length, exact: matched.length - diffs.length, diffs, receipt_orders_missing: missing }
}

export function dataRange(rows: EnrichedRow[]): { start: string; end: string } {
  if (!rows.length) return { start: '', end: '' }
  let s = rows[0].date
  let e = rows[0].date
  for (const r of rows) {
    if (r.date < s) s = r.date
    if (r.date > e) e = r.date
  }
  return { start: s, end: e }
}

export function buildResult(
  prep: Prepared,
  receipts: ReceiptRow[] | null,
  periods: string[],
  statuses: StatusFilter[],
  fallback: string,
): PipelineResult {
  const { start, end } = dataRange(prep.kept)
  const summaries: Summary[] = []
  for (const p of periods.length ? periods : ['ALL']) {
    const [from, to] = p === 'ALL' ? [start, end] : p.split(':')
    for (const s of statuses.length ? statuses : (['ok'] as StatusFilter[])) {
      summaries.push(summarize(prep.kept, from, to, s, end))
    }
  }
  return {
    input: { rows_raw: prep.rawCount, orders: prep.orderCount, data_start: start, data_end: end },
    dedupe: {
      removed: prep.removed.length,
      restored: prep.restored.length,
      restored_orders: [...new Set(prep.restored.map((r) => r.order_no))].sort(cmp),
    },
    rows_after_dedupe: prep.kept.length,
    unclassified: prep.kept.filter((r) => r.category === fallback).length,
    reconcile: reconcile(prep.kept, receipts),
    summaries,
  }
}

export interface PipelineCsvInput {
  ordersCsv: string
  receiptsCsv?: string | null
  rules: RulesConfig
  merges: Record<string, string>
  periods: string[]
  statuses: StatusFilter[]
}

/** 출력 계약: oracle.py와 똑같은 JSON 구조 */
export function runPipeline(input: PipelineCsvInput): PipelineResult {
  const po = parseOrdersCsv(input.ordersCsv)
  if (po.missing.length) throw new Error('missing columns: ' + po.missing.join(', '))
  if (po.issues.length) throw new Error(`invalid rows: ${po.issues.length} (first line ${po.issues[0].line}: ${po.issues[0].reason})`)
  let receipts: ReceiptRow[] | null = null
  if (input.receiptsCsv) {
    const pr = parseReceiptsCsv(input.receiptsCsv)
    if (pr.missing.length) throw new Error('missing receipt columns: ' + pr.missing.join(', '))
    if (pr.issues.length) throw new Error(`invalid receipt rows: ${pr.issues.length}`)
    receipts = pr.rows
  }
  return runPipelineFromRows(po.rows, receipts, input)
}

export function runPipelineFromRows(
  orders: OrderRow[],
  receipts: ReceiptRow[] | null,
  opts: { rules: RulesConfig; merges: Record<string, string>; periods: string[]; statuses: StatusFilter[]; overrides?: Overrides; dedupe?: Settings['dedupe'] },
): PipelineResult {
  const settings: Settings = {
    rules: opts.rules,
    merges: opts.merges,
    overrides: opts.overrides ?? EMPTY_OVERRIDES,
    dedupe: opts.dedupe ?? {},
  }
  const prep = prepareRows(orders, receipts, settings)
  return buildResult(prep, receipts, opts.periods, opts.statuses, opts.rules.fallback)
}
