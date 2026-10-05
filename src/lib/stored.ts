import defaultRules from '../data/category-rules.json'
import extraRules from '../data/category-rules-extra.json'
import defaultMerges from '../data/product-merges.json'
import { EMPTY_OVERRIDES } from './pipeline'
import type { OrderRow, Overrides, ReceiptRow, RulesConfig, Settings } from './types'

/** handoff 기본 규칙(oracle과 테스트의 기준). 건드리지 않는다 */
export const DEFAULT_RULES = defaultRules as RulesConfig
export const EXTRAS_VERSION: number = extraRules.version
const EXTRA_CATEGORIES = extraRules.categories as { name: string; keywords: string[] }[]

/**
 * 확장 키워드를 같은 이름의 카테고리 뒤에 이어 붙인다(이미 있는 것은 건너뜀).
 * 사용자가 지운 카테고리는 되살리지 않는다. 결과에는 extrasVersion 이 찍혀, 이후 사용자가 지운 키워드가 되살아나지 않는다.
 */
export function withExtras(rules: RulesConfig): RulesConfig {
  return {
    ...rules,
    extrasVersion: EXTRAS_VERSION,
    categories: rules.categories.map((c) => {
      const extra = EXTRA_CATEGORIES.find((e) => e.name === c.name)
      if (!extra) return c
      const have = new Set(c.keywords)
      return { ...c, keywords: [...c.keywords, ...extra.keywords.filter((k) => !have.has(k))] }
    }),
  }
}

/** 앱의 기본 규칙: handoff 규칙 + 확장 키워드 */
export const DEFAULT_RULES_EXTENDED = withExtras(DEFAULT_RULES)

export function effectiveRules(stored: RulesConfig | null): RulesConfig {
  if (!stored) return DEFAULT_RULES_EXTENDED
  return (stored.extrasVersion ?? 0) < EXTRAS_VERSION ? withExtras(stored) : stored
}
export const DEFAULT_MERGES = defaultMerges as Record<string, string>

export interface ImportMeta {
  id: string
  kind: 'orders' | 'receipts'
  file_name: string
  file_sha256: string
  row_count: number
  created_at: string
}

/** 저장소(chrome.storage.local)에 있는 그대로의 상태 */
export interface StoredData {
  imports: ImportMeta[]
  orders: OrderRow[]
  receipts: ReceiptRow[]
  rules: RulesConfig | null // null이면 기본 규칙
  overrides: Overrides
  merges: Record<string, string> // 사용자가 만든 병합만(기본 병합 제외)
  dedupe: Record<string, 'keep' | 'drop'>
}

export const emptyStored = (): StoredData => ({
  imports: [],
  orders: [],
  receipts: [],
  rules: null,
  overrides: { row: {}, group: {} },
  merges: {},
  dedupe: {},
})

export function effectiveSettings(s: StoredData): Settings {
  return {
    rules: effectiveRules(s.rules),
    merges: { ...DEFAULT_MERGES, ...s.merges },
    overrides: s.overrides ?? EMPTY_OVERRIDES,
    dedupe: s.dedupe,
  }
}

/** 새 주문 행으로 교체: 새 파일에 있는 주문번호의 기존 행을 지우고 넣는다(replace_orders와 같은 규칙) */
export function applyReplaceOrders(orders: OrderRow[], rows: OrderRow[]): OrderRow[] {
  const incoming = new Set(rows.map((r) => r.order_no))
  return [...orders.filter((o) => !incoming.has(o.order_no)), ...rows]
}

export function applyReceipts(receipts: ReceiptRow[], rows: ReceiptRow[]): ReceiptRow[] {
  const keys = new Set(rows.map((r) => r.receipt_key))
  return [...receipts.filter((r) => !keys.has(r.receipt_key)), ...rows]
}

export function setRecord<T>(rec: Record<string, T>, key: string, value: T | null): Record<string, T> {
  const next = { ...rec }
  if (value === null) delete next[key]
  else next[key] = value
  return next
}

/** 규칙과 지정 내역 백업 파일 형식 */
export interface SettingsBundle {
  kind: 'coushboard-settings'
  version: 1
  rules: RulesConfig | null
  overrides: Overrides
  merges: Record<string, string>
  dedupe: Record<string, 'keep' | 'drop'>
}

export function toBundle(s: StoredData): SettingsBundle {
  return { kind: 'coushboard-settings', version: 1, rules: s.rules, overrides: s.overrides, merges: s.merges, dedupe: s.dedupe }
}

export function parseBundle(text: string): SettingsBundle {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error('JSON 형식이 아닙니다.')
  }
  const b = j as Partial<SettingsBundle>
  if (!b || b.kind !== 'coushboard-settings' || b.version !== 1) throw new Error('이 앱에서 내보낸 설정 파일이 아닙니다.')
  const isRec = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x)
  if (!b.overrides || !isRec(b.overrides.row) || !isRec(b.overrides.group) || !isRec(b.merges) || !isRec(b.dedupe)) {
    throw new Error('설정 파일 구조가 올바르지 않습니다.')
  }
  if (b.rules !== null && b.rules !== undefined) {
    if (!Array.isArray(b.rules.categories) || typeof b.rules.fallback !== 'string') throw new Error('규칙 구조가 올바르지 않습니다.')
    for (const c of b.rules.categories) {
      if (typeof c.name !== 'string' || !Array.isArray(c.keywords)) throw new Error('규칙 구조가 올바르지 않습니다.')
      for (const k of c.keywords) new RegExp(k) // 잘못된 정규식이면 여기서 예외
    }
  }
  return b as SettingsBundle
}
