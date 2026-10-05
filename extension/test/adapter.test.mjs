// 어댑터 테스트. 실제 구매 데이터는 쓰지 않고 합성 응답만 쓴다. 실행: node test/adapter.test.mjs
import assert from "node:assert/strict";
import { createAdapter, rowsFromOrder, mapStatus, kstDateTime } from "../lib/adapter.js";
import { collectAll } from "../lib/collect.js";

const item = (id, name, over = {}) => ({ vendorItemId: id, vendorItemName: name, productName: name.split(",")[0], quantity: 1,
  unitPrice: 1000, discountedUnitPrice: 900, combinedUnitPrice: 900, ...over });
const group = (invoiceStatus, items) => ({ invoiceStatus, productList: items });
const order = (id, at, groups, extra = {}) => ({ orderId: id, orderedAt: at, deliveryGroupList: groups, ...extra });

// 1) 시각: epoch ms -> KST (UTC+9)
assert.equal(kstDateTime(Date.UTC(2025, 4, 22, 6, 27, 39)), "2025-05-22 15:27:39");

// 2) 열 대응과 형 변환: 상품번호=vendorItemId, 상품명=vendorItemName(옵션 포함), 판매가=discountedUnitPrice, ID 는 문자열
const rows = rowsFromOrder(order(10000000000123, Date.UTC(2025, 4, 22, 6, 27, 39), [{ ...group("FINAL_DELIVERY", [
  item(90000000001, "샘플 파스타, 500g, 3개", { quantity: 2, unitPrice: 5900, discountedUnitPrice: 5190 }),
  item(90000000002, "샘플 우유, 900ml, 2개")]), shipmentBoxId: "1108798707190464512", vendorName: "쿠팡(주)" }]));
assert.deepEqual(rows, [
  { order_no: "10000000000123", seq: 0, ordered_at: "2025-05-22 15:27:39", bundle_no: "1108798707190464512", product_no: "90000000001", status: "배송완료",
    raw_name: "샘플 파스타, 500g, 3개", qty: 2, list_price: 5900, sale_price: 5190, seller: "쿠팡(주)" },
  { order_no: "10000000000123", seq: 1, ordered_at: "2025-05-22 15:27:39", bundle_no: "1108798707190464512", product_no: "90000000002", status: "배송완료",
    raw_name: "샘플 우유, 900ml, 2개", qty: 1, list_price: 1000, sale_price: 900, seller: "쿠팡(주)" }]);

// 3) 상태 대응(CSV 대조로 확인된 4가지 + 미확인은 이름을 붙여 남김)
assert.equal(mapStatus({ invoiceStatus: "FINAL_DELIVERY" }, {}), "배송완료");
assert.equal(mapStatus({ invoiceStatus: "DELIVERING" }, {}), "배송중");
assert.equal(mapStatus({ invoiceStatus: "FINAL_DELIVERY" }, { cancelReturnStatus: "RETURN_COMPLETE" }), "반품완료");
assert.equal(mapStatus({ invoiceStatus: "DELIVERING" }, { cancelReturnStatus: "RETURN_COMPLETE" }), "반품완료"); // 배송그룹이 배송중이어도 반품
assert.equal(mapStatus({ invoiceStatus: "INSTRUCT" }, { cancelReturnStatus: "CANCELED" }), "취소완료");
assert.equal(mapStatus({ invoiceStatus: "ACCEPT" }, { cancelReturnStatus: "CANCELED" }), "취소완료");
assert.equal(mapStatus({ invoiceStatus: "INSTRUCT" }, {}), "미확인(INSTRUCT)");
assert.equal(mapStatus({ invoiceStatus: "FINAL_DELIVERY" }, { cancelReturnStatus: "WHATEVER" }), "미확인(WHATEVER)");

