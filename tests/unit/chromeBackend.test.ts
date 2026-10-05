import { beforeEach, describe, expect, it } from 'vitest'
import { DuplicateFileError } from '../../src/lib/backend'
import { ChromeBackend } from '../../src/lib/chromeBackend'
import { COLLECT_KEY, effectiveState, IDLE_STATE, progressText, STALE_MS } from '../../src/extension/collectState'
import type { OrderRow } from '../../src/lib/types'

// chrome.storage.local 과 chrome.runtime.sendMessage 를 흉내 낸 가짜. 실제 확장 환경은 tests/e2e-ext 에서 본다.
function installChrome(handler: (m: any) => unknown = () => ({ ok: true })) {
  const store: Record<string, unknown> = {}
  const sent: any[] = []
  ;(globalThis as any).chrome = {
    storage: {
      local: {
        get: async (keys?: string | string[] | null) => {
          const ks = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys]
          return Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]))
        },
        set: async (items: Record<string, unknown>) => {
          // 쓰기에 시간이 걸려도 호출이 차례로 처리되는지 보려고 한 틱 늦춘다
          await new Promise((r) => setTimeout(r, 1))
          Object.assign(store, structuredClone(items))
        },
        remove: async () => undefined,
        clear: async () => undefined,
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    runtime: { sendMessage: async (m: unknown) => (sent.push(m), handler(m)) },
  }
  return { store, sent }
}

const row = (o: Partial<OrderRow> = {}): OrderRow => ({
  order_no: '1', seq: 0, ordered_at: '2026-01-01 00:00:00', bundle_no: null, product_no: 'p', status: '배송완료', raw_name: 'x', qty: 1, list_price: null, sale_price: 100, seller: null, ...o,
})

describe('ChromeBackend', () => {
  let env: ReturnType<typeof installChrome>
  beforeEach(() => {
    env = installChrome()
  })

  it('빈 저장소에서도 빈 상태를 읽는다', async () => {
    const s = await new ChromeBackend().load()
    expect(s.orders).toEqual([])
    expect(s.rules).toBeNull()
    expect(s.overrides).toEqual({ row: {}, group: {} })
  })

  it('첫 버전이 남긴 옛 모양의 행은 읽지 않는다(background 가 새 모양으로 바꾼 뒤에만 보인다)', async () => {
    env.store.orders = [{ order_no: '9', dt: '2025-01-01 00:00:00', price: 1 }, row({ order_no: '2' })]
    const s = await new ChromeBackend().load()
    expect(s.orders.map((o) => o.order_no)).toEqual(['2'])
  })

  it('설정 변경은 겹쳐 호출해도 서로를 덮어쓰지 않는다', async () => {
    const b = new ChromeBackend()
    await Promise.all([b.setRowOverride('1:0', '식품'), b.setGroupOverride('상품A', '생활용품'), b.setMerge('a', 'b'), b.setDedupe('1:1', 'keep')])
    const s = await b.load()
    expect(s.overrides.row).toEqual({ '1:0': '식품' })
    expect(s.overrides.group).toEqual({ 상품A: '생활용품' })
    expect(s.merges).toEqual({ a: 'b' })
    expect(s.dedupe).toEqual({ '1:1': 'keep' })
    await b.setRowOverride('1:0', null) // null 이면 지정을 지운다
    expect((await b.load()).overrides.row).toEqual({})
  })

  it('주문, 영수증 저장은 background 로 보내고, 같은 파일이면 DuplicateFileError 를 던진다', async () => {
    const b = new ChromeBackend()
    await b.importOrders({ file_name: 'a.csv', file_sha256: 'h' }, [row()])
    expect(env.sent[0]).toMatchObject({ type: 'IMPORT_ORDERS', meta: { file_sha256: 'h' } })
    await b.setOrderShipping([{ order_no: '1', fee: 3000 }])
    expect(env.sent[1]).toMatchObject({ type: 'ORDERS_SHIPPING' })
    await b.deleteAll()
    expect(env.sent[2]).toEqual({ type: 'DELETE_ALL' })

    installChrome(() => ({ ok: false, duplicate: true }))
    await expect(new ChromeBackend().importOrders({ file_name: 'a.csv', file_sha256: 'h' }, [])).rejects.toBeInstanceOf(DuplicateFileError)
    installChrome(() => ({ ok: false, error: '저장소가 가득 찼습니다' }))
    await expect(new ChromeBackend().importReceipts({ file_name: 'r.csv', file_sha256: 'r' }, [])).rejects.toThrow('저장소가 가득')
    installChrome(() => undefined)
    await expect(new ChromeBackend().deleteAll()).rejects.toThrow('응답이 없습니다')
  })
})

describe('수집 상태', () => {
  it('갱신이 끊긴 running 은 중단됨으로 보고, 최근에 갱신된 것은 그대로 둔다', () => {
    const now = 1_000_000
    const running = { ...IDLE_STATE, status: 'running' as const, updatedAt: now - 5_000, checkpoint: { year: '2025', page: 2 } }
    expect(effectiveState(running, now).status).toBe('running')
    const stale = effectiveState({ ...running, updatedAt: now - STALE_MS - 1 }, now)
    expect(stale.status).toBe('aborted')
    expect(stale.checkpoint).toEqual({ year: '2025', page: 2 }) // 이어서 수집할 위치는 남는다
    expect(effectiveState(undefined, now)).toEqual(IDLE_STATE)
  })

  it('진행 문구: 페이지는 1부터, 완료는 최신 연도부터', () => {
    expect(progressText({ ...IDLE_STATE, status: 'running', year: '2025', yearIndex: 2, years: ['2026', '2025'], page: 0, rows: 7 })).toBe('2025년 (2/2) 1페이지 · 이번에 7행 저장')
    expect(progressText({ ...IDLE_STATE, status: 'done', perYear: { 2024: 6, 2026: 13, 2025: 13 } })).toBe('완료. 2026:13 2025:13 2024:6')
    expect(progressText({ ...IDLE_STATE, status: 'aborted', checkpoint: { year: '2025', page: 1 } })).toBe('중단됨. 2025년 2페이지까지 저장됨')
    expect(COLLECT_KEY).toBe('collect')
  })
})
