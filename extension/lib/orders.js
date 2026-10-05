// 저장된 주문 행을 바꾸는 순수 함수. 웹앱의 src/lib/stored.ts 와 같은 규칙이다(replace_orders, receipts, 배송비).
// background.js 의 한 줄 대기열 안에서만 호출되므로, 수집(콘텐츠 스크립트)과 CSV 가져오기가 겹쳐도 서로 덮어쓰지 않는다.

/** 새 행에 있는 주문번호의 기존 행을 모두 지우고 새 행을 넣는다 */
export function applyReplaceOrders(orders, rows) {
  const incoming = new Set(rows.map((r) => r.order_no));
  return [...orders.filter((o) => !incoming.has(o.order_no)), ...rows];
}

export function applyReceipts(receipts, rows) {
  const keys = new Set(rows.map((r) => r.receipt_key));
  return [...receipts.filter((r) => !keys.has(r.receipt_key)), ...rows];
}

/** 주문 단위 배송비: 그 주문의 첫 행(seq 0)에 담고 나머지 행은 비운다 */
export function applyShipping(orders, updates) {
  const fees = new Map(updates.map((u) => [u.order_no, u.fee]));
  return orders.map((o) => (fees.has(o.order_no) ? { ...o, shipping_fee: o.seq === 0 ? fees.get(o.order_no) : null } : o));
}

/** 첫 버전(v0.1)이 저장한 행({dt, price, src ...})을 현재 행 모양으로 바꾼다. 이미 현재 모양이면 그대로 둔다 */
export function migrateLegacyOrders(orders) {
  if (!orders.some((r) => r && "dt" in r && !("ordered_at" in r))) return orders;
  const seqs = new Map();
  return orders.map((r) => {
    if ("ordered_at" in r) return r;
    const seq = seqs.get(r.order_no) ?? 0; seqs.set(r.order_no, seq + 1);
    return { order_no: r.order_no, seq, ordered_at: r.dt, bundle_no: null, product_no: r.product_no, status: r.status,
      raw_name: r.raw_name, qty: r.qty, list_price: null, sale_price: r.price, seller: null };
  });
}
