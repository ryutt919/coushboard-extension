import { expect, type BrowserContext, type Page, type Route } from '@playwright/test'
import { swOf, test } from '../e2e/fixtures'
import { expectNoSeriousA11y } from '../e2e/helpers'
import type { OrderRow } from '../../src/lib/types'

// 크롬 확장의 수집 시나리오. 쿠팡 서버에는 접속하지 않고 https://mc.coupang.com 요청을 가로채 합성 응답(실제 응답과 같은 필드 이름)을 준다.
// 확인하는 것: 팝업을 닫아도 수집이 계속됨, 겹쳐 시작되지 않음(이중 수집 방지), 페이지마다 저장, 중단과 오류 뒤 이어서 수집, 중복 없음.

const it = (id: number, name: string, o: Record<string, unknown> = {}) => ({ vendorItemId: id, vendorItemName: name, quantity: 1, unitPrice: 1000, discountedUnitPrice: 900, ...o })
const grp = (inv: string, items: unknown[]) => ({ invoiceStatus: inv, vendorName: '쿠팡(주)', shipmentBoxId: '__BOX__', productList: items })
const ord = (id: number, dt: string, groups: unknown[]) => ({ orderId: id, orderedAt: Date.parse(dt + '+09:00'), deliveryGroupList: groups })

/** 연도별 주문. 2026 12건(3페이지), 2025 12건(3페이지), 2024 5건(1페이지) = 요청 7번 */
function makeData() {
  const year = (y: number, n: number): ReturnType<typeof ord>[] =>
    Array.from({ length: n }, (_, i) => {
      const no = y * 1e10 + (n - i)
      const month = String(((n - i - 1) % 12) + 1).padStart(2, '0')
      const base: unknown[] = [grp('FINAL_DELIVERY', [it(y * 100 + i, `${y}년 상품 ${n - i}, 1개`, { quantity: (i % 3) + 1, discountedUnitPrice: 1000 + i * 10 })])]
      if (i === 1) base.push(grp('FINAL_DELIVERY', [it(y * 100 + i, `${y}년 상품 ${n - i}, 1개`, { quantity: (i % 3) + 1, discountedUnitPrice: 1000 + i * 10 })])) // 같은 상품 두 줄
      if (i === 2) base[0] = grp('INSTRUCT', [it(y * 100 + i, `${y}년 취소 상품`, { cancelReturnStatus: 'CANCELED' })])
      if (i === 3) base[0] = grp('FINAL_DELIVERY', [it(y * 100 + i, `${y}년 반품 상품`, { cancelReturnStatus: 'RETURN_COMPLETE' })])
      return ord(no, `${y}-${month}-15T12:00:00`, base)
    })
  return { 2026: year(2026, 12), 2025: year(2025, 12), 2024: year(2024, 5) } as Record<number, ReturnType<typeof ord>[]>
}
const countRows = (d: Record<number, ReturnType<typeof ord>[]>) =>
  Object.values(d).flat().reduce((n, o) => n + o.deliveryGroupList.reduce((m: number, g) => m + (g as { productList: unknown[] }).productList.length, 0), 0)

interface Mock {
  calls: { y: number; p: number; t: number }[]
  /** 이 번호(1부터)의 요청에 429 를 준다. 0이면 주지 않는다 */
  failAt: number
  data: Record<number, ReturnType<typeof ord>[]>
  hits: number
}

