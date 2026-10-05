import { useMemo, useState, type DragEvent } from 'react'
import { Layout } from '../components/Layout'
import { WarnIcon } from '../components/Common'
import { DuplicateFileError } from '../lib/backend'
import { coverage, yymm } from '../lib/coverage'
import {
  type ColumnMapping,
  type OrderColumn,
  type OrderFormat,
  type RowIssue,
  REQUIRED_ORDER_COLUMNS,
  parseOrdersCsv,
  parseReceiptsCsv,
  sha256Hex,
} from '../lib/csv'
import { type OverlapMode, planImport } from '../lib/importPlan'
import { dot } from '../lib/dates'
import { downloadText, fmt } from '../lib/format'
import { generateDemo, ordersToCsv } from '../lib/demo'
import { reconcile, summarize } from '../lib/pipeline'
import type { OrderRow, ReceiptRow } from '../lib/types'
import { STATUSES } from '../lib/types'
import { useApp } from '../state/AppState'

type Stage = 'idle' | 'parse' | 'save' | 'recalc' | 'done' | 'error'

interface Pending {
  fileName: string
  size: number
  sha: string
  kind: 'orders' | 'receipts'
  text: string
  headers: string[]
  missing: string[]
  mapping: ColumnMapping
  issues: RowIssue[]
  orders?: OrderRow[]
  receipts?: ReceiptRow[]
  totalRows: number
  format: OrderFormat
  notes: string[]
  unknownStatuses: string[]
  statusMap: Record<string, string>
  /** 이미 자세한 데이터가 있는 주문을 어떻게 할지(외부 주문 도구 형식만 의미가 있음) */
  mode: OverlapMode
}

interface UploadedEntry {
  name: string
  size: number
  kind: string
  rows: number
  skippedOrders: number
  newOrders: number
  replacedOrders: number
  shippingMerged: number
  format: OrderFormat
}

const STAGES: [Stage, string][] = [
  ['parse', '파싱'],
  ['save', '저장'],
  ['recalc', '다시 계산'],
]

