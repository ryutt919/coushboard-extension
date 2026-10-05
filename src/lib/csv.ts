import Papa from 'papaparse'
import { cleanId } from './normalize'
import type { OrderRow, ReceiptRow } from './types'
import { STATUSES } from './types'

export const REQUIRED_ORDER_COLUMNS = ['주문번호', '주문일시', '상품번호', '상태', '상품명', '수량', '판매가'] as const
export const OPTIONAL_ORDER_COLUMNS = ['묶음배송번호', '정가', '판매자'] as const
export type OrderColumn = (typeof REQUIRED_ORDER_COLUMNS)[number] | (typeof OPTIONAL_ORDER_COLUMNS)[number]
/** 필수/선택 열 이름 -> 파일의 실제 헤더 이름 */
export type ColumnMapping = Partial<Record<OrderColumn, string>>

export interface RowIssue {
  line: number // 파일상 줄 번호(헤더=1)
  reason: string
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function parseRaw(text: string): { headers: string[]; records: Record<string, string>[] } {
  const res = Papa.parse<Record<string, string>>(stripBom(text), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  })
  return { headers: res.meta.fields ?? [], records: res.data }
}

const DT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

function toInt(v: string | undefined): number | null {
  const s = (v ?? '').trim().replace(/,/g, '')
  return /^\d+$/.test(s) ? Number(s) : null
}

export type OrderFormat = 'coupang-export' | 'orders-tool'

export interface ParsedOrders {
  headers: string[]
  missing: string[] // 짝지어지지 않은 필수 열
  rows: OrderRow[]
  issues: RowIssue[]
  totalRows: number
  /** 인식한 파일 형식 */
  format: OrderFormat
  /** 업로드 화면에 보여 줄 변환 안내 */
  notes: string[]
  /** 표준 상태로 바꾸지 못한 상태값(사용자가 짝지어야 함). 이 값의 행은 rows에 들어 있지 않다 */
  unknownStatuses: string[]
}

/** 외부 주문 도구가 쓰는 상태 이름 -> 표준 상태. 주문취소는 반품과 구분되지 않아 취소완료로 단순화한다 */
export const STATUS_ALIASES: Record<string, string> = {
  배송완료: '배송완료',
  배송중: '배송중',
  교환완료: '교환완료',
  교환: '교환완료',
  반품완료: '반품완료',
  반품: '반품완료',
  취소완료: '취소완료',
  주문취소: '취소완료',
  취소: '취소완료',
}

/**
 * 헤더로 파일 형식을 알아낸다.
 * - 쿠팡 주문목록 내보내기: 묶음배송번호, 정가 등이 있음
 * - 외부 주문 도구: 날짜(또는 주문일시), 주문번호, 상품명, 수량, 금액, 배송비, 상태. 묶음배송번호와 정가가 없음
 */
export function detectOrderFormat(headers: string[]): OrderFormat {
  const has = (h: string) => headers.includes(h)
  return has('배송비') && has('주문번호') && has('상품명') && !has('묶음배송번호') && !has('정가') ? 'orders-tool' : 'coupang-export'
}

// 외부 도구에는 상품번호가 없어서, 주문번호와 줄 순번으로 고유한 임시 번호를 만든다.
// 모든 행이 고유하므로 이 형식에는 자동 중복 제거가 적용되지 않는다.
const SYNTH_PREFIX = '99999'
export function syntheticProductNo(order_no: string, seq: number): string {
  return `${SYNTH_PREFIX}${order_no.padStart(16, '0')}${String(seq).padStart(3, '0')}`
}
export function isSyntheticProductNo(p: string): boolean {
  return p.startsWith(SYNTH_PREFIX) && p.length >= 24
}