async function mockCoupang(context: BrowserContext): Promise<Mock> {
  const mock: Mock = { calls: [], failAt: 0, data: makeData(), hits: 0 }
  const years = Object.keys(mock.data).map(Number).sort().reverse()
  await context.route('https://mc.coupang.com/**', (route: Route) => {
    const u = route.request().url()
    if (u.includes('/ssr/api/myorders/model')) {
      mock.hits++
      if (mock.failAt && mock.hits === mock.failAt) return route.fulfill({ status: 429, body: 'slow down' })
      const q = new URL(u).searchParams
      const y = +q.get('requestYear')!, p = +q.get('pageIndex')!, size = +q.get('size')!
      mock.calls.push({ y, p, t: Date.now() })
      const list = mock.data[y] ?? []
      const last = (p + 1) * size >= list.length
      const body = { pageIndex: p, size, orderList: list.slice(p * size, (p + 1) * size), orderItemTotalCount: 0, hasNext: !last || !!mock.data[y - 1], nextYear: last ? y - 1 : y, nextPageIndex: last ? 0 : p + 1, partial: false }
      // 19자리 묶음배송번호가 숫자 그대로 오는 실제 응답처럼, 원문 텍스트에서 숫자로 바꿔 준다(JS 숫자로는 표현이 깨진다)
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body).replaceAll('"__BOX__"', '1108798707190464512') })
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><meta charset=utf-8><title>주문목록</title><div>최근 6개월</div>${years.map((y) => `<div class="sc-x">${y}</div>`).join('')}` })
  })
  return mock
}

type Sw = Awaited<ReturnType<typeof swOf>>
const storage = (sw: Sw) => sw.evaluate(async () => await chrome.storage.local.get(null))
const orders = async (sw: Sw) => ((await storage(sw)).orders ?? []) as OrderRow[]
const collectState = async (sw: Sw) => ((await storage(sw)).collect ?? {}) as Record<string, any>
const keyOf = (r: OrderRow) => `${r.order_no}:${r.seq}`

async function openCoupang(context: BrowserContext): Promise<Page> {
  const p = await context.newPage()
  await p.goto('https://mc.coupang.com/ssr/desktop/order/list')
  return p
}
const popupUrl = (id: string) => `chrome-extension://${id}/app/popup.html`

test.describe.configure({ mode: 'serial' })

test.describe('확장 수집 (합성 쿠팡 응답)', () => {
  let mock: Mock, sw: Sw, coupang: Page
  const EXPECTED = countRows(makeData())

  test.beforeEach(async ({ page, context }) => {
    sw = await swOf(page)
    await sw.evaluate(async () => await chrome.storage.local.clear())
    mock = await mockCoupang(context)
    coupang = await openCoupang(context)
  })
  test.afterEach(async ({ context }) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' })
    await coupang.close()
  })

  const extId = () => process.env.E2E_EXT_ID!
  const waitStatus = (status: string, timeout = 90000) => expect.poll(async () => (await collectState(sw)).status, { timeout, intervals: [500] }).toBe(status)
  const expectNoDuplicates = async () => {
    const rows = await orders(sw)
    expect(new Set(rows.map(keyOf)).size).toBe(rows.length)
    return rows
  }

  test('팝업으로 수집하면 연도 순서로 가져와 저장하고, 대시보드에 반영된다', async ({ context }) => {
    const popup = await context.newPage()
    await popup.goto(popupUrl(extId()))
    await expect(popup.locator('#status')).toHaveText('대기 중')
    await popup.locator('#collect').click()
    await expect(popup.locator('#status')).toContainText('이번에')
    await waitStatus('done')
    await expect(popup.locator('#status')).toHaveText('완료. 2026:13 2025:13 2024:6') // 최신 연도부터, 같은 상품 두 줄 포함

    expect(mock.calls.map((c) => `${c.y}/${c.p}`)).toEqual(['2026/0', '2026/1', '2026/2', '2025/0', '2025/1', '2025/2', '2024/0'])
    const gaps = mock.calls.slice(1).map((c, i) => c.t - mock.calls[i].t)
    expect(Math.min(...gaps), `요청 간격: ${gaps}`).toBeGreaterThanOrEqual(2000)

    const rows = await expectNoDuplicates()
    expect(rows.length).toBe(EXPECTED)
    const st = await collectState(sw)
    expect(st.checkpoint).toBeNull()
    expect(Object.values(st.perYear as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(EXPECTED)
    // 웹앱 OrderRow 모양: 묶음배송번호 19자리 그대로, 판매자, 정가
    expect(rows[0]).toMatchObject({ bundle_no: '1108798707190464512', seller: '쿠팡(주)', list_price: 1000 })
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['배송완료', '취소완료', '반품완료']))

    const dash = await context.newPage()
    await dash.goto(`chrome-extension://${extId()}/app/extension.html`)
    await expect(dash.getByTestId('kpi-total')).toContainText('원')
    await expect(dash.getByTestId('header-sub')).toContainText('이 브라우저에만 저장')
    await expect(dash.getByTestId('collect-status')).toContainText('완료')
    await expectNoSeriousA11y(dash, '확장 대시보드(수집 후)')
    await dash.close()
    await popup.close()
  })

  test('수집 중 팝업을 닫았다 다시 열어도 수집은 계속되고, 진행이 보이고, 새로 시작되지 않는다', async ({ context }) => {
    let popup = await context.newPage()
    await popup.goto(popupUrl(extId()))
    await popup.locator('#collect').click()
    await expect.poll(async () => (await orders(sw)).length, { timeout: 20000 }).toBeGreaterThan(0) // 첫 페이지가 저장됨
    await popup.close() // 팝업을 닫는다
    const before = mock.calls.length

    popup = await context.newPage()
    await popup.goto(popupUrl(extId())) // 다시 연다
    await expect(popup.locator('#status')).toContainText('이번에') // 진행 상황이 이어서 보인다
    await expect(popup.locator('#status')).toHaveAttribute('data-status', 'running')
    await expect(popup.locator('#abort')).toBeVisible()
    await expect(popup.locator('#collect')).toBeHidden() // 시작 버튼은 없다
    // 그래도 시작 요청이 오면(다른 창에서 누르는 경우 등) 거절한다
    const res = await popup.evaluate(async () => await chrome.runtime.sendMessage({ type: 'START_COLLECT', mode: 'fresh' }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('이미 수집 중')

    await waitStatus('done')
    expect(mock.calls.length, '요청 수가 한 번 수집한 만큼(7번)이어야 한다. 겹쳐 수집하면 더 많다').toBe(7)
    expect(mock.calls.length).toBeGreaterThan(before - 1)
    const rows = await expectNoDuplicates()
    expect(rows.length).toBe(EXPECTED)
    await popup.close()
  })

  test('중단하고 이어서 수집하면 저장한 곳부터 이어 가고 중복이 없다', async ({ context }) => {
    const dash = await context.newPage()
    await dash.goto(`chrome-extension://${extId()}/app/extension.html`)
    await dash.getByTestId('collect-start').click()
    // 2026년 3페이지를 저장하고 2025년으로 넘어간 뒤에 중단한다(이어서 할 때 일부만 다시 하는지 보려고)
    await expect.poll(async () => ((await collectState(sw)).checkpoint as { year: string } | null)?.year, { timeout: 40000 }).toBe('2025')
    await expect(dash.getByTestId('collect-status')).toHaveAttribute('data-status', 'running')
    await dash.getByTestId('collect-abort').click()
    await waitStatus('aborted')

    const partial = (await orders(sw)).length
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(EXPECTED)
    const cp = (await collectState(sw)).checkpoint as { year: string; page: number }
    expect(cp).toBeTruthy()
    await expect(dash.getByTestId('collect-resume')).toBeVisible()
    await expect(dash.getByTestId('collect-status')).toContainText('까지 저장됨')

    const callsBefore = mock.calls.length
    await dash.getByTestId('collect-resume').click()
    await waitStatus('done')
    const resumed = mock.calls.slice(callsBefore)
    expect(`${resumed[0].y}/${resumed[0].p}`, '저장한 마지막 페이지부터 다시 시작(처음부터가 아님)').toBe(`${cp.year}/${cp.page}`)
    expect(resumed.length, '이미 저장한 2026년은 다시 가져오지 않는다').toBeLessThanOrEqual(4)
    expect(resumed.some((c) => c.y === 2026)).toBe(false)
    const rows = await expectNoDuplicates()
    expect(rows.length).toBe(EXPECTED)
    await dash.close()
  })

  test('오류가 나면 저장한 것은 남고, 이어서 수집으로 마무리한다', async ({ context }) => {
    mock.failAt = 3 // 세 번째 요청이 429
    const popup = await context.newPage()
    await popup.goto(popupUrl(extId()))
    await popup.locator('#collect').click()
    await waitStatus('error')
    expect(mock.hits).toBe(3) // 재시도 없음
    const partial = (await orders(sw)).length
    expect(partial).toBeGreaterThan(0)
    await expect(popup.locator('#status')).toContainText('HTTP_429')
    await expect(popup.locator('#resume')).toBeVisible()

    mock.failAt = 0
    await popup.locator('#resume').click()
    await waitStatus('done')
    const rows = await expectNoDuplicates()
    expect(rows.length).toBe(EXPECTED)
    await popup.close()
  })

  test('수집 중 쿠팡 탭을 닫으면 끊긴 것으로 보이고, 새 탭에서 이어서 수집할 수 있다', async ({ context }) => {
    const popup = await context.newPage()
    await popup.goto(popupUrl(extId()))
    await popup.locator('#collect').click()
    await expect.poll(async () => (await orders(sw)).length, { timeout: 20000 }).toBeGreaterThan(0)
    await coupang.close() // 탭을 닫는다. 갱신이 끊기고 30초 뒤 중단된 것으로 본다
    await expect(popup.locator('#status')).toContainText('중단됨', { timeout: 60000 })
    await expect(popup.locator('#resume')).toBeVisible()
    expect((await orders(sw)).length).toBeLessThan(EXPECTED)

    coupang = await openCoupang(context)
    await popup.locator('#resume').click()
    await waitStatus('done')
    const rows = await expectNoDuplicates()
    expect(rows.length).toBe(EXPECTED)
    await popup.close()
  })

  test('CSV로 올린 주문과 겹쳐도 같은 주문은 교체되어 늘어나지 않고, 수집을 두 번 해도 그대로다', async ({ context }) => {
    // 같은 주문번호를 CSV(옛 방식)로 먼저 넣어 둔다
    const first = makeData()[2026][0]
    const page0 = await context.newPage()
    await page0.goto(popupUrl(extId()))
    await page0.evaluate(async (no) => {
      await chrome.runtime.sendMessage({
        type: 'IMPORT_ORDERS', meta: { file_name: 'old.csv', file_sha256: 'x' },
        rows: [{ order_no: no, seq: 0, ordered_at: '2026-12-15 12:00:00', bundle_no: null, product_no: '1', status: '배송완료', raw_name: '옛 이름', qty: 1, list_price: null, sale_price: 1, seller: null }],
      })
    }, String(first.orderId))
    await page0.close()
    expect((await orders(sw)).length).toBe(1)

    const popup = await context.newPage()
    await popup.goto(popupUrl(extId()))
    for (let i = 0; i < 2; i++) {
      await popup.locator('#collect').click()
      await expect.poll(async () => (await collectState(sw)).status, { timeout: 5000 }).toBe('running')
      await waitStatus('done')
      const rows = await expectNoDuplicates()
      expect(rows.length).toBe(EXPECTED)
      expect(rows.find((r) => r.order_no === String(first.orderId))!.raw_name).not.toBe('옛 이름')
      mock.calls.length = 0
    }
    await popup.close()
  })

  test('콘텐츠 스크립트가 같은 탭에 또 들어와도 수집은 한 번만 돈다', async ({ context }) => {
    // background 는 스크립트가 없는 탭(확장 설치 전에 열린 탭)에 스크립트를 다시 넣는다. 이미 있는 탭에 또 넣어도 겹치지 않아야 한다
    await sw.evaluate(async () => {
      const [t] = await chrome.tabs.query({ url: '*://mc.coupang.com/*' })
      for (let i = 0; i < 2; i++) await chrome.scripting.executeScript({ target: { tabId: t.id! }, files: ['content/collector.js'] })
    })
    const popup = await context.newPage()
    await popup.goto(popupUrl(extId()))
    await popup.locator('#collect').click()
    await waitStatus('done')
    expect(mock.calls.length, '수집이 겹치면 요청이 7번보다 많다').toBe(7)
    const rows = await expectNoDuplicates()
    expect(rows.length).toBe(EXPECTED)
    await popup.close()
  })

  test('첫 버전이 저장한 옛 모양의 행은 새 모양으로 바뀌어 대시보드에 보인다', async ({ context }) => {
    await sw.evaluate(async () => {
      await chrome.storage.local.set({ orders: [
        { order_no: '9001', dt: '2025-03-01 10:00:00', product_no: 'p1', status: '배송완료', raw_name: '옛 상품 A, 1개', qty: 2, price: 500, src: 'collect' },
        { order_no: '9001', dt: '2025-03-01 10:00:00', product_no: 'p2', status: '배송완료', raw_name: '옛 상품 B, 1개', qty: 1, price: 700, src: 'collect' }] })
    })
    const page = await context.newPage()
    await page.goto(popupUrl(extId()))
    // 아무 저장 요청이 오면 background 가 먼저 옛 행을 바꾼다
    await page.evaluate(async () => await chrome.runtime.sendMessage({ type: 'ORDERS_SHIPPING', updates: [] }))
    const rows = await orders(sw)
    expect(rows.map((r) => [r.order_no, r.seq, r.ordered_at, r.sale_price])).toEqual([['9001', 0, '2025-03-01 10:00:00', 500], ['9001', 1, '2025-03-01 10:00:00', 700]])
    await page.goto(`chrome-extension://${extId()}/app/extension.html`)
    await expect(page.getByTestId('kpi-total')).toContainText('1,700') // 500x2 + 700
    await page.close()
  })
})
