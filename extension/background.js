// 서비스 워커. 두 가지 일을 한다.
//  1) 저장소 쓰기를 한 줄 대기열로 처리: 수집(콘텐츠 스크립트)과 대시보드의 CSV 가져오기가 겹쳐도 주문 행이 서로 덮어써지지 않는다.
//  2) 수집 시작과 중단 요청 중계: 이미 수집 중이면 새로 시작하지 않는다(수집이 겹치면 데이터가 꼬이던 문제의 방지).
import { applyReceipts, applyReplaceOrders, applyShipping, migrateLegacyOrders } from "./lib/orders.js";

const COLLECT_KEY = "collect";
const STALE_MS = 30_000;
const ORDER_LIST = "https://mc.coupang.com/ssr/desktop/order/list";

let chain = Promise.resolve();
const enqueue = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => undefined); return p; };
const get = async (keys) => chrome.storage.local.get(keys);

// 첫 버전이 저장한 행 모양을 한 번 바꿔 둔다
async function migrate() {
  const { orders } = await get("orders");
  if (!orders) return;
  const next = migrateLegacyOrders(orders);
  if (next !== orders) await chrome.storage.local.set({ orders: next });
}

const handlers = {
  async ORDERS_REPLACE(m) {
    const { orders = [] } = await get("orders");
    await chrome.storage.local.set({ orders: applyReplaceOrders(orders, m.rows) });
  },
  async IMPORT_ORDERS(m) {
    const { orders = [], imports = [] } = await get(["orders", "imports"]);
    if (imports.some((i) => i.kind === "orders" && i.file_sha256 === m.meta.file_sha256)) return { duplicate: true };
    imports.push({ id: crypto.randomUUID(), kind: "orders", row_count: m.rows.length, created_at: new Date().toISOString(), ...m.meta });
    await chrome.storage.local.set({ orders: applyReplaceOrders(orders, m.rows), imports });
  },
  async IMPORT_RECEIPTS(m) {
    const { receipts = [], imports = [] } = await get(["receipts", "imports"]);
    if (imports.some((i) => i.kind === "receipts" && i.file_sha256 === m.meta.file_sha256)) return { duplicate: true };
    imports.push({ id: crypto.randomUUID(), kind: "receipts", row_count: m.rows.length, created_at: new Date().toISOString(), ...m.meta });
    await chrome.storage.local.set({ receipts: applyReceipts(receipts, m.rows), imports });
  },
  async ORDERS_SHIPPING(m) {
    const { orders = [] } = await get("orders");
    await chrome.storage.local.set({ orders: applyShipping(orders, m.updates) });
  },
  async DELETE_ALL() {
    await chrome.storage.local.remove(["orders", "receipts", "imports", "settings", COLLECT_KEY]);
  },
};

// ---- 수집 시작/중단 ----
const isRunning = (s) => s?.status === "running" && (s.updatedAt ?? 0) > Date.now() - STALE_MS;

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(on); resolve(); };
    const on = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && done());
    setTimeout(done, 20_000);
  });
}

async function sendToTab(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch {
    // 확장을 설치하거나 새로 고치기 전에 열려 있던 탭에는 콘텐츠 스크립트가 없다. 넣고 한 번 더 보낸다.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/collector.js"] });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

let starting = false;
async function startCollect(mode) {
  if (starting) return { ok: false, error: "수집을 시작하는 중입니다." };
  starting = true;
  try {
    const { [COLLECT_KEY]: state } = await get(COLLECT_KEY);
    if (isRunning(state)) return { ok: false, error: "이미 수집 중입니다. 진행 상황은 팝업이나 대시보드에서 볼 수 있습니다." };
    const tabs = await chrome.tabs.query({ url: "*://mc.coupang.com/*" });
    let tab = tabs.find((t) => /\/ssr\/desktop\/order\/list/.test(t.url ?? "")) ?? tabs[0];
    if (!tab) tab = await chrome.tabs.create({ url: ORDER_LIST, active: true });
    else if (!/\/ssr\/desktop\/order\/list/.test(tab.url ?? "")) tab = await chrome.tabs.update(tab.id, { url: ORDER_LIST, active: true });
    await waitForLoad(tab.id);
    return await sendToTab(tab.id, { type: "COLLECT", mode });
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  finally { starting = false; }
}

async function abortCollect() {
  const tabs = await chrome.tabs.query({ url: "*://mc.coupang.com/*" });
  let reached = false;
  for (const t of tabs) { try { const r = await chrome.tabs.sendMessage(t.id, { type: "ABORT" }); reached ||= !!r?.aborted; } catch { /* 콘텐츠 스크립트가 없는 탭 */ } }
  if (!reached) { // 수집하던 탭이 닫힌 경우: 끊긴 running 상태를 중단됨으로 바꾼다
    const { [COLLECT_KEY]: s } = await get(COLLECT_KEY);
    if (s?.status === "running") await chrome.storage.local.set({ [COLLECT_KEY]: { ...s, status: "aborted", updatedAt: Date.now() } });
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((m, _sender, send) => {
  if (m?.type === "START_COLLECT") { startCollect(m.mode).then(send); return true; }
  if (m?.type === "ABORT_COLLECT") { abortCollect().then(send); return true; }
  if (m?.type === "OPEN_DASHBOARD") { chrome.tabs.create({ url: chrome.runtime.getURL("app/extension.html") }).then(() => send({ ok: true })); return true; }
  const h = handlers[m?.type];
  if (!h) return false; // 다른 메시지(진행 상황 등)는 이 워커가 처리하지 않는다
  enqueue(async () => { await migrate(); return (await h(m)) ?? {}; })
    .then((r) => send({ ok: true, ...r }), (e) => send({ ok: false, error: String(e.message || e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => enqueue(migrate));