export function Upload() {
  const app = useApp()
  const [over, setOver] = useState(false)
  const [stage, setStage] = useState<Stage>('idle')
  const [error, setError] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [uploaded, setUploaded] = useState<UploadedEntry[]>([])
  const [nothingNew, setNothingNew] = useState<{ name: string; skipped: number } | null>(null)

  async function handleFiles(files: FileList | File[]) {
    setError(null)
    setDuplicate(null)
    setNothingNew(null)
    for (const f of Array.from(files)) {
      await handleFile(f)
    }
  }

  async function handleFile(file: File) {
    setStage('parse')
    let buf: ArrayBuffer
    let text: string
    try {
      buf = await file.arrayBuffer()
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      setStage('error')
      setError("UTF-8 형식의 CSV만 읽을 수 있습니다. 엑셀에서 'CSV UTF-8(쉼표로 분리)'로 저장해 주세요.")
      return
    }
    const sha = await sha256Hex(buf)
    const firstLine = text.replace(/^\ufeff/, '').split(/\r?\n/, 1)[0] ?? ''
    const kind: 'orders' | 'receipts' = firstLine.includes('receipt_key') ? 'receipts' : 'orders'
    if (app.stored.imports.some((i) => i.kind === kind && i.file_sha256 === sha)) {
      setStage('idle')
      setDuplicate(file.name)
      return
    }
    const base = { fileName: file.name, size: file.size, sha, kind, text, statusMap: {}, mode: 'skip' as OverlapMode }
    if (kind === 'orders') {
      const p = parseOrdersCsv(text)
      const pend: Pending = { ...base, headers: p.headers, missing: p.missing, mapping: {}, issues: p.issues, orders: p.rows, totalRows: p.totalRows, format: p.format, notes: p.notes, unknownStatuses: p.unknownStatuses }
      setPending(pend)
      // 쿠팡 내보내기 형식이고 문제가 없으면 바로 올린다. 외부 도구 형식은 변환 안내와 겹침 처리를 확인한 뒤 올린다.
      if (!p.missing.length && !p.issues.length && !p.unknownStatuses.length && p.format === 'coupang-export') await save(pend)
      else setStage('idle')
    } else {
      const p = parseReceiptsCsv(text)
      const pend: Pending = { ...base, headers: p.headers, missing: p.missing, mapping: {}, issues: p.issues, receipts: p.rows, totalRows: p.rows.length + p.issues.length, format: 'coupang-export', notes: [], unknownStatuses: [] }
      setPending(pend)
      if (!p.missing.length && !p.issues.length) await save(pend)
      else setStage('idle')
    }
  }

  function remap(mapping: ColumnMapping, statusMap: Record<string, string> = pending?.statusMap ?? {}) {
    if (!pending) return
    const p = parseOrdersCsv(pending.text, mapping, statusMap)
    setPending({ ...pending, mapping, statusMap, missing: p.missing, issues: p.issues, orders: p.rows, totalRows: p.totalRows, format: p.format, notes: p.notes, unknownStatuses: p.unknownStatuses })
  }

  async function save(p: Pending) {
    setError(null)
    setStage('save')
    try {
      const meta = { file_name: p.fileName, file_sha256: p.sha }
      let entry: UploadedEntry
      if (p.kind === 'orders') {
        const plan = planImport(p.orders ?? [], app.stored.orders, p.format, p.mode)
        // DB에 배송비 컬럼이 없으면 배송비는 저장하지 못하므로 합치기를 건너뛴다(화면에 안내함)
        const shippingUpdates = app.supportsShipping ? plan.shippingUpdates : []
        if (plan.rows.length === 0 && shippingUpdates.length === 0) {
          // 올릴 새 주문도 합칠 배송비도 없으면 아무것도 저장하지 않는다(업로드 이력도 만들지 않는다)
          setNothingNew({ name: p.fileName, skipped: plan.skippedOrders })
          setPending(null)
          setStage('idle')
          return
        }
        if (plan.rows.length > 0) await app.importOrders(meta, plan.rows)
        if (shippingUpdates.length > 0) await app.setOrderShipping(shippingUpdates)
        entry = { name: p.fileName, size: p.size, kind: p.kind, rows: plan.rows.length, skippedOrders: plan.skippedOrders, newOrders: plan.newOrders, replacedOrders: plan.replacedOrders, shippingMerged: shippingUpdates.length, format: p.format }
      } else {
        await app.importReceipts(meta, p.receipts ?? [])
        entry = { name: p.fileName, size: p.size, kind: p.kind, rows: p.receipts?.length ?? 0, skippedOrders: 0, newOrders: 0, replacedOrders: 0, shippingMerged: 0, format: p.format }
      }
      setStage('recalc')
      await new Promise((r) => setTimeout(r, 0))
      setUploaded((u) => [...u, entry])
      setPending(null)
      setStage('done')
    } catch (e) {
      if (e instanceof DuplicateFileError) {
        setDuplicate(p.fileName)
        setPending(null)
        setStage('idle')
      } else {
        setStage('error')
        setError(e instanceof Error ? e.message : '저장에 실패했습니다. 아무것도 바뀌지 않았습니다.')
      }
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files)
  }

  return (
    <Layout route="upload">
      <main className="main narrow">
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: -0.5 }}>주문목록 CSV 올리기</h1>
          <p className="sub" style={{ margin: '8px 0 0', fontSize: 15, lineHeight: 1.6 }}>
            파일은 이 브라우저 안에서 읽고 계산합니다. 쿠팡 주문목록 내보내기 형식과, 날짜/주문번호/상품명/수량/금액/배송비/상태 열을 가진 외부 주문 도구 형식을 읽을 수 있습니다. 쿠팡 형식은 같은 주문번호의 행이 새 파일 내용으로 바뀌고, 외부 도구 형식은 이미 더 자세한 데이터가 있는 주문을 건너뜁니다. 카드 영수증 CSV(receipt_key 열)도 같은 곳에 올릴 수 있습니다.
          </p>
        </div>

        <label
          className={'drop' + (over ? ' over' : '')}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
            <path d="M14 3v5h5" />
            <path d="M12 18v-6" />
            <path d="M9 15l3-3 3 3" />
          </svg>
          <span style={{ fontSize: 16, fontWeight: 600 }}>CSV 파일을 끌어다 놓거나 눌러서 선택</span>
          <span className="sub">UTF-8 · 쿠팡 형식은 주문번호, 주문일시, 상품번호, 상태, 상품명, 판매가, 수량 열 필수 · 외부 도구 형식은 날짜, 주문번호, 상품명, 수량, 금액, 배송비, 상태</span>
          <input
            type="file"
            accept=".csv,text/csv"
            multiple
            aria-label="CSV 파일 선택"
            data-testid="file-input"
            onChange={(e) => {
              if (e.target.files?.length) void handleFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </label>

        {stage !== 'idle' && stage !== 'done' && stage !== 'error' && (
          <ol className="card card-pad" style={{ listStyle: 'none', margin: 0, display: 'flex', gap: 18, flexWrap: 'wrap' }} aria-label="진행 상태" role="status">
            {STAGES.map(([s, label], i) => {
              const cur = STAGES.findIndex(([k]) => k === stage)
              return (
                <li key={s} style={{ fontWeight: i === cur ? 700 : 500, color: i < cur ? 'var(--good)' : i === cur ? 'var(--ink)' : 'var(--muted)' }}>
                  {i < cur ? '✓ ' : i === cur ? '… ' : ''}
                  {label}
                </li>
              )
            })}
          </ol>
        )}

        {error && (
          <div className="notice err" role="alert" data-testid="upload-error">
            <WarnIcon />
            <div>{error}</div>
          </div>
        )}

        {duplicate && (
          <div className="notice info" role="status" data-testid="duplicate-notice">
            <WarnIcon />
            <div>
              <strong>이미 올린 파일입니다.</strong> 같은 파일(SHA-256 일치)이라 다시 올리지 않았고, 데이터는 바뀌지 않았습니다.
            </div>
          </div>
        )}

        {nothingNew && (
          <div className="notice info" role="status" data-testid="nothing-new">
            <WarnIcon />
            <div>
              <strong>올릴 새 주문이 없습니다.</strong> {nothingNew.name}의 주문 {nothingNew.skipped}개가 모두 이미 더 자세한 데이터로 저장되어 있어 건너뛰었고, 합칠 새 배송비도 없어 데이터는 바뀌지 않았습니다.
            </div>
          </div>
        )}

        {pending && (
          <PendingPanel
            pending={pending}
            existing={app.stored.orders}
            supportsShipping={app.supportsShipping}
            onRemap={remap}
            onMode={(mode) => setPending({ ...pending, mode })}
            onSave={() => void save(pending)}
            onCancel={() => setPending(null)}
          />
        )}

        {uploaded.length > 0 && <ResultPanel uploaded={uploaded} />}

        {!app.hasData ? (
          <section className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 className="h2">연습용 CSV</h2>
            <p className="sub" style={{ margin: 0, lineHeight: 1.6 }}>
              CSV가 없다면 가짜(mock) 데이터로 만든 연습용 파일을 받아 올려 볼 수 있습니다. 실제 구매 내역이 아닙니다.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn sm" onClick={() => downloadText('예시_주문목록.csv', ordersToCsv(generateDemo().orders), 'text/csv;charset=utf-8')}>
                연습용 주문목록 CSV 받기
              </button>
            </div>
          </section>
        ) : null}

        <DedupeList />
        <DataManagement />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <a className="btn primary" href="#/" data-testid="go-dashboard">
            대시보드 보기
          </a>
        </div>
      </main>
    </Layout>
  )
}

