export type Status = '배송완료' | '교환완료' | '배송중' | '반품완료' | '취소완료'
export const STATUSES: Status[] = ['배송완료', '교환완료', '배송중', '반품완료', '취소완료']
export const OK_STATUSES = new Set<string>(['배송완료', '교환완료', '배송중'])
export const RET_STATUSES = new Set<string>(['반품완료', '취소완료'])

export type StatusFilter = 'ok' | 'all' | 'ret'

/** 주문목록 원본 1행 (DB order_items와 같은 모양) */
export interface OrderRow {
  order_no: string
  seq: number // 같은 주문 안에서 파일상 몇 번째 행인지(0부터)
  ordered_at: string // 'YYYY-MM-DD HH:mm:ss' (KST 그대로)
  bundle_no: string | null
  product_no: string
  status: string
  raw_name: string
  qty: number
  list_price: number | null
  sale_price: number
  seller: string | null
  /** 배송비(원). 외부 주문 도구 형식에만 있다. 총 지출에는 더하지 않고 별도로 보여 준다 */
  shipping_fee?: number | null
}

export interface ReceiptRow {
  receipt_key: string
  order_no: string
  paid_at: string // 'YYYY-MM-DD HH:mm:ss'
  item_name: string | null
  item_count: number | null
  total: number
}

export interface CategoryDef {
  name: string
  keywords: string[]
}

export interface RulesConfig {
  version?: number
  /** 어느 버전의 확장 키워드(category-rules-extra.json)까지 반영했는지. 없으면 0 */
  extrasVersion?: number
  fallback: string
  note?: string
  categories: CategoryDef[]
  /** 키워드 예외: 이 품목 키(base)는 해당 키워드로 분류하지 않는다 */
  exclusions?: { keyword: string; base: string }[]
}

export interface Overrides {
  row: Record<string, string> // '<order_no>:<seq>' -> category
  group: Record<string, string> // 품목 키 -> category
}

export interface Settings {
  rules: RulesConfig
  merges: Record<string, string>
  overrides: Overrides
  dedupe: Record<string, 'keep' | 'drop'> // '<order_no>:<seq>'
}

export interface EnrichedRow {
  idx: number
  key: string // '<order_no>:<seq>'
  order_no: string
  seq: number
  dt: string
  date: string
  product_no: string
  status: string
  raw_name: string
  name: string
  base: string
  opt: string
  group: string
  pieces: number
  unit_price: number
  price: number
  qty: number
  amount: number
  shipping_fee: number
  category: string
  auto_category: string
  manual: boolean
  restored: boolean
  seller: string | null
}

export interface Bucket {
  n: number
  amount: number
  future: boolean
}

export interface ProductSummary {
  group: string
  n: number
  amount: number
  order_days: number
  last: string
  min_unit_price: number
  max_unit_price: number
  aliases: string[]
}

export interface Summary {
  from: string
  to: string
  status: StatusFilter
  rows: number
  total: number
  order_days: number
  granularity: 'year' | 'month'
  buckets: Record<string, Bucket>
  by_category: Record<string, { n: number; amount: number }>
  products: ProductSummary[]
}

export interface Reconcile {
  matched: number
  exact: number
  diffs: { order_no: string; orders: number; receipts: number; diff: number }[]
  receipt_orders_missing: number
}

/** oracle.py 출력과 같은 구조 */
export interface PipelineResult {
  input: { rows_raw: number; orders: number; data_start: string; data_end: string }
  dedupe: { removed: number; restored: number; restored_orders: string[] }
  rows_after_dedupe: number
  unclassified: number
  reconcile: Reconcile | null
  summaries: Summary[]
}
