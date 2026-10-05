// mc.coupang.com 주문목록 페이지에서 실행. 수집을 이 탭에서 돌리고, 진행 상태를 chrome.storage.local 의 `collect` 키에 남긴다.
// 팝업이나 대시보드는 그 상태만 읽으므로 닫았다 열어도 수집은 계속되고 진행 상황이 이어서 보인다.
// 규칙:
//  - 한 번에 하나만: 이미 수집 중이면(이 탭이든 다른 탭이든) 새로 시작하지 않는다.
//  - 페이지마다 저장: 읽을 때마다 background 의 한 줄 대기열로 주문 행을 저장하고 체크포인트(연도, 페이지)를 기록한다.
//    같은 주문은 주문 단위로 교체되므로 이어서 하다 겹치는 페이지가 있어도 중복되지 않는다.
//  - 끊기면 이어서: 오류, 중단, 탭 닫힘 모두 체크포인트가 남아 "이어서 수집"으로 이어 간다.
//  - 두 번째부터는 새 주문만: 전체 수집을 한 번 끝낸 뒤에는 이미 가지고 있는 주문만 있는 페이지를 만나면 멈춘다(mode "new").
//    새 주문은 기존 주문에 합쳐 저장되므로 이전 내역과 함께 보인다. 전체를 다시 받으려면 mode "fresh".
// 같은 탭에 두 번 들어와도 살아 있는 인스턴스는 하나만 둔다. 확장을 새로 고쳐 죽은 옛 인스턴스(chrome.runtime 이 사라짐)만 남은 탭에서는 새로 시작한다.
const prevInstance = globalThis.__coupangLedgerCollector;
if (!prevInstance || !prevInstance.alive()) {
  globalThis.__coupangLedgerCollector = { alive: () => { try { return !!chrome.runtime?.id; } catch { return false; } } };
  const KEY = "collect";
  const SYNC_KEY = "sync";           // { lastFullAt, lastRunAt }: 전체 수집을 끝낸 시각과 마지막 수집 시각
  const KNOWN_KEY = "collectKnown";  // 새 주문만 가져오는 중에 "시작 때 이미 있던 주문번호" (이어서 할 때 쓴다)
  const STALE_MS = 30_000;
  let current = null; // { runId, ctrl }

  const getState = async () => (await chrome.storage.local.get(KEY))[KEY];
  const putState = (s) => chrome.storage.local.set({ [KEY]: { ...s, updatedAt: Date.now() } });

  async function saveRows(rows) {
    const res = await chrome.runtime.sendMessage({ type: "ORDERS_REPLACE", rows });
    if (!res?.ok) throw new Error(res?.error || "주문 저장에 실패했습니다");
  }

  async function start(mode) {
    if (current) return { ok: false, error: "이미 수집 중입니다." };
    if (location.host !== "mc.coupang.com") return { ok: false, error: "쿠팡 주문목록 페이지(mc.coupang.com)에서 실행해 주세요." };
    // await 가 들어가기 전에 자리부터 잡아, 시작 요청이 거의 동시에 두 번 와도 수집은 한 번만 시작한다
    const runId = crypto.randomUUID(), ctrl = new AbortController();
    current = { runId, ctrl };
    let prev, store, collectAll, createAdapter;
    try {
      prev = await getState();
      if (prev?.status === "running" && (prev.updatedAt ?? 0) > Date.now() - STALE_MS) { current = null; return { ok: false, error: "다른 탭에서 수집 중입니다." }; }
      store = await chrome.storage.local.get(["orders", SYNC_KEY, KNOWN_KEY]);
      [{ collectAll }, { createAdapter }] = await Promise.all([
        import(chrome.runtime.getURL("lib/collect.js")), import(chrome.runtime.getURL("lib/adapter.js"))]);
    } catch (e) { current = null; throw e; }

    // 어떤 수집으로 할지: 이어서(이전 수집과 같은 방식), 새 주문만, 전체
    const orders = store.orders ?? [];
    const sync = store.sync ?? {};
    // 이전 버전이 끝낸 전체 수집도 전체 수집을 끝낸 것으로 본다
    const lastFullAt = sync.lastFullAt ?? (prev?.status === "done" && prev.mode !== "new" && orders.length ? prev.updatedAt : null);
    const canNew = !!lastFullAt && orders.length > 0;
    const resume = mode === "resume" && prev?.checkpoint ? prev.checkpoint : null;
    const runMode = resume ? (prev.mode === "new" ? "new" : "full") : mode === "new" && canNew ? "new" : "full";

    // 새 주문만: 시작할 때 이미 가지고 있던 주문번호. 이어서 할 때는 처음 시작할 때 적어 둔 것을 쓴다.
    // (이어서 읽는 페이지의 새 주문은 이미 저장되어 있어서, 지금 저장소에서 다시 뽑으면 "이미 있는 주문"으로 잘못 보게 된다)
    let known = null;
    if (runMode === "new") {
      known = new Set(resume && store[KNOWN_KEY] ? store[KNOWN_KEY] : orders.map((o) => o.order_no));
      if (!(resume && store[KNOWN_KEY])) await chrome.storage.local.set({ [KNOWN_KEY]: [...known] });
    } else {
      await chrome.storage.local.remove(KNOWN_KEY);
    }
    const countNew = async () => {
      const now = (await chrome.storage.local.get("orders")).orders ?? [];
      return new Set(now.map((o) => o.order_no).filter((n) => !known.has(n))).size;
    };

    // 이어서 할 때는 이전 실행이 저장한 페이지별 행 수를 이어 받아 연도별 합계를 이어서 센다
    const pageRows = resume ? { ...(prev.pageRows ?? {}) } : {};
    let st = { status: "running", mode: runMode, runId, startedAt: Date.now(), years: [], year: resume?.year ?? null, yearIndex: 0, page: resume?.page ?? 0,
      rows: resume ? prev.rows ?? 0 : 0, newOrders: resume ? prev.newOrders ?? 0 : 0, stopReason: null, pageRows, checkpoint: resume, error: null };
    const perYear = () => Object.fromEntries(Object.entries(st.pageRows).map(([y, pages]) => [y, Object.values(pages).reduce((a, b) => a + b, 0)]));
    await putState({ ...st, perYear: perYear() });

    (async () => {
      try {
        const out = await collectAll(createAdapter(), {
          signal: ctrl.signal, resume,
          onPage: async ({ year, yearIndex, years, pageIndex, rows }) => {
            await saveRows(rows);
            (st.pageRows[year] ??= {})[pageIndex] = rows.length;
            st = { ...st, years, year, yearIndex, page: pageIndex, rows: st.rows + rows.length, checkpoint: { year, page: pageIndex } };
            if (known) st.newOrders = await countNew();
            await putState({ ...st, perYear: perYear() });
          },
          // 새 주문만: 이미 가지고 있던 주문만 있는 페이지를 읽었으면(방금 저장해서 그 페이지의 기존 주문도 최신 상태로 갱신됨) 멈춘다
          stopWhen: known ? ({ rows }) => rows.length > 0 && rows.every((r) => known.has(r.order_no)) : null,
        });
        if (out.aborted) {
          st = { ...st, status: "aborted" };
        } else {
          st = { ...st, status: "done", checkpoint: null, stopReason: out.stopped ? "known" : null };
          const now = Date.now();
          await chrome.storage.local.set({ [SYNC_KEY]: { ...sync, lastRunAt: now, lastFullAt: runMode === "full" ? now : lastFullAt } });
          await chrome.storage.local.remove(KNOWN_KEY);
        }
      } catch (e) {
        st = { ...st, status: "error", error: String(e.message || e) };
      } finally {
        current = null;
        await putState({ ...st, perYear: perYear() });
      }
    })();
    return { ok: true, runId, mode: runMode };
  }

  chrome.runtime.onMessage.addListener((m, _sender, send) => {
    if (m?.type === "COLLECT") { start(m.mode).then(send, (e) => send({ ok: false, error: String(e.message || e) })); return true; }
    if (m?.type === "ABORT") { send({ ok: true, aborted: !!current }); current?.ctrl.abort(); return false; }
    return false;
  });
}
