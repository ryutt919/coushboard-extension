import type { SettingsBundle, StoredData } from './stored'
import type { OrderRow, ReceiptRow, RulesConfig } from './types'

/** 저장소 추상화. 구현은 ChromeBackend(chrome.storage.local) */
export interface Backend {
  /** 배송비를 저장할 수 있는지. 아니면 배송비는 저장하지 않고 안내한다 */
  supportsShipping: boolean
  load(): Promise<StoredData>
  setRowOverride(key: string, category: string | null): Promise<void>
  setGroupOverride(base: string, category: string | null): Promise<void>
  saveRules(rules: RulesConfig): Promise<void>
  setMerge(fromBase: string, toGroup: string | null): Promise<void>
  setDedupe(key: string, action: 'keep' | 'drop' | null): Promise<void>
  /** 설정 전체를 교체(가져오기, 초기화) */
  replaceSettings(bundle: SettingsBundle): Promise<void>
  importOrders(meta: { file_name: string; file_sha256: string }, rows: OrderRow[]): Promise<void>
  /** 이미 저장된 주문의 배송비를 주문 단위로 정한다(그 주문의 첫 행에 담고 나머지 행은 비운다) */
  setOrderShipping(updates: { order_no: string; fee: number }[]): Promise<void>
  importReceipts(meta: { file_name: string; file_sha256: string }, rows: ReceiptRow[]): Promise<void>
  deleteAll(): Promise<void>
  exportAll(): Promise<Record<string, unknown>>
}

export class DuplicateFileError extends Error {
  constructor() {
    super('이미 올린 파일입니다.')
    this.name = 'DuplicateFileError'
  }
}