// 4) 취소/반품 묶음은 읽지 않는다(이중 집계 방지). 같은 주문 안의 같은 상품 두 줄은 그대로 두 줄(중복 제거 없음)
const dup = rowsFromOrder(order(1, 0, [group("FINAL_DELIVERY", [item(7, "탐사수, 2L, 12개")]), group("FINAL_DELIVERY", [item(7, "탐사수, 2L, 12개")])],
  { deliveryCancelBundleList: [{ status: "RETURN_COMPLETE", productList: [item(7, "탐사수, 2L, 12개")] }] }));
assert.equal(dup.length, 2); assert.deepEqual(dup.map((r) => r.seq), [0, 1]); // 같은 주문 안에서 0부터 이어지는 seq

// 5) 모양이 달라지면 조용히 넘기지 않고 던진다
assert.throws(() => rowsFromOrder(order(1, 0, [group("FINAL_DELIVERY", [{ vendorItemId: 1 }])])), /UNEXPECTED_SHAPE/);
assert.throws(() => rowsFromOrder({ orderId: 1, orderedAt: 0 }), /UNEXPECTED_SHAPE/);

// 6) 가짜 쿠팡: 2026(1페이지), 2025(2페이지), 2024(1페이지, 끝). 연도가 끝나도 hasNext=true, nextYear 만 바뀌는 실제 동작을 따라 한다.
const years = {
  2026: [[order(30, Date.UTC(2026, 0, 3), [group("FINAL_DELIVERY", [item(1, "a, 1개")])])]],
  2025: [[order(21, Date.UTC(2025, 5, 3), [group("FINAL_DELIVERY", [item(2, "b, 1개")])]), order(22, Date.UTC(2025, 5, 2), [group("INSTRUCT", [item(3, "c, 1개", { cancelReturnStatus: "CANCELED" })])])],
    [order(23, Date.UTC(2025, 1, 1), [group("DELIVERING", [item(4, "d, 1개", { cancelReturnStatus: "RETURN_COMPLETE" })])])]],
  2024: [[order(10, Date.UTC(2024, 0, 1), [group("FINAL_DELIVERY", [item(5, "e, 1개")])])]],
};
const calls = [];
function fakeFetch(opts = {}) {
  return async (url, init) => {
    assert.equal(init.credentials, "same-origin");
    const q = new URL(url, "https://mc.coupang.com").searchParams; calls.push(`${q.get("requestYear")}/${q.get("pageIndex")}`);
    if (opts.fail) return opts.fail(q);
    const y = +q.get("requestYear"), p = +q.get("pageIndex"), pages = years[y];
    const last = p === pages.length - 1;
    const body = { pageIndex: p, orderList: pages[p], hasNext: !last || !!years[y - 1], nextYear: last ? y - 1 : y, nextPageIndex: last ? 0 : p + 1 };
    return { ok: true, status: 200, redirected: false, headers: { get: () => "application/json" }, text: async () => JSON.stringify(body) };
  };
}
const doc = (ys) => ({ querySelectorAll: () => ys.map((t) => ({ children: [], textContent: t })).concat([{ children: [], textContent: "최근 6개월" }, { children: [], textContent: "2025-12" }]) });
const loc = { host: "mc.coupang.com" };
const fast = { sleepFn: async () => {}, delayMs: 0 };

let ad = createAdapter({ fetchFn: fakeFetch(), doc: doc(["2024", "2026", "2025", "2025"]), loc });
assert.deepEqual(await ad.listYears(), ["2026", "2025", "2024"]); // 연도 칩만(중복 제거, 최신순). "최근 6개월", "2025-12" 는 제외
let out = await collectAll(ad, fast);
assert.deepEqual(out.perYear, { 2026: 1, 2025: 3, 2024: 1 });
assert.deepEqual(calls, ["2026/0", "2025/0", "2025/1", "2024/0"]); // 연도 경계에서 다음 연도로 넘어가지 않고, 연도별로 0부터
assert.deepEqual(out.rows.map((r) => r.status), ["배송완료", "배송완료", "취소완료", "반품완료", "배송완료"]);
assert.ok(out.rows.every((r) => typeof r.order_no === "string" && typeof r.product_no === "string"));

