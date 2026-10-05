// 연도 × 페이지 순회 엔진. 쿠팡 화면 의존 부분은 adapter 로 분리했다(lib/adapter.js).
// adapter 인터페이스:
//   listYears(): Promise<string[]>              선택 가능한 연도 목록(최신 연도부터)
//   goYear(year, startPage = 0): Promise<void>  해당 연도의 startPage(0부터)를 가져온다
//   readPage(): Promise<Row[]>                  가져온 페이지의 주문 행들
//   hasNext(): Promise<boolean>                 같은 연도 안에 다음 페이지가 있는지
//   nextPage(): Promise<void>                   다음 페이지를 가져온다
// 옵션:
//   onPage({year, yearIndex, years, pageIndex, rows}): 페이지를 읽을 때마다 부른다(기다린다). 호출한 쪽이 이 안에서 저장하면
//     중간에 끊겨도 그 페이지까지는 남는다. 같은 주문을 다시 저장해도 주문 단위로 교체되므로 겹쳐도 중복되지 않는다.
//   resume: {year, page}. 그 연도의 그 페이지부터 이어서 한다(그보다 최신 연도는 건너뜀). 이미 저장한 페이지를 한 번 더 읽는다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sig = (rows) => rows.map((r) => `${r.order_no}|${r.product_no}|${r.sale_price}|${r.qty}`).join(",");

// 요청 간격은 2.2~3.5초(쿠팡 요청 간격 2초 이상 규칙).
export async function collectAll(adapter, { delayMs = 2200, jitter = 0.6, maxPages = 200, onProgress = () => {}, onPage = async () => {}, signal, resume = null, sleepFn = sleep } = {}) {
  const wait = () => sleepFn(delayMs * (1 + Math.random() * jitter));
  const years = await adapter.listYears();
  if (!years.length) throw new Error("연도 목록을 찾지 못했습니다(adapter 확인 필요)");
  // 이어서 하기: resume 연도가 목록에 있으면 그보다 최신 연도는 이미 끝난 것으로 보고 건너뛴다
  const resumeAt = resume && years.includes(String(resume.year)) ? years.indexOf(String(resume.year)) : -1;
  const from = Math.max(0, resumeAt);
  const all = [], perYear = {};
  for (const [yi, year] of years.entries()) {
    if (yi < from) continue;
    if (signal?.aborted) break;
    let pageIndex = yi === resumeAt ? Math.max(0, resume.page | 0) : 0;
    await adapter.goYear(year, pageIndex); await wait();
    let prev = null, count = 0;
    for (;;) {
      if (signal?.aborted) break;
      const rows = await adapter.readPage();
      const s = sig(rows);
      if (s === prev) break;                       // 다음 페이지가 안 바뀌면 중단(무한 루프 방지)
      prev = s; all.push(...rows); count += rows.length;
      await onPage({ year, yearIndex: yi + 1, years, pageIndex, rows });
      onProgress({ year, yearIndex: yi + 1, years: years.length, page: pageIndex, rows: count, total: all.length });
      if (pageIndex >= maxPages || !(await adapter.hasNext())) break;
      await adapter.nextPage(); await wait(); pageIndex++;
    }
    perYear[year] = count;
  }
  return { rows: all, perYear, aborted: !!signal?.aborted };
}
