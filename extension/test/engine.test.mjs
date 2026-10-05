import assert from "node:assert/strict";
import { collectAll } from "../lib/collect.js";
import { applyReceipts, applyReplaceOrders, applyShipping, migrateLegacyOrders } from "../lib/orders.js";
// 모의 어댑터: 2024(2페이지), 2025(3페이지), 2026(1페이지). 연도는 최신부터.
const data = { 2026: [[1]], 2025: [[2, 3], [4], [5]], 2024: [[6], [7]] };
const row = (n) => ({ order_no: String(n), seq: 0, product_no: "1", sale_price: 1, qty: 1 });
const mk = () => { let y, p; return {
  listYears: async () => Object.keys(data).sort().reverse(),
  goYear: async (v, start = 0) => { y = v; p = start; },
  readPage: async () => data[y][p].map(row),
  hasNext: async () => p < data[y].length - 1, nextPage: async () => { p++; } }; };
const fast = { sleepFn: async () => {}, delayMs: 0 };
let r = await collectAll(mk(), fast);
assert.equal(r.rows.length, 7); assert.deepEqual(r.perYear, { 2026: 1, 2025: 4, 2024: 2 });

// onPage: 페이지마다 호출하고(기다리고), 위치를 0부터 알려 준다
const seen = [];
await collectAll(mk(), { ...fast, onPage: async (p) => { await Promise.resolve(); seen.push(`${p.year}/${p.pageIndex}/${p.rows.length}`); } });
assert.deepEqual(seen, ["2026/0/1", "2025/0/2", "2025/1/1", "2025/2/1", "2024/0/1", "2024/1/1"]);
// onPage 가 던지면 즉시 멈춘다(저장 실패를 삼키지 않음)
await assert.rejects(collectAll(mk(), { ...fast, onPage: async () => { throw new Error("저장 실패"); } }), /저장 실패/);

// 이어서 하기: 2025년 1페이지부터. 더 최신 연도(2026)는 건너뛰고, 그 연도의 그 페이지부터 읽는다
const seen2 = [];
r = await collectAll(mk(), { ...fast, resume: { year: "2025", page: 1 }, onPage: async (p) => { seen2.push(`${p.year}/${p.pageIndex}`); } });
assert.deepEqual(seen2, ["2025/1", "2025/2", "2024/0", "2024/1"]);
// 목록에 없는 연도로 이어서 하라고 하면 처음부터
const seen3 = [];
await collectAll(mk(), { ...fast, resume: { year: "1999", page: 3 }, onPage: async (p) => { seen3.push(`${p.year}/${p.pageIndex}`); } });
assert.equal(seen3.length, 6);

// 페이지가 안 넘어가는 경우(nextPage 무효) -> 무한 루프 없이 종료
const stuck = mk(); stuck.nextPage = async () => {}; stuck.hasNext = async () => true;
r = await collectAll(stuck, { ...fast, maxPages: 50 });
assert.equal(r.rows.length, 4); // 2026:1 + 2025:2(첫 페이지) + 2024:1, 반복 페이지는 버림
// 중단: 페이지 사이에서 멈추고 aborted
const ac = new AbortController();
r = await collectAll(mk(), { ...fast, signal: ac.signal, onPage: async (p) => { if (p.year === "2025" && p.pageIndex === 0) ac.abort(); } });
assert.equal(r.aborted, true); assert.ok(r.rows.length < 7);
// 시작 전에 중단
const ac2 = new AbortController(); ac2.abort();
r = await collectAll(mk(), { ...fast, signal: ac2.signal }); assert.equal(r.aborted, true); assert.equal(r.rows.length, 0);
// 빈 연도 목록은 오류
await assert.rejects(collectAll({ listYears: async () => [] }, fast));

// 저장 규칙(웹앱 src/lib/stored.ts 와 같음): 같은 주문번호는 교체, 나머지는 보존. 같은 페이지를 다시 저장해도 늘지 않는다.
const o = (no, seq, extra = {}) => ({ order_no: no, seq, ordered_at: "2026-01-01 00:00:00", product_no: "p", status: "배송완료", raw_name: "x", qty: 1, sale_price: 100, ...extra });
let st = applyReplaceOrders([], [o("1", 0), o("1", 1), o("2", 0)]);
st = applyReplaceOrders(st, [o("1", 0, { status: "반품완료" }), o("1", 1, { status: "반품완료" })]);
assert.equal(st.length, 3); assert.equal(st.filter((x) => x.order_no === "1" && x.status === "반품완료").length, 2);
const again = applyReplaceOrders(st, [o("2", 0)]); assert.equal(again.length, 3);
assert.deepEqual(applyShipping([o("1", 0), o("1", 1)], [{ order_no: "1", fee: 3000 }]).map((x) => x.shipping_fee), [3000, null]);
assert.equal(applyReceipts([{ receipt_key: "a", total: 1 }], [{ receipt_key: "a", total: 2 }, { receipt_key: "b", total: 3 }]).length, 2);
// 첫 버전 행 -> 현재 모양
const mig = migrateLegacyOrders([{ order_no: "9", dt: "2025-01-01 00:00:00", product_no: "p", status: "배송완료", raw_name: "x", qty: 2, price: 500, src: "collect" },
  { order_no: "9", dt: "2025-01-01 00:00:00", product_no: "q", status: "배송완료", raw_name: "y", qty: 1, price: 700, src: "collect" }]);
assert.deepEqual(mig.map((x) => [x.seq, x.sale_price, x.ordered_at]), [[0, 500, "2025-01-01 00:00:00"], [1, 700, "2025-01-01 00:00:00"]]);
assert.equal(migrateLegacyOrders(mig), mig); // 이미 현재 모양이면 그대로
console.log("OK: collect engine (onPage, resume, abort) + order storage rules");
