import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Backend } from '../lib/backend'
import { ChromeBackend, STORAGE_KEYS } from '../lib/chromeBackend'
import { dataRange, prepareRows, type Prepared } from '../lib/pipeline'
import {
  type SettingsBundle,
  type StoredData,
  effectiveSettings,
  emptyStored,
  setRecord,
} from '../lib/stored'
import type { OrderRow, ReceiptRow, RulesConfig, Settings } from '../lib/types'

export interface Toast {
  text: string
  err?: boolean
}

interface Ctx {
  loading: boolean
  loadError: string | null
  /** DB에 배송비 컬럼이 있어 배송비를 저장할 수 있는지 */
  supportsShipping: boolean
  stored: StoredData
  settings: Settings
  prep: Prepared
  range: { start: string; end: string }
  hasData: boolean
  toast: Toast | null
  notify: (text: string, err?: boolean) => void
  reload: () => Promise<void>
  setRowOverride: (key: string, category: string | null) => Promise<void>
  setGroupOverride: (base: string, category: string | null) => Promise<void>
  /** 여러 행을 한 번에 지정(되돌리기용) */
  setRowOverrides: (keys: string[], category: string | null) => Promise<void>
  saveRules: (rules: RulesConfig) => Promise<void>
  setMerge: (from: string, to: string | null) => Promise<void>
  setDedupe: (key: string, action: 'keep' | 'drop' | null) => Promise<void>
  replaceSettings: (b: SettingsBundle) => Promise<void>
  importOrders: (meta: { file_name: string; file_sha256: string }, rows: OrderRow[]) => Promise<void>
  importReceipts: (meta: { file_name: string; file_sha256: string }, rows: ReceiptRow[]) => Promise<void>
  setOrderShipping: (updates: { order_no: string; fee: number }[]) => Promise<void>
  deleteAll: () => Promise<void>
  exportAll: () => Promise<Record<string, unknown>>
}

const AppCtx = createContext<Ctx | null>(null)

export function useApp(): Ctx {
  const c = useContext(AppCtx)
  if (!c) throw new Error('AppProvider 밖에서 useApp을 쓸 수 없습니다')
  return c
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<StoredData>(emptyStored)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [supportsShipping, setSupportsShipping] = useState(true)
  const [toast, setToast] = useState<Toast | null>(null)
  const backend = useRef<Backend | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const notify = useCallback((text: string, err?: boolean) => {
    setToast({ text, err })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), err ? 6000 : 3000)
  }, [])

  const load = useCallback(async (quiet = false) => {
    const b = backend.current
    if (!b) return
    if (!quiet) setLoading(true)
    setLoadError(null)
    try {
      setStored(await b.load())
      setSupportsShipping(b.supportsShipping)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '데이터를 읽지 못했습니다.')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  // 확장: 저장소를 바로 열고, 수집이나 다른 탭에서 저장이 바뀌면 화면을 조용히 다시 읽는다
  useEffect(() => {
    backend.current = new ChromeBackend()
    void load()
    let timer: number | undefined
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area !== 'local' || !STORAGE_KEYS.some((k) => k in changes)) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void load(true), 400)
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => {
      window.clearTimeout(timer)
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [load])

  const settings = useMemo(() => effectiveSettings(stored), [stored])
  const prep = useMemo(
    () => prepareRows(stored.orders, stored.receipts.length ? stored.receipts : null, settings),
    [stored.orders, stored.receipts, settings],
  )
  const range = useMemo(() => dataRange(prep.kept), [prep.kept])

  const run = useCallback(
    async (fn: (b: Backend) => Promise<void>, local: (s: StoredData) => StoredData) => {
      const b = backend.current
      if (!b) throw new Error('저장소가 아직 준비되지 않았습니다.')
      try {
        await fn(b)
      } catch (e) {
        notify(e instanceof Error ? e.message : '저장에 실패했습니다.', true)
        throw e
      }
      setStored(local)
    },
    [notify],
  )

  const value: Ctx = {
    loading,
    loadError,
    supportsShipping,
    stored,
    settings,
    prep,
    range,
    hasData: prep.kept.length > 0,
    toast,
    notify,
    reload: () => load(),
    setRowOverride: (key, category) =>
      run((b) => b.setRowOverride(key, category), (s) => ({ ...s, overrides: { ...s.overrides, row: setRecord(s.overrides.row, key, category) } })),
    setGroupOverride: (base, category) =>
      run((b) => b.setGroupOverride(base, category), (s) => ({ ...s, overrides: { ...s.overrides, group: setRecord(s.overrides.group, base, category) } })),
    setRowOverrides: async (keys, category) => {
      const b = backend.current
      if (!b) return
      try {
        for (const k of keys) await b.setRowOverride(k, category)
      } catch (e) {
        notify(e instanceof Error ? e.message : '저장에 실패했습니다.', true)
        throw e
      }
      setStored((s) => {
        let row = s.overrides.row
        for (const k of keys) row = setRecord(row, k, category)
        return { ...s, overrides: { ...s.overrides, row } }
      })
    },
    saveRules: (rules) => run((b) => b.saveRules(rules), (s) => ({ ...s, rules })),
    setMerge: (from, to) => run((b) => b.setMerge(from, to), (s) => ({ ...s, merges: setRecord(s.merges, from, to) })),
    setDedupe: (key, action) => run((b) => b.setDedupe(key, action), (s) => ({ ...s, dedupe: setRecord(s.dedupe, key, action) })),
    replaceSettings: (bundle) =>
      run((b) => b.replaceSettings(bundle), (s) => ({ ...s, rules: bundle.rules ?? null, overrides: bundle.overrides, merges: bundle.merges, dedupe: bundle.dedupe })),
    importOrders: async (meta, rows) => {
      await backend.current!.importOrders(meta, rows)
      await load()
    },
    importReceipts: async (meta, rows) => {
      await backend.current!.importReceipts(meta, rows)
      await load()
    },
    setOrderShipping: async (updates) => {
      await backend.current!.setOrderShipping(updates)
      await load()
    },
    deleteAll: async () => {
      await backend.current!.deleteAll()
      setStored(emptyStored())
    },
    exportAll: () => backend.current!.exportAll(),
  }

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>
}
