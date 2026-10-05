// mc.coupang.com 주문목록 페이지에서 실행. 수집을 이 탭에서 돌리고, 진행 상태를 chrome.storage.local 의 `collect` 키에 남긴다.
// 팝업이나 대시보드는 그 상태만 읽으므로 닫았다 열어도 수집은 계속되고 진행 상황이 이어서 보인다.
// 규칙:
//  - 한 번에 하나만: 이미 수집 중이면(이 탭이든 다른 탭이든) 새로 시작하지 않는다.
//  - 페이지마다 저장: 읽을 때마다 background 의 한 줄 대기열로 주문 행을 저장하고 체크포인트(연도, 페이지)를 기록한다.
//    같은 주문은 주문 단위로 교체되므로 이어서 하다 겹치는 페이지가 있어도 중복되지 않는다.
//  - 끊기면 이어서: 오류, 중단, 탭 닫힘 모두 체크포인트가 남아 "이어서 수집"으로 이어 간다.
// 같은 탭에 두 번 들어와도 살아 있는 인스턴스는 하나만 둔다. 확장을 새로 고쳐 죽은 옛 인스턴스(chrome.runtime 이 사라짐)만 남은 탭에서는 새로 시작한다.
const prevInstance = globalThis.__coupangLedgerCollector;
if (!prevInstance || !prevInstance.alive()) {
  globalThis.__coupangLedgerCollector = { alive: () => { try { return !!chrome.runtime?.id; } catch { return false; } } };
  const KEY = "collect";
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
    let prev, collectAll, createAdapter;
    try {
      prev = await getState();
      if (prev?.status === "running" && (prev.updatedAt ?? 0) > Date.now() - STALE_MS) { current = null; return { ok: false, error: "다른 탭에서 수집 중입니다." }; }
      [{ collectAll }, { createAdapter }] = await Promise.all([
        import(chrome.runtime.getURL("lib/collect.js")), import(chrome.runtime.getURL("lib/adapter.js"))]);
    } catch (e) { current = null; throw e; }
    const resume = mode === "resume" && prev?.checkpoint ? prev.checkpoint : null;
    // 이어서 할 때는 이전 실행이 저장한 페이지별 행 수를 이어 받아 연도별 합계를 이어서 센다
    const pageRows = resume ? { ...(prev.pageRows ?? {}) } : {};
    let st = { status: "running", runId, startedAt: Date.now(), years: [], year: resume?.year ?? null, yearIndex: 0, page: resume?.page ?? 0,
      rows: resume ? prev.rows ?? 0 : 0, pageRows, checkpoint: resume, error: null };
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
            await putState({ ...st, perYear: perYear() });
          },
        });
        st = { ...st, status: out.aborted ? "aborted" : "done", checkpoint: out.aborted ? st.checkpoint : null };
      } catch (e) {
        st = { ...st, status: "error", error: String(e.message || e) };
      } finally {
        current = null;
        await putState({ ...st, perYear: perYear() });
      }
    })();
    return { ok: true, runId };
  }

  chrome.runtime.onMessage.addListener((m, _sender, send) => {
    if (m?.type === "COLLECT") { start(m.mode).then(send, (e) => send({ ok: false, error: String(e.message || e) })); return true; }
    if (m?.type === "ABORT") { send({ ok: true, aborted: !!current }); current?.ctrl.abort(); return false; }
    return false;
  });
}