/** 날짜만 있으면 00:00:00을 붙이고, 점이나 슬래시 구분, T 구분, 초가 없는 경우를 표준 형식으로 맞춘다 */
export function normalizeDateTime(raw: string): { value: string; timeMissing: boolean } | null {
  const s = raw.trim().replace(/[./]/g, '-').replace('T', ' ')
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return { value: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')} 00:00:00`, timeMissing: true }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (m) return { value: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')} ${m[4].padStart(2, '0')}:${m[5]}:${m[6] ?? '00'}`, timeMissing: false }
  return null
}

type Records = Record<string, string>[]

export function parseOrdersCsv(text: string, mapping: ColumnMapping = {}, statusMap: Record<string, string> = {}): ParsedOrders {
  const { headers, records } = parseRaw(text)
  return detectOrderFormat(headers) === 'orders-tool' ? parseToolOrders(headers, records, mapping, statusMap) : parseStandardOrders(headers, records, mapping, statusMap)
}

function parseStandardOrders(headers: string[], records: Records, mapping: ColumnMapping, statusMap: Record<string, string>): ParsedOrders {
  const col = (name: OrderColumn): string | undefined => {
    const m = mapping[name]
    if (m && headers.includes(m)) return m
    return headers.includes(name) ? name : undefined
  }
  const missing = REQUIRED_ORDER_COLUMNS.filter((c) => !col(c))
  if (missing.length) return { headers, missing: [...missing], rows: [], issues: [], totalRows: records.length, format: 'coupang-export', notes: [], unknownStatuses: [] }

  const issues: RowIssue[] = []
  const rows: OrderRow[] = []
  const unknown = new Set<string>()
  const seqs = new Map<string, number>()
  const get = (r: Record<string, string>, c: OrderColumn) => {
    const h = col(c)
    return h ? r[h] : undefined
  }
  records.forEach((r, i) => {
    const line = i + 2
    const order_no = cleanId(get(r, '주문번호'))
    const product_no = cleanId(get(r, '상품번호'))
    const ordered_at = (get(r, '주문일시') ?? '').trim()
    const rawStatus = (get(r, '상태') ?? '').trim()
    const status = statusMap[rawStatus] ?? rawStatus
    const raw_name = get(r, '상품명') ?? ''
    const qty = toInt(get(r, '수량'))
    const sale_price = toInt(get(r, '판매가'))
    const listRaw = (get(r, '정가') ?? '').trim()
    const list_price = listRaw === '' ? null : toInt(listRaw)
    const problems: string[] = []
    if (!/^\d+$/.test(order_no)) problems.push('주문번호가 숫자가 아님')
    if (!/^\d+$/.test(product_no)) problems.push('상품번호가 숫자가 아님')
    if (!DT_RE.test(ordered_at)) problems.push('주문일시 형식이 YYYY-MM-DD HH:mm:ss가 아님')
    const statusKnown = (STATUSES as string[]).includes(status)
    if (!statusKnown && rawStatus !== '') unknown.add(rawStatus)
    else if (rawStatus === '') problems.push('주문 상태가 비어 있음')
    if (raw_name.trim() === '') problems.push('상품명이 비어 있음')
    if (qty === null || qty <= 0) problems.push('수량이 1 이상의 정수가 아님')
    if (sale_price === null) problems.push('판매가가 정수가 아님')
    if (listRaw !== '' && list_price === null) problems.push('정가가 정수가 아님')
    if (problems.length) {
      issues.push({ line, reason: problems.join(', ') })
      return
    }
    if (!statusKnown) return // 알 수 없는 상태값: 사용자가 짝지을 때까지 보류
    const seq = seqs.get(order_no) ?? 0
    seqs.set(order_no, seq + 1)
    const bundle = cleanId(get(r, '묶음배송번호'))
    const seller = (get(r, '판매자') ?? '').trim()
    rows.push({
      order_no,
      seq,
      ordered_at,
      bundle_no: bundle === '' ? null : bundle,
      product_no,
      status,
      raw_name,
      qty: qty!,
      list_price,
      sale_price: sale_price!,
      seller: seller === '' ? null : seller,
    })
  })
  return { headers, missing: [], rows, issues, totalRows: records.length, format: 'coupang-export', notes: [], unknownStatuses: [...unknown].sort() }
}

/** 외부 주문 도구 형식: 금액은 줄 합계(가격 x 수량)이고, 날짜만 있고, 상품번호가 없다 */
function parseToolOrders(headers: string[], records: Records, mapping: ColumnMapping, statusMap: Record<string, string>): ParsedOrders {
  const pick = (names: string[], mapKey?: OrderColumn): string | undefined => {
    const m = mapKey ? mapping[mapKey] : undefined
    if (m && headers.includes(m)) return m
    return names.find((n) => headers.includes(n))
  }
  const cNo = pick(['주문번호'], '주문번호')
  const cDate = pick(['날짜', '주문일시'], '주문일시')
  const cName = pick(['상품명'], '상품명')
  const cQty = pick(['수량'], '수량')
  const cTotal = pick(['금액', '판매가'], '판매가')
  const cState = pick(['상태'], '상태')
  const cProd = pick(['상품번호'], '상품번호')
  const cShip = pick(['배송비'])
  const missing: string[] = []
  if (!cNo) missing.push('주문번호')
  if (!cDate) missing.push('주문일시')
  if (!cName) missing.push('상품명')
  if (!cQty) missing.push('수량')
  if (!cTotal) missing.push('판매가')
  if (!cState) missing.push('상태')
  if (missing.length) return { headers, missing, rows: [], issues: [], totalRows: records.length, format: 'orders-tool', notes: [], unknownStatuses: [] }

  const issues: RowIssue[] = []
  const rows: OrderRow[] = []
  const unknown = new Set<string>()
  const seqs = new Map<string, number>()
  let timeMissing = 0
  let synthetic = 0
  let nonDivisible = 0
  let cancelAlias = 0
  let shippingTotal = 0

  records.forEach((r, i) => {
    const line = i + 2
    const order_no = cleanId(r[cNo!])
    const dt = normalizeDateTime(r[cDate!] ?? '')
    const rawStatus = (r[cState!] ?? '').trim()
    const status = statusMap[rawStatus] ?? STATUS_ALIASES[rawStatus] ?? rawStatus
    const raw_name = r[cName!] ?? ''
    const qty0 = toInt(r[cQty!])
    const total = toInt(r[cTotal!])
    const shipRaw = cShip ? (r[cShip] ?? '').trim() : ''
    const shipping = shipRaw === '' ? null : toInt(shipRaw)
    const prodRaw = cProd ? cleanId(r[cProd]) : ''
    const problems: string[] = []
    if (!/^\d+$/.test(order_no)) problems.push('주문번호가 숫자가 아님')
    if (!dt) problems.push('날짜 형식이 YYYY-MM-DD가 아님')
    const statusKnown = (STATUSES as string[]).includes(status)
    if (!statusKnown && rawStatus !== '') unknown.add(rawStatus)
    else if (rawStatus === '') problems.push('주문 상태가 비어 있음')
    if (raw_name.trim() === '') problems.push('상품명이 비어 있음')
    if (qty0 === null || qty0 <= 0) problems.push('수량이 1 이상의 정수가 아님')
    if (total === null) problems.push('금액이 정수가 아님')
    if (shipRaw !== '' && shipping === null) problems.push('배송비가 정수가 아님')
    if (prodRaw !== '' && !/^\d+$/.test(prodRaw)) problems.push('상품번호가 숫자가 아님')
    if (problems.length) {
      issues.push({ line, reason: problems.join(', ') })
      return
    }
    if (!statusKnown) return
    const seq = seqs.get(order_no) ?? 0
    seqs.set(order_no, seq + 1)
    // 금액은 줄 합계이므로 1개당 가격으로 나눈다. 나누어떨어지지 않으면 금액을 지키려고 수량 1로 둔다
    let qty = qty0!
    let sale_price = total!
    if (qty > 1) {
      if (total! % qty === 0) sale_price = total! / qty
      else {
        qty = 1
        nonDivisible += 1
      }
    }
    let product_no = prodRaw
    if (product_no === '') {
      product_no = syntheticProductNo(order_no, seq)
      synthetic += 1
    }
    if (dt!.timeMissing) timeMissing += 1
    if (rawStatus === '주문취소' || rawStatus === '취소') cancelAlias += 1
    shippingTotal += shipping ?? 0
    rows.push({
      order_no,
      seq,
      ordered_at: dt!.value,
      bundle_no: null,
      product_no,
      status,
      raw_name,
      qty,
      list_price: null,
      sale_price,
      seller: null,
      shipping_fee: shipping,
    })
  })

  const notes = ['외부 주문 도구 형식으로 인식했습니다. 시각, 상품번호, 옵션이 없고 반품과 취소를 구분하지 못합니다.']
  notes.push('금액을 줄 합계(가격 × 수량)로 보고, 수량으로 나눠 1개당 가격을 계산했습니다.')
  if (timeMissing) notes.push(`날짜만 있어서 주문 시각은 00:00:00으로 채웠습니다 (${timeMissing}행).`)
  if (synthetic) notes.push(`상품번호가 없어 행마다 임시 번호를 붙였습니다 (${synthetic}행). 이 형식에는 자동 중복 제거를 적용하지 않습니다.`)
  if (cancelAlias) notes.push(`'주문취소' ${cancelAlias}행은 취소완료로 처리합니다.`)
  if (nonDivisible) notes.push(`금액이 수량으로 나누어떨어지지 않는 ${nonDivisible}행은 수량 1, 금액 그대로 저장합니다.`)
  if (shippingTotal) notes.push(`배송비 합계 ${shippingTotal.toLocaleString('ko-KR')}원은 총 지출에 더하지 않고 별도로 저장합니다.`)
  return { headers, missing: [], rows, issues, totalRows: records.length, format: 'orders-tool', notes, unknownStatuses: [...unknown].sort() }
}

export interface ParsedReceipts {
  headers: string[]
  rows: ReceiptRow[]
  issues: RowIssue[]
  missing: string[]
}

const REQUIRED_RECEIPT_COLUMNS = ['receipt_key', 'datetime', 'order_no', 'total'] as const

export function parseReceiptsCsv(text: string): ParsedReceipts {
  const { headers, records } = parseRaw(text)
  const missing = REQUIRED_RECEIPT_COLUMNS.filter((c) => !headers.includes(c))
  if (missing.length) return { headers, rows: [], issues: [], missing: [...missing] }
  const rows: ReceiptRow[] = []
  const issues: RowIssue[] = []
  records.forEach((r, i) => {
    const line = i + 2
    const order_no = cleanId(r.order_no)
    const key = (r.receipt_key ?? '').trim()
    const dt = (r.datetime ?? '').trim().replace('T', ' ')
    const total = toInt(r.total)
    const cntRaw = (r.item_count ?? '').trim()
    const cnt = cntRaw === '' ? null : Math.trunc(Number(cntRaw))
    const problems: string[] = []
    if (!key) problems.push('receipt_key가 비어 있음')
    if (!/^\d+$/.test(order_no)) problems.push('order_no가 숫자가 아님')
    if (!DT_RE.test(dt)) problems.push('datetime 형식 오류')
    if (total === null) problems.push('total이 정수가 아님')
    if (cnt !== null && !(cnt > 0)) problems.push('item_count가 1 이상이 아님')
    if (problems.length) {
      issues.push({ line, reason: problems.join(', ') })
      return
    }
    const name = (r.item_name ?? '').trim()
    rows.push({ receipt_key: key, order_no, paid_at: dt, item_name: name === '' ? null : name, item_count: cnt, total: total! })
  })
  return { headers, rows, issues, missing: [] }
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
