import { isSyntheticProductNo, type OrderFormat } from './csv'
import type { OrderRow } from './types'

/** 이미 저장된 주문 중 "자세한 데이터"(실제 상품번호가 있는 행)를 가진 주문번호 */
export function richOrderNos(existing: OrderRow[]): Set<string> {
  const out = new Set<string>()
  for (const r of existing) if (!isSyntheticProductNo(r.product_no)) out.add(r.order_no)
  return out
}

export type OverlapMode = 'skip' | 'overwrite'

export interface ImportPlan {
  rows: OrderRow[]
  /** 이미 더 자세한 데이터가 있어 건너뛴 주문 수 */
  skippedOrders: number
  /** 저장소에 없던 새 주문 수 */
  newOrders: number
  /** 같은 주문번호가 이미 있어 새 내용으로 바꾸는 주문 수 */
  replacedOrders: number
  /** 건너뛴 주문에 배송비만 합쳐 넣을 목록(주문 단위 합계). 이미 같은 값이면 넣지 않는다 */
  shippingUpdates: { order_no: string; fee: number }[]
}

/**
 * 올릴 행을 정한다.
 * - 쿠팡 내보내기: 지금까지처럼 같은 주문번호는 새 파일로 교체한다.
 * - 외부 주문 도구(시각, 상품번호, 옵션, 반품 구분이 없음): 이미 자세한 데이터가 있는 주문은 기본으로 건너뛴다.
 *   이전에 같은 도구로 올린 주문(임시 번호)은 같은 수준이므로 새 파일로 교체한다.
 */
export function planImport(rows: OrderRow[], existing: OrderRow[], format: OrderFormat, mode: OverlapMode): ImportPlan {
  const existingNos = new Set(existing.map((r) => r.order_no))
  const incomingNos = [...new Set(rows.map((r) => r.order_no))]
  if (format !== 'orders-tool' || mode === 'overwrite') {
    const replaced = incomingNos.filter((o) => existingNos.has(o)).length
    return { rows, skippedOrders: 0, newOrders: incomingNos.length - replaced, replacedOrders: replaced, shippingUpdates: [] }
  }
  const rich = richOrderNos(existing)
  const keep = rows.filter((r) => !rich.has(r.order_no))
  const keptNos = [...new Set(keep.map((r) => r.order_no))]
  const replaced = keptNos.filter((o) => existingNos.has(o)).length
  // 건너뛴 주문이라도 외부 도구가 알려 주는 배송비는 기존 주문에 합쳐 넣는다(기존 데이터에는 배송비가 없다)
  const sum = (list: OrderRow[], no: string) => list.filter((r) => r.order_no === no).reduce((a, r) => a + (r.shipping_fee ?? 0), 0)
  const shippingUpdates: ImportPlan['shippingUpdates'] = []
  for (const no of incomingNos) {
    if (!rich.has(no)) continue
    const fee = sum(rows, no)
    if (fee > 0 && fee !== sum(existing, no)) shippingUpdates.push({ order_no: no, fee })
  }
  return { rows: keep, skippedOrders: incomingNos.length - keptNos.length, newOrders: keptNos.length - replaced, replacedOrders: replaced, shippingUpdates }
}