// 7) 에러는 즉시 던지고 재시도하지 않는다
for (const [label, resp, re] of [
  ["HTTP 429", { ok: false, status: 429 }, /HTTP_429/],
  ["로그인 리다이렉트", { ok: true, redirected: true, headers: { get: () => "text/html" }, text: async () => "" }, /LOGIN_OR_CAPTCHA/],
  ["HTML 응답", { ok: true, redirected: false, headers: { get: () => "text/html" }, text: async () => "<html>" }, /LOGIN_OR_CAPTCHA/],
]) {
  calls.length = 0;
  ad = createAdapter({ fetchFn: fakeFetch({ fail: () => resp }), doc: doc(["2026"]), loc });
  await assert.rejects(collectAll(ad, fast), re, label);
  assert.equal(calls.length, 1, `${label}: 재시도 없이 1회`);
}

// 8) 연속이 아닌 nextPageIndex 는 중단
ad = createAdapter({ doc: doc(["2025"]), loc, fetchFn: async () => ({ ok: true, redirected: false, headers: { get: () => "application/json" },
  text: async () => JSON.stringify({ orderList: [], hasNext: true, nextYear: 2025, nextPageIndex: 5 }) }) });
await ad.goYear("2025"); await assert.rejects(ad.hasNext(), /PAGING_BROKEN/);

// 9) 엉뚱한 페이지/연도 칩 없음은 명확한 오류
await assert.rejects(createAdapter({ doc: doc([]), loc }).listYears(), /연도 칩/);
await assert.rejects(createAdapter({ doc: doc(["2025"]), loc: { host: "www.coupang.com" } }).listYears(), /mc\.coupang\.com/);

// 10) 미확인 상태는 값마다 한 번만 경고
const warns = []; calls.length = 0;
years[2026][0][0].deliveryGroupList[0].invoiceStatus = "INSTRUCT";
ad = createAdapter({ fetchFn: fakeFetch(), doc: doc(["2026"]), loc, warn: (m) => warns.push(m) });
await ad.goYear("2026"); await ad.readPage(); await ad.readPage();
assert.equal(warns.length, 1); assert.match(warns[0], /미확인\(INSTRUCT\)/);

// 11) 19자리 묶음배송번호는 JSON.parse 로 깨지지 않고 문자열 그대로 담긴다(원문 텍스트에서 문자열로 바꿔 읽음)
ad = createAdapter({ doc: doc(["2025"]), loc, fetchFn: async () => ({ ok: true, redirected: false, headers: { get: () => "application/json" },
  text: async () => '{"orderList":[{"orderId":10000000000999,"orderedAt":0,"deliveryGroupList":[{"shipmentBoxId":1108798707190464512,"invoiceStatus":"FINAL_DELIVERY","productList":[{"vendorItemId":1,"vendorItemName":"x","quantity":1,"unitPrice":1,"discountedUnitPrice":1}]}]}],"hasNext":false}' }) });
await ad.goYear("2025"); assert.equal((await ad.readPage())[0].bundle_no, "1108798707190464512");

// 12) 어댑터는 수집마다 따로: 두 어댑터가 서로의 상태를 덮어쓰지 않는다(수집이 겹치던 때의 데이터 꼬임 방지)
calls.length = 0;
const a1 = createAdapter({ fetchFn: fakeFetch(), doc: doc(["2025"]), loc }), a2 = createAdapter({ fetchFn: fakeFetch(), doc: doc(["2025"]), loc });
await a1.goYear("2026"); await a2.goYear("2024");
assert.equal((await a1.readPage())[0].raw_name, "a, 1개"); assert.equal((await a2.readPage())[0].raw_name, "e, 1개");

console.log("OK: adapter (열 대응, 상태 대응, 연도 경계, 에러 즉시 중단, 형식 검증)");
