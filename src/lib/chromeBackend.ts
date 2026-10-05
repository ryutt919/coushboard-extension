import { type Backend, DuplicateFileError } from './backend'
import type { SettingsBundle, StoredData } from './stored'
import { emptyStored, setRecord } from './stored'
import type { OrderRow, ReceiptRow, RulesConfig } from './types'

/**
 * 확장 저장소: chrome.storage.local. 서버로는 아무것도 보내지 않는다.
 * 키: orders, receipts, imports, settings(규칙, 지정, 합치기, 중복 처리).
 * 주문, 영수증, 가져오기 이력은 수집 중인 콘텐츠 스크립트와 겹쳐 쓰지 않도록 background 의 한 줄 대기열(background.js)을 거쳐 바꾼다.
 * 설정은 대시보드만 쓰므로 여기서 직접 읽고 쓴다(요청마다 차례로).
 */
export const STORAGE_KEYS = ['orders', 'receipts', 'imports', 'settings'] as const

interface SettingsDoc {
  rules: RulesConfig | null
  overrides: StoredData['overrides']
  merges: Record<string, string>
  dedupe: StoredData['dedupe']
}

const emptySettings = (): SettingsDoc => ({ rules: null, overrides: { row: {}, group: {} }, merges: {}, dedupe: {} })

const isOrderRow = (r: unknown): r is OrderRow =>
  typeof r === 'object' && r !== null && 'ordered_at' in r && 'sale_price' in r && 'order_no' in r

async function send(message: Record<string, unknown>): Promise<{ ok: boolean; duplicate?: boolean; error?: string }> {
  const res = await chrome.runtime.sendMessage(message)
  if (!res) throw new Error('확장 백그라운드에서 응답이 없습니다. 확장을 새로 고쳐 주세요.')
  if (res.duplicate) throw new DuplicateFileError()
  if (!res.ok) throw new Error(res.error ?? '저장에 실패했습니다.')
  return res
}

export class ChromeBackend implements Backend {
  supportsShipping = true
  private chain: Promise<unknown> = Promise.resolve()

  async load(): Promise<StoredData> {
    const d = await chrome.storage.local.get([...STORAGE_KEYS])
    const s = emptyStored()
    s.orders = ((d.orders ?? []) as unknown[]).filter(isOrderRow)
    s.receipts = (d.receipts ?? []) as ReceiptRow[]
    s.imports = d.imports ?? []
    const st: SettingsDoc = { ...emptySettings(), ...(d.settings ?? {}) }
    s.rules = st.rules
    s.overrides = st.overrides
    s.merges = st.merges
    s.dedupe = st.dedupe
    return s
  }

  /** 설정 문서를 읽고 고쳐 쓴다. 호출이 겹쳐도 차례로 처리한다 */
  private update(fn: (s: SettingsDoc) => SettingsDoc): Promise<void> {
    const run = async () => {
      const d = await chrome.storage.local.get('settings')
      const cur: SettingsDoc = { ...emptySettings(), ...(d.settings ?? {}) }
      await chrome.storage.local.set({ settings: fn(cur) })
    }
    const p = this.chain.then(run, run)
    this.chain = p.catch(() => undefined)
    return p
  }

  setRowOverride(key: string, category: string | null) {
    return this.update((s) => ({ ...s, overrides: { ...s.overrides, row: setRecord(s.overrides.row, key, category) } }))
  }
  setGroupOverride(base: string, category: string | null) {
    return this.update((s) => ({ ...s, overrides: { ...s.overrides, group: setRecord(s.overrides.group, base, category) } }))
  }
  saveRules(rules: RulesConfig) {
    return this.update((s) => ({ ...s, rules }))
  }
  setMerge(fromBase: string, toGroup: string | null) {
    return this.update((s) => ({ ...s, merges: setRecord(s.merges, fromBase, toGroup) }))
  }
  setDedupe(key: string, action: 'keep' | 'drop' | null) {
    return this.update((s) => ({ ...s, dedupe: setRecord(s.dedupe, key, action) }))
  }
  replaceSettings(b: SettingsBundle) {
    return this.update(() => ({ rules: b.rules ?? null, overrides: b.overrides, merges: b.merges, dedupe: b.dedupe }))
  }
  async importOrders(meta: { file_name: string; file_sha256: string }, rows: OrderRow[]) {
    await send({ type: 'IMPORT_ORDERS', meta, rows })
  }
  async importReceipts(meta: { file_name: string; file_sha256: string }, rows: ReceiptRow[]) {
    await send({ type: 'IMPORT_RECEIPTS', meta, rows })
  }
  async setOrderShipping(updates: { order_no: string; fee: number }[]) {
    await send({ type: 'ORDERS_SHIPPING', updates })
  }
  async deleteAll() {
    await send({ type: 'DELETE_ALL' })
  }
  async exportAll() {
    return { ...(await this.load()) }
  }
}