function PendingPanel({
  pending,
  existing,
  supportsShipping,
  onRemap,
  onMode,
  onSave,
  onCancel,
}: {
  pending: Pending
  existing: OrderRow[]
  supportsShipping: boolean
  onRemap: (m: ColumnMapping, statusMap?: Record<string, string>) => void
  onMode: (m: OverlapMode) => void
  onSave: () => void
  onCancel: () => void
}) {
  const [map, setMap] = useState<ColumnMapping>(pending.mapping)
  const [stMap, setStMap] = useState<Record<string, string>>(pending.statusMap)
  const isOrders = pending.kind === 'orders'
  const blocked = pending.missing.length > 0 || pending.unknownStatuses.length > 0
  const plan = useMemo(
    () => (isOrders && !blocked ? planImport(pending.orders ?? [], existing, pending.format, pending.mode) : null),
    [isOrders, blocked, pending.orders, existing, pending.format, pending.mode],
  )
  const tool = pending.format === 'orders-tool'

  return (
    <section className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-label="파일 확인" data-testid="pending-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 className="h2">{pending.fileName}</h2>
        {isOrders && (
          <span className="badge" style={{ background: tool ? 'var(--accent-soft)' : 'var(--good-soft)', color: tool ? 'var(--accent)' : 'var(--good)' }} data-testid="format-badge">
            {tool ? '외부 주문 도구 형식' : '쿠팡 내보내기 형식'}
          </span>
        )}
      </div>

      {pending.notes.length > 0 && (
        <ul className="notice info" style={{ margin: 0, paddingLeft: 32, display: 'block', lineHeight: 1.7 }} data-testid="format-notes">
          {pending.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {pending.kind === 'receipts' && pending.missing.length > 0 && (
        <div className="notice err" role="alert">
          영수증 CSV에 필요한 열이 없습니다: {pending.missing.join(', ')}
        </div>
      )}

      {isOrders && pending.missing.length > 0 && (
        <>
          <div className="notice" role="alert">
            <WarnIcon />
            <div>
              필요한 열이 없습니다: <strong>{pending.missing.join(', ')}</strong>. 쿠팡 주문목록은 공식 내보내기 형식이 아니라 열 이름이 바뀔 수 있습니다. 아래에서 직접 짝지어 주세요.
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {REQUIRED_ORDER_COLUMNS.filter((c) => pending.missing.includes(c) || map[c]).map((c) => (
              <label key={c} className="field">
                {c}
                <select
                  className="input"
                  style={{ background: '#fff' }}
                  value={map[c] ?? ''}
                  onChange={(e) => {
                    const next = { ...map, [c as OrderColumn]: e.target.value || undefined }
                    setMap(next)
                  }}
                >
                  <option value="">열 선택…</option>
                  {pending.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div>
            <button type="button" className="btn sm primary" onClick={() => onRemap(map)}>
              짝지은 열로 다시 읽기
            </button>
          </div>
        </>
      )}

      {isOrders && pending.missing.length === 0 && pending.unknownStatuses.length > 0 && (
        <>
          <div className="notice" role="alert" data-testid="unknown-status">
            <WarnIcon />
            <div>
              알 수 없는 주문 상태가 있습니다: <strong>{pending.unknownStatuses.join(', ')}</strong>. 아래에서 앱의 상태와 짝지어 주세요. 짝지을 때까지 이 값의 행은 올리지 않습니다.
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {pending.unknownStatuses.map((u) => (
              <label key={u} className="field">
                {u}
                <select className="input" style={{ background: '#fff' }} data-testid={`status-map-${u}`} value={stMap[u] ?? ''} onChange={(e) => setStMap({ ...stMap, [u]: e.target.value })}>
                  <option value="">상태 선택…</option>
                  {STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div>
            <button
              type="button"
              className="btn sm primary"
              data-testid="status-apply"
              disabled={pending.unknownStatuses.some((u) => !stMap[u])}
              onClick={() => onRemap(pending.mapping, Object.fromEntries(Object.entries(stMap).filter(([, v]) => v)))}
            >
              짝지은 상태로 다시 읽기
            </button>
          </div>
        </>
      )}

      {pending.missing.length === 0 && pending.issues.length > 0 && (
        <>
          <div className="notice err" role="alert">
            <WarnIcon />
            <div>
              읽을 수 없는 행이 <strong>{pending.issues.length}개</strong> 있습니다. 파일에는 아무것도 저장하지 않았습니다.
            </div>
          </div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
            {pending.issues.slice(0, 10).map((i) => (
              <li key={i.line}>
                {i.line}번째 줄: {i.reason}
              </li>
            ))}
            {pending.issues.length > 10 && <li>… 외 {pending.issues.length - 10}개</li>}
          </ul>
        </>
      )}

      {plan && tool && (
        <fieldset style={{ border: '1px solid var(--line-2)', borderRadius: 10, padding: '12px 14px', margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <legend className="sub" style={{ padding: '0 6px' }}>
            이미 저장된 주문과 겹칠 때
          </legend>
          <div style={{ fontSize: 14, lineHeight: 1.7 }} data-testid="plan-summary">
            새 주문 <strong data-testid="plan-new">{plan.newOrders}</strong>개
            {pending.mode === 'skip' ? (
              <>
                , 이미 더 자세한 데이터가 있어 건너뛸 주문 <strong data-testid="plan-skip">{plan.skippedOrders}</strong>개
              </>
            ) : null}
            {supportsShipping && plan.shippingUpdates.length > 0 && (
              <>
                , 배송비만 합쳐 넣을 기존 주문 <strong data-testid="plan-shipping">{plan.shippingUpdates.length}</strong>개
              </>
            )}
            {plan.replacedOrders > 0 && (
              <>
                , 새 내용으로 바꿀 주문 <strong data-testid="plan-replace">{plan.replacedOrders}</strong>개
              </>
            )}
          </div>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14 }}>
            <input type="radio" name="overlap" checked={pending.mode === 'skip'} onChange={() => onMode('skip')} data-testid="mode-skip" style={{ marginTop: 3, accentColor: 'var(--accent)' }} />
            <span>
              건너뛰기 (권장) <span className="sub">쿠팡 내보내기로 올린 주문은 시각, 상품번호, 옵션, 반품 구분이 있어 더 정확합니다</span>
            </span>
          </label>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14 }}>
            <input type="radio" name="overlap" checked={pending.mode === 'overwrite'} onChange={() => onMode('overwrite')} data-testid="mode-overwrite" style={{ marginTop: 3, accentColor: 'var(--accent)' }} />
            <span>
              덮어쓰기 <span className="sub">같은 주문번호를 이 파일 내용으로 바꿉니다(자세한 정보는 사라집니다)</span>
            </span>
          </label>
        </fieldset>
      )}

      {tool && !supportsShipping && (pending.orders ?? []).some((r) => (r.shipping_fee ?? 0) > 0) && (
        <div className="notice" role="status" data-testid="shipping-unsupported">
          <WarnIcon />
          <div>배송비는 아직 저장할 수 없습니다. 데이터베이스에 배송비 컬럼을 추가하는 업데이트(shipping_fee 마이그레이션)가 적용된 뒤에 다시 올리면 반영됩니다. 그 밖의 내용은 지금 올릴 수 있습니다.</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {!blocked && (
          <button type="button" className="btn sm primary" data-testid="upload-confirm" disabled={isOrders && (!plan || (plan.rows.length === 0 && !tool))} onClick={onSave}>
            {pending.issues.length > 0 ? `문제 행 ${pending.issues.length}개를 빼고 올리기` : '올리기'}
          </button>
        )}
        <button type="button" className="btn sm" onClick={onCancel}>
          취소
        </button>
        {plan && plan.rows.length === 0 && (plan.shippingUpdates.length === 0 || !supportsShipping) && tool && <span className="sub">올릴 새 주문이 없습니다. 올리기를 누르면 이 안내만 보여 줍니다.</span>}
      </div>
    </section>
  )
}

function ResultPanel({ uploaded }: { uploaded: UploadedEntry[] }) {
  const app = useApp()
  const { prep, range, settings } = app
  const okAll = useMemo(() => summarize(prep.kept, range.start, range.end, 'ok', range.end), [prep.kept, range.start, range.end])
  const retCount = prep.kept.filter((r) => r.status === '반품완료' || r.status === '취소완료').length
  const classified = prep.kept.filter((r) => r.auto_category !== settings.rules.fallback).length
  const unclassified = prep.kept.filter((r) => r.category === settings.rules.fallback).length
  const rec = useMemo(() => reconcile(prep.kept, app.stored.receipts.length ? app.stored.receipts : null), [prep.kept, app.stored.receipts])
  const cov = useMemo(() => coverage(prep.kept), [prep.kept])
  const last = uploaded[uploaded.length - 1]
  const shipRows = prep.kept.filter((r) => r.shipping_fee > 0)
  const shippingTotal = shipRows.reduce((a, r) => a + r.shipping_fee, 0)
  const shippingOrders = new Set(shipRows.map((r) => r.order_no)).size

  return (
    <section className="card" style={{ overflow: 'hidden' }} aria-label="업로드 결과" data-testid="result">
      <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--line)' }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--good)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12l3 3 5-6" />
        </svg>
        <div style={{ fontSize: 15, fontWeight: 600 }}>
          {last.name} {last.kind === 'receipts' ? '영수증 저장 완료' : '저장 완료'}
        </div>
        <span className="sub" style={{ marginLeft: 'auto' }}>
          {Math.max(1, Math.round(last.size / 1024))} KB
        </span>
      </div>
      <div className="kpis" style={{ gap: 0 }}>
        {[
          { l: `주문 ${prep.orderCount}건 · 원본 상품 행`, v: `${prep.rawCount}행`, t: 'res-raw' },
          { l: '중복 행 제외', v: `${prep.removed.length}행`, t: 'res-dedupe', n: `영수증으로 되살린 행 ${prep.restored.length}행` },
          { l: '받은 상품 합계', v: `${fmt(okAll.total)}원`, t: 'res-total', n: `반품·취소 ${retCount}건 제외` },
          { l: '자동 분류', v: `${classified} / ${prep.kept.length}`, t: 'res-class', n: `미분류 ${unclassified}건` },
        ].map((c) => (
          <div key={c.l} style={{ padding: '16px 20px', borderRight: '1px solid var(--line-2)' }}>
            <div className="sub" style={{ fontSize: 12 }}>
              {c.l}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }} data-testid={c.t}>
              {c.v}
            </div>
            {c.n && (
              <div className="sub" style={{ fontSize: 12, marginTop: 2 }} data-testid={c.t + '-note'}>
                {c.n}
              </div>
            )}
          </div>
        ))}
      </div>
      {cov && (
        <div style={{ padding: '16px 20px', borderTop: '1px solid var(--line)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>데이터 기간 · {dot(cov.start)} ~ {dot(cov.end)}</div>
          <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden', fontSize: 12, fontWeight: 600 }} data-testid="coverage">
            {cov.sparse && (
              <div style={{ flex: Math.max(1, monthsCount(cov.sparse.from, cov.sparse.to)), background: '#dce4fa', color: '#1f3b8c', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0, padding: '0 6px', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                {yymm(cov.sparse.from)} – {yymm(cov.sparse.to)} · 띄엄띄엄 {cov.sparse.rows}건
              </div>
            )}
            {cov.dense && (
              <div style={{ flex: Math.max(1, monthsCount(cov.dense.from, cov.dense.to)), background: '#1f4fd8', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0, padding: '0 6px', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                {yymm(cov.dense.from)} – {yymm(cov.dense.to)} · 매달 있음
              </div>
            )}
          </div>
        </div>
      )}
      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14, lineHeight: 1.5 }}>
        {prep.removed.length + prep.restored.length > 0 && (
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--warn-ink)', fontWeight: 700 }}>!</span>
            <span>
              같은 주문·같은 상품번호·같은 가격·같은 수량 중복 행 <strong>{prep.removed.length + prep.restored.length}행</strong> 중 {prep.removed.length}행을 뺐습니다.
              {prep.restored.length > 0 && ` ${prep.restored.length}행은 카드 영수증에 상품 수가 더 찍혀 있어 실제 구매로 되살렸습니다.`}
              {app.stored.receipts.length === 0 && ' 영수증 CSV를 함께 올리면 실제로 여러 개 산 경우를 되살립니다.'}
            </span>
          </div>
        )}
        {last.skippedOrders > 0 && (
          <div style={{ display: 'flex', gap: 8 }} data-testid="result-skipped">
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>i</span>
            <span>
              이미 더 자세한 데이터가 있어 건너뛴 주문 <strong>{last.skippedOrders}개</strong>. 새로 추가한 주문 {last.newOrders}개{last.replacedOrders > 0 ? `, 새 내용으로 바꾼 주문 ${last.replacedOrders}개` : ''}.
              {last.shippingMerged > 0 && ` 건너뛴 주문 중 ${last.shippingMerged}개에는 배송비만 합쳐 넣었습니다.`}
            </span>
          </div>
        )}
        {shippingTotal > 0 && (
          <div style={{ display: 'flex', gap: 8 }} data-testid="result-shipping">
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>i</span>
            <span>
              배송비 합계 <strong>{fmt(shippingTotal)}원</strong> ({shippingOrders}개 주문) — 총 지출에는 포함하지 않고 별도로 보여 줍니다.
            </span>
          </div>
        )}
        {unclassified > 0 && (
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--warn-ink)', fontWeight: 700 }}>!</span>
            <span>
              분류하지 못한 상품 <strong>{unclassified}건</strong> — <a href="#/categories">카테고리 정리</a>에서 직접 지정해 주세요.
            </span>
          </div>
        )}
        {rec && (
          <div style={{ display: 'flex', gap: 8 }} data-testid="reconcile">
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>i</span>
            <span>
              영수증 대조: 맞춰 본 주문 {rec.matched}건 중 <strong>{rec.exact}건</strong> 일치
              {rec.diffs.length > 0 && `, ${rec.diffs.length}건은 금액 차이(배송비·쿠폰 등)가 있습니다`}.
            </span>
          </div>
        )}
      </div>
    </section>
  )
}

function monthsCount(a: string, b: string): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) + 1
}

function DedupeList() {
  const app = useApp()
  const manual = Object.keys(app.stored.dedupe)
  const rows = [
    ...app.prep.removed.map((r) => ({ r, state: 'removed' as const })),
    ...app.prep.restored.map((r) => ({ r, state: 'restored' as const })),
  ]
  const keptManual = app.prep.kept.filter((r) => app.stored.dedupe[r.key] === 'keep' && !r.restored)
  if (!rows.length && !keptManual.length && !manual.length) return null
  const toggle = async (key: string, action: 'keep' | 'drop' | null) => {
    try {
      await app.setDedupe(key, action)
    } catch {
      /* 알림 표시됨 */
    }
  }
  return (
    <section className="card" aria-label="중복 행 목록">
      <details>
        <summary style={{ padding: '16px 20px', cursor: 'pointer', fontSize: 15, fontWeight: 600 }}>
          제외하거나 되살린 행 {rows.length + keptManual.length}개 보기
        </summary>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th scope="col">날짜</th>
                <th scope="col">상품</th>
                <th scope="col">금액</th>
                <th scope="col">상태</th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  되돌리기
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ r, state }) => (
                <tr key={r.key + state}>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>{dot(r.date)}</td>
                  <td style={{ maxWidth: 320 }}>
                    <div className="ellipsis">{r.base}</div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmt(r.amount)}원</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{state === 'removed' ? '중복으로 제외' : '영수증으로 되살림'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {state === 'removed' ? (
                      <button type="button" className="btn sm" onClick={() => void toggle(r.key, 'keep')}>
                        되살리기
                      </button>
                    ) : (
                      <button type="button" className="btn sm" onClick={() => void toggle(r.key, 'drop')}>
                        다시 제외
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {keptManual.map((r) => (
                <tr key={r.key + 'k'}>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>{dot(r.date)}</td>
                  <td style={{ maxWidth: 320 }}>
                    <div className="ellipsis">{r.base}</div>
                  </td>
                  <td>{fmt(r.amount)}원</td>
                  <td>직접 되살림</td>
                  <td style={{ textAlign: 'right' }}>
                    <button type="button" className="btn sm" onClick={() => void toggle(r.key, null)}>
                      원래대로
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}

function DataManagement() {
  const app = useApp()
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [busy, setBusy] = useState(false)
  async function exportJson() {
    try {
      const data = await app.exportAll()
      downloadText('coushboard_전체내보내기.json', JSON.stringify(data, null, 1), 'application/json;charset=utf-8')
    } catch (e) {
      app.notify(e instanceof Error ? e.message : '내보내지 못했습니다.', true)
    }
  }
  async function wipe() {
    setBusy(true)
    try {
      await app.deleteAll()
      app.notify('내 데이터를 모두 지웠습니다')
      setStep(0)
    } catch (e) {
      app.notify(e instanceof Error ? e.message : '삭제하지 못했습니다.', true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="card card-pad" aria-label="데이터 관리" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 className="h2">내 데이터 관리</h2>
      <p className="sub" style={{ margin: 0, lineHeight: 1.6 }}>
        이 확장은 서버로 아무것도 보내지 않고 이 브라우저(chrome.storage.local)에만 저장합니다. 저장되는 것: 주문목록 원본 행, 영수증(카드번호·승인번호·할부는 제외), 업로드 이력, 내가 만든 카테고리 규칙·지정·품목 합치기. 계산 결과는 저장하지 않습니다.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn sm" onClick={() => void exportJson()}>
          전체 내보내기 (JSON)
        </button>
        {step === 0 && (
          <button type="button" className="btn sm" style={{ color: 'var(--bad)' }} onClick={() => setStep(1)}>
            내 데이터 전체 삭제
          </button>
        )}
        {step === 1 && (
          <>
            <span style={{ fontSize: 14 }}>주문, 영수증, 설정을 모두 지웁니다. 계속할까요?</span>
            <button type="button" className="btn sm danger" onClick={() => setStep(2)}>
              계속
            </button>
            <button type="button" className="btn sm" onClick={() => setStep(0)}>
              취소
            </button>
          </>
        )}
        {step === 2 && (
          <>
            <span style={{ fontSize: 14, fontWeight: 600 }}>되돌릴 수 없습니다. 정말 삭제할까요?</span>
            <button type="button" className="btn sm danger" disabled={busy} onClick={() => void wipe()}>
              {busy ? '삭제 중…' : '네, 전부 삭제'}
            </button>
            <button type="button" className="btn sm" onClick={() => setStep(0)}>
              취소
            </button>
          </>
        )}
      </div>
    </section>
  )
}
