import { useMemo, useRef, useState } from 'react'
import { CategoryPicker } from '../components/CategoryPicker'
import { CatChip } from '../components/Common'
import { Layout } from '../components/Layout'
import { downloadText, fmt, tagColors } from '../lib/format'
import { escapeRegex } from '../lib/normalize'
import {
  addCategory,
  addExclusions,
  addKeyword,
  categoryNameProblem,
  findConflicts,
  keywordStats,
  previewKeyword,
  removeCategory,
  removeKeyword,
} from '../lib/rulesTools'
import { parseBundle, toBundle } from '../lib/stored'
import type { RulesConfig } from '../lib/types'
import { OK_STATUSES } from '../lib/types'
import { useApp } from '../state/AppState'

const SHOW_ITEMS = 10
const SHOW_KW = 8

function initialFromHash(): { kw: string; cat: string } {
  const q = window.location.hash.split('?')[1] ?? ''
  const p = new URLSearchParams(q)
  return { kw: p.get('kw') ?? '', cat: p.get('cat') ?? '' }
}

export function Categories() {
  const app = useApp()
  const { rules } = app.settings
  const fallback = rules.fallback
  // 이 화면은 받은 상품(배송완료, 교환완료, 배송중)만 다룬다. 반품, 취소 행은 나오지 않는다.
  const okRows = useMemo(() => app.prep.kept.filter((r) => OK_STATUSES.has(r.status)), [app.prep.kept])
  const importRef = useRef<HTMLInputElement>(null)

  const [sameAll, setSameAll] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [picked, setPicked] = useState<Record<string, { category: string; keys: string[]; group: boolean }>>({})

  const init = useMemo(initialFromHash, [])
  const [kw, setKw] = useState(init.kw)
  const [ruleCat, setRuleCat] = useState(init.cat && rules.categories.some((c) => c.name === init.cat) ? init.cat : rules.categories[rules.categories.length - 1]?.name ?? '')
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const [openConflict, setOpenConflict] = useState<string | null>(null)
  const [kwExpanded, setKwExpanded] = useState<Record<string, boolean>>({})
  const [addCat, setAddCat] = useState('')
  const [addCatErr, setAddCatErr] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [resetStep, setResetStep] = useState(false)

  const catNames = rules.categories.map((c) => c.name)
  const classified = okRows.filter((r) => r.auto_category !== fallback).length
  const unclassifiedRows = okRows.filter((r) => r.category === fallback).length
  const manualRows = okRows.filter((r) => r.manual).length

  // 품목별 현재 분류와 "직접 정했는지"
  const baseInfo = useMemo(() => {
    const m = new Map<string, { category: string; manual: boolean; n: number }>()
    for (const r of okRows) {
      const e = m.get(r.base)
      if (!e) m.set(r.base, { category: r.category, manual: r.manual, n: 1 })
      else {
        e.n += 1
        e.manual = e.manual && r.manual
      }
    }
    return m
  }, [okRows])

  const conflicts = useMemo(() => findConflicts(rules, okRows), [rules, okRows])
  const conflictView = useMemo(
    () =>
      conflicts.map((c) => {
        const products = c.products.map((p) => ({ ...p, current: baseInfo.get(p.base)?.category ?? c.category, decided: baseInfo.get(p.base)?.manual ?? false }))
        return { ...c, products, open: products.filter((p) => !p.decided).length }
      }),
    [conflicts, baseInfo],
  )
  const pendingConflicts = conflictView.filter((c) => c.open > 0)
  const pendingProducts = new Set(pendingConflicts.flatMap((c) => c.products.filter((p) => !p.decided).map((p) => p.base))).size
  const stats = useMemo(() => keywordStats(rules, okRows), [rules, okRows])

  const items = useMemo(() => {
    const m = new Map<string, { base: string; n: number; amount: number; rows: string[] }>()
    for (const r of okRows) {
      if (r.category !== fallback && !picked[r.base]) continue
      const e = m.get(r.base) ?? { base: r.base, n: 0, amount: 0, rows: [] }
      e.n += 1
      e.amount += r.amount
      e.rows.push(r.key)
      m.set(r.base, e)
    }
    return [...m.values()].sort((a, b) => b.n - a.n || b.amount - a.amount || (a.base < b.base ? -1 : 1))
  }, [okRows, fallback, picked])
  const pendingKinds = items.filter((i) => !picked[i.base]).length

  const preview = useMemo(
    () => (kw.trim() && ruleCat ? previewKeyword(rules, okRows, escapeRegex(kw.trim()), ruleCat) : []),
    [kw, ruleCat, rules, okRows],
  )
  const isChecked = (p: { base: string; checked: boolean }) => (unchecked.has(p.base) ? !p.checked : p.checked)
  const willChange = preview.filter((p) => isChecked(p) && (p.kind === 'new' || p.kind === 'warn')).reduce((a, p) => a + p.count, 0)

  const guard = async (fn: () => Promise<void>, okText?: string) => {
    try {
      await fn()
      if (okText) app.notify(okText)
    } catch {
      /* 오류 알림은 이미 표시됨 */
    }
  }

  async function createCategory(name: string): Promise<boolean> {
    const problem = categoryNameProblem(rules, name)
    if (problem) {
      app.notify(problem, true)
      return false
    }
    try {
      await app.saveRules(addCategory(rules, name.trim()))
      return true
    } catch {
      return false
    }
  }

  async function pick(base: string, rows: string[], category: string) {
    await guard(async () => {
      if (sameAll) {
        await app.setGroupOverride(base, category)
        setPicked((p) => ({ ...p, [base]: { category, keys: [], group: true } }))
      } else {
        const keys = okRows.filter((r) => r.base === base && r.category === fallback).map((r) => r.key)
        await app.setRowOverrides(keys.length ? keys : rows, category)
        setPicked((p) => ({ ...p, [base]: { category, keys: keys.length ? keys : rows, group: false } }))
      }
    })
  }

  async function undo(base: string) {
    const p = picked[base]
    if (!p) return
    await guard(async () => {
      if (p.group) await app.setGroupOverride(base, null)
      else await app.setRowOverrides(p.keys, null)
      setPicked((m) => {
        const n = { ...m }
        delete n[base]
        return n
      })
    })
  }

  async function saveRule() {
    const frag = escapeRegex(kw.trim())
    if (!frag || !ruleCat) return
    let next: RulesConfig = addKeyword(rules, ruleCat, frag)
    const excl = preview.filter((p) => !isChecked(p)).map((p) => p.base)
    if (excl.length) next = addExclusions(next, frag, excl)
    await guard(async () => {
      await app.saveRules(next)
      setKw('')
      setUnchecked(new Set())
    }, `규칙을 저장했습니다 (${willChange}건 새로 분류)`)
  }

  async function moveCategory(i: number, d: -1 | 1) {
    const j = i + d
    if (j < 0 || j >= rules.categories.length) return
    const cats = [...rules.categories]
    ;[cats[i], cats[j]] = [cats[j], cats[i]]
    await guard(() => app.saveRules({ ...rules, categories: cats }))
  }

  async function submitAddCategory() {
    const problem = categoryNameProblem(rules, addCat)
    if (problem) {
      setAddCatErr(problem)
      return
    }
    setAddCatErr(null)
    if (await createCategory(addCat)) {
      app.notify(`'${addCat.trim()}' 카테고리를 추가했습니다`)
      setAddCat('')
    }
  }

  async function deleteCategory(name: string) {
    await guard(async () => {
      // 이 카테고리로 직접 지정한 것은 풀어서 규칙이나 미분류로 돌아가게 한다
      const { row, group } = app.settings.overrides
      for (const [base, cat] of Object.entries(group)) if (cat === name) await app.setGroupOverride(base, null)
      const rowKeys = Object.entries(row).filter(([, cat]) => cat === name).map(([k]) => k)
      if (rowKeys.length) await app.setRowOverrides(rowKeys, null)
      await app.saveRules(removeCategory(rules, name))
      setDeleting(null)
      setPicked({})
    }, `'${name}' 카테고리를 삭제했습니다`)
  }

  function exportRules() {
    downloadText('coushboard_규칙과_지정.json', JSON.stringify(toBundle(app.stored), null, 1), 'application/json;charset=utf-8')
  }

  async function importRules(file: File) {
    try {
      const bundle = parseBundle(await file.text())
      await app.replaceSettings(bundle)
      app.notify('규칙과 지정 내역을 가져왔습니다')
      setPicked({})
    } catch (e) {
      app.notify(e instanceof Error ? e.message : '가져오지 못했습니다.', true)
    }
  }

  async function resetAll() {
    await guard(async () => {
      await app.replaceSettings({ kind: 'coushboard-settings', version: 1, rules: null, overrides: { row: {}, group: {} }, merges: {}, dedupe: {} })
      setResetStep(false)
      setPicked({})
    }, '규칙과 지정을 처음 상태로 되돌렸습니다')
  }

  const shownItems = showAll ? items : items.slice(0, SHOW_ITEMS)

  return (
    <Layout
      route="categories"
      actions={
        <>
          <input
            ref={importRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            aria-label="규칙 JSON 파일 선택"
            data-testid="import-input"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importRules(f)
              e.target.value = ''
            }}
          />
          <button type="button" className="btn" onClick={() => importRef.current?.click()}>
            규칙 가져오기
          </button>
          <button type="button" className="btn" onClick={exportRules}>
            규칙 내보내기 (JSON)
          </button>
        </>
      }
    >
      <main className="main">
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>카테고리 정리</h1>
          <div className="sub">
            직접 고친 분류와 규칙은 이 브라우저에 저장됩니다 · 받은 상품(배송완료, 교환완료, 배송중)만 보여 줍니다. 반품, 취소된 상품은 나오지 않습니다.
          </div>
        </div>

        {!app.hasData && (
          <div className="notice info" role="status">
            아직 올린 주문이 없습니다. <a href="#/upload">CSV를 올리면</a> 분류 현황이 여기에 나타납니다.
          </div>
        )}

        <section aria-label="분류 현황" className="kpis">
          <div className="kpi" style={{ padding: '16px 20px' }}>
            <div className="l">규칙으로 분류됨</div>
            <div className="v" style={{ fontSize: 26, marginTop: 4 }} data-testid="st-auto">
              {classified}
              <small style={{ fontSize: 15 }}> / {okRows.length}</small>
            </div>
          </div>
          <div className="kpi" style={{ padding: '16px 20px' }}>
            <div className="l">미분류</div>
            <div className="v" style={{ fontSize: 26, marginTop: 4, color: 'var(--bad)' }} data-testid="st-unclassified">
              {unclassifiedRows}
              <small style={{ fontSize: 15, color: 'var(--ink)' }}>건</small>
            </div>
          </div>
          <div className="kpi" style={{ padding: '16px 20px' }}>
            <div className="l">직접 지정</div>
            <div className="v" style={{ fontSize: 26, marginTop: 4 }} data-testid="st-manual">
              {manualRows}
              <small style={{ fontSize: 15 }}>건</small>
            </div>
          </div>
          <div className="kpi" style={{ padding: '16px 20px' }}>
            <div className="l">직접 확인할 상품</div>
            <div className="v" style={{ fontSize: 26, marginTop: 4, color: 'var(--warn-ink)' }} data-testid="st-conflicts">
              {pendingProducts}
              <small style={{ fontSize: 15, color: 'var(--ink)' }}>개</small>
            </div>
          </div>
        </section>

        <div className="sub" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: 'var(--ink)' }}>적용 순서</span>
          <span style={{ height: 26, padding: '0 10px', borderRadius: 13, background: 'var(--ink)', color: '#fff', display: 'inline-flex', alignItems: 'center' }}>1 직접 지정</span>
          <span aria-hidden="true">›</span>
          <span style={{ height: 26, padding: '0 10px', borderRadius: 13, background: '#fff', border: '1px solid var(--line-3)', display: 'inline-flex', alignItems: 'center', color: 'var(--ink)' }}>2 키워드 규칙 (위 카테고리부터)</span>
          <span aria-hidden="true">›</span>
          <span style={{ height: 26, padding: '0 10px', borderRadius: 13, background: '#f1f2f4', display: 'inline-flex', alignItems: 'center', color: 'var(--ink)' }}>3 미분류</span>
        </div>

        <section className="card card-pad" aria-label="카테고리 종류" data-testid="category-manager">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h2 className="h2">카테고리 종류</h2>
              <div className="sub" style={{ marginTop: 2 }}>필요한 카테고리를 직접 추가하거나 지울 수 있습니다 (예: 의류, 반려동물, 자동차)</div>
            </div>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="input"
                aria-label="새 카테고리 이름"
                placeholder="새 카테고리 이름"
                data-testid="new-category-input"
                value={addCat}
                onChange={(e) => {
                  setAddCat(e.target.value)
                  setAddCatErr(null)
                }}
                onKeyDown={(e) => e.key === 'Enter' && void submitAddCategory()}
              />
              <button type="button" className="btn sm primary" data-testid="new-category-add" onClick={() => void submitAddCategory()}>
                + 카테고리 추가
              </button>
            </span>
          </div>
          {addCatErr && (
            <div role="alert" style={{ color: 'var(--bad)', fontSize: 13, marginTop: 6 }}>
              {addCatErr}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            {rules.categories.map((c) => {
              const n = okRows.filter((r) => r.category === c.name).length
              const [bg, fg] = tagColors(c.name)
              return (
                <span key={c.name} data-testid="category-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 36, padding: '0 6px 0 12px', borderRadius: 8, background: bg, color: fg, fontSize: 14, fontWeight: 600 }}>
                  {c.name} <span style={{ fontWeight: 400, fontSize: 12 }}>{n}건</span>
                  {deleting === c.name ? (
                    <>
                      <button type="button" className="btn sm danger" style={{ height: 28, padding: '0 8px' }} onClick={() => void deleteCategory(c.name)}>
                        삭제
                      </button>
                      <button type="button" className="btn sm" style={{ height: 28, padding: '0 8px' }} onClick={() => setDeleting(null)}>
                        취소
                      </button>
                    </>
                  ) : (
                    <button type="button" aria-label={`${c.name} 카테고리 삭제`} onClick={() => setDeleting(c.name)} style={{ width: 24, height: 24, border: 0, borderRadius: 12, background: 'rgba(255,255,255,0.7)', color: 'var(--muted)', fontSize: 12, padding: 0 }}>
                      ✕
                    </button>
                  )}
                </span>
              )
            })}
            <span style={{ display: 'inline-flex', alignItems: 'center', height: 36, padding: '0 12px', borderRadius: 8, background: '#f1f2f4', color: '#4a4f5a', fontSize: 14, fontWeight: 600 }}>
              {fallback} <span style={{ fontWeight: 400, fontSize: 12, marginLeft: 6 }}>{unclassifiedRows}건 · 기본 항목</span>
            </span>
          </div>
          {deleting && (
            <div className="sub" style={{ marginTop: 10 }}>
              '{deleting}'을(를) 지우면 이 카테고리로 직접 지정한 것과 키워드 규칙이 함께 사라지고, 해당 상품은 다른 규칙이나 미분류로 돌아갑니다.
            </div>
          )}
        </section>

        <div className="cols">
          <section className="card" style={{ overflow: 'hidden' }} aria-label="미분류 상품">
            <div className="card-head">
              <div>
                <h2 className="h2">미분류 상품</h2>
                <div className="sub" style={{ marginTop: 2 }}>
                  같은 품목 기준 {pendingKinds}종 · 자주 산 순
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, minHeight: 44 }}>
                <input type="checkbox" checked={sameAll} onChange={(e) => setSameAll(e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--accent)' }} />
                같은 상품명 모두 적용
              </label>
            </div>
            <div data-testid="unclassified-list">
              {items.length === 0 && (
                <div className="sub" style={{ padding: 20 }}>
                  미분류 상품이 없습니다.
                </div>
              )}
              {shownItems.map((it) => {
                const pk = picked[it.base]
                return (
                  <div key={it.base} style={{ padding: '14px 20px', borderBottom: '1px solid var(--line-2)' }} data-testid="unclassified-item">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                      <span className="ellipsis" style={{ fontSize: 14, fontWeight: 600 }}>
                        {it.base}
                      </span>
                      <span className="sub" style={{ whiteSpace: 'nowrap' }}>
                        {it.n}건 · {fmt(it.amount)}원
                      </span>
                    </div>
                    {pk ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                        <CatChip category={pk.category} />
                        <span style={{ fontSize: 13, color: 'var(--good)' }}>직접 지정됨</span>
                        <button type="button" className="btn ghost" style={{ marginLeft: 'auto', height: 36, padding: '0 10px', fontSize: 13 }} onClick={() => void undo(it.base)}>
                          되돌리기
                        </button>
                      </div>
                    ) : (
                      <div style={{ marginTop: 8 }}>
                        <CategoryPicker
                          rules={rules}
                          onPick={(c) => void pick(it.base, it.rows, c)}
                          onCreate={async (name) => {
                            if (await createCategory(name)) await pick(it.base, it.rows, name)
                          }}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {items.length > SHOW_ITEMS && (
              <div className="sub" style={{ padding: '12px 20px', background: 'var(--surface-2)' }}>
                {showAll ? (
                  <button type="button" className="btn ghost" style={{ height: 'auto', padding: 0 }} onClick={() => setShowAll(false)}>
                    접기
                  </button>
                ) : (
                  <>
                    {SHOW_ITEMS}종 표시 ·{' '}
                    <button type="button" className="btn ghost" style={{ height: 'auto', padding: 0 }} onClick={() => setShowAll(true)}>
                      나머지 {items.length - SHOW_ITEMS}종 보기
                    </button>
                  </>
                )}
              </div>
            )}
          </section>

          <section className="card card-pad" aria-label="규칙 추가">
            <h2 className="h2">규칙 추가</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10, marginTop: 12 }}>
              <label className="field">
                상품명에 이 단어가 있으면
                <input
                  className="input lg"
                  style={{ borderColor: 'var(--accent)' }}
                  data-testid="rule-keyword"
                  value={kw}
                  onChange={(e) => {
                    setKw(e.target.value)
                    setUnchecked(new Set())
                  }}
                />
              </label>
              <label className="field">
                이 카테고리로
                <select className="input lg" style={{ background: '#fff' }} data-testid="rule-category" value={ruleCat} onChange={(e) => setRuleCat(e.target.value)}>
                  {catNames.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{ marginTop: 14, border: '1px solid var(--line-2)', borderRadius: 10, overflow: 'hidden' }} data-testid="rule-preview">
              <div style={{ padding: '10px 14px', background: 'var(--surface-2)', fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600 }}>미리보기 · {kw.trim() ? `${preview.length}개 품목이 걸립니다` : '단어를 입력하세요'}</span>
                <span className="sub">체크 해제 = 예외</span>
              </div>
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                {preview.slice(0, 40).map((p) => (
                  <label key={p.base} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderTop: '1px solid var(--line-2)', fontSize: 14, minHeight: 28 }}>
                    <input
                      type="checkbox"
                      checked={isChecked(p)}
                      onChange={() => {
                        const n = new Set(unchecked)
                        if (n.has(p.base)) n.delete(p.base)
                        else n.add(p.base)
                        setUnchecked(n)
                      }}
                      style={{ width: 18, height: 18, accentColor: 'var(--accent)', flexShrink: 0 }}
                    />
                    <span className="ellipsis" style={{ flexGrow: 1 }}>
                      {p.base}
                    </span>
                    <span style={{ fontSize: 12, whiteSpace: 'nowrap', fontWeight: 600, color: p.kind === 'warn' || p.kind === 'blocked' ? 'var(--warn-ink)' : p.kind === 'new' ? 'var(--good)' : 'var(--muted)' }}>{p.note}</span>
                  </label>
                ))}
                {preview.length > 40 && <div className="sub" style={{ padding: '8px 14px', borderTop: '1px solid var(--line-2)' }}>… 외 {preview.length - 40}개</div>}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button type="button" className="btn sm" onClick={() => { setKw(''); setUnchecked(new Set()) }}>
                취소
              </button>
              <button type="button" className="btn sm primary" disabled={!kw.trim() || !ruleCat} data-testid="rule-save" onClick={() => void saveRule()}>
                규칙 저장 · {willChange}건 적용
              </button>
            </div>
          </section>
        </div>

        <section className="card" style={{ overflow: 'hidden' }} aria-label="직접 확인할 상품" data-testid="review-section">
          <div className="card-head" style={{ display: 'block' }}>
            <h2 className="h2">직접 확인할 상품</h2>
            <div className="sub" style={{ marginTop: 2 }}>
              뜻이 여러 가지로 쓰이는 단어(예: 마사지, 케이블, 바디)에 걸린 상품입니다. 상품마다 맞는 카테고리를 직접 골라 주세요. 고르면 이 상품은 이후에도 그 카테고리로 고정됩니다.
            </div>
          </div>
          {conflictView.length === 0 && (
            <div className="sub" style={{ padding: 20 }}>
              지금은 확인할 상품이 없습니다.
            </div>
          )}
          {conflictView.slice(0, 12).map((c) => {
            const id = `${c.category}|${c.keyword}`
            const open = openConflict === id || (openConflict === null && c.open > 0 && conflictView.filter((x) => x.open > 0)[0] === c)
            return (
              <div key={id} style={{ padding: '14px 20px', borderBottom: '1px solid var(--line-2)', opacity: c.open === 0 ? 0.65 : 1 }} data-testid="conflict">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ height: 28, padding: '0 10px', borderRadius: 6, background: 'var(--warn-bg)', color: 'var(--warn-ink)', fontWeight: 700, fontSize: 14, display: 'inline-flex', alignItems: 'center' }}>{c.label}</span>
                  <span className="sub">
                    {c.total}건 · {c.split.map((s) => `${s.category} ${s.n}`).join(' · ')}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, color: c.open === 0 ? 'var(--good)' : 'var(--warn-ink)' }}>{c.open === 0 ? '모두 확인함' : `확인할 상품 ${c.open}개`}</span>
                  <button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpenConflict(open ? '' : id)}>
                    {open ? '접기' : '상품 확인하기'}
                  </button>
                </div>
                {open && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {c.products.slice(0, 15).map((p) => (
                      <div key={p.base} style={{ border: '1px solid var(--line-2)', borderRadius: 10, padding: '10px 12px' }} data-testid="review-item">
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                          <span className="ellipsis" style={{ fontSize: 14, fontWeight: 600 }}>
                            {p.base}
                          </span>
                          <span className="sub" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                            {p.count}건 · 지금 {p.current}
                            {p.alt !== p.current && ` · '${c.label}' 없이는 ${p.alt}`}
                          </span>
                        </div>
                        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <CategoryPicker
                            rules={rules}
                            current={p.decided ? p.current : undefined}
                            onPick={(cat) => void guard(() => app.setGroupOverride(p.base, cat), `'${p.base}'을(를) ${cat}(으)로 지정했습니다`)}
                            onCreate={async (name) => {
                              if (await createCategory(name)) await guard(() => app.setGroupOverride(p.base, name), `'${name}'(으)로 지정했습니다`)
                            }}
                            size={32}
                          />
                          {p.decided && (
                            <button type="button" className="btn ghost" style={{ height: 32, padding: '0 8px', fontSize: 13 }} onClick={() => void guard(() => app.setGroupOverride(p.base, null))}>
                              되돌리기
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    {c.products.length > 15 && <div className="sub">… 외 {c.products.length - 15}개</div>}
                    {c.open > 0 && (
                      <div>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() =>
                            void guard(async () => {
                              for (const p of c.products.filter((x) => !x.decided)) await app.setGroupOverride(p.base, p.current)
                            }, '지금 분류를 그대로 확정했습니다')
                          }
                        >
                          남은 {c.open}개를 지금 분류 그대로 확정
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </section>

        <section className="card" style={{ overflow: 'hidden' }} aria-label="키워드 규칙">
          <div className="card-head">
            <div>
              <h2 className="h2">키워드 규칙</h2>
              <div className="sub" style={{ marginTop: 2 }}>숫자 = 이 단어가 들어간 상품 수 · 위에 있는 카테고리가 먼저 적용됩니다</div>
            </div>
          </div>
          {rules.categories.map((c, i) => {
            const list = stats.filter((s) => s.category === c.name).sort((a, b) => b.count - a.count)
            const expanded = kwExpanded[c.name]
            const shown = expanded ? list : list.slice(0, SHOW_KW)
            const total = okRows.filter((r) => r.category === c.name).length
            const [bg, fg] = tagColors(c.name)
            return (
              <div key={c.name} style={{ display: 'grid', gridTemplateColumns: '210px minmax(0, 1fr)', gap: 16, padding: '14px 20px', borderBottom: '1px solid var(--line-2)', alignItems: 'start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 32 }}>
                  <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
                    <button type="button" aria-label={`${c.name} 위로`} disabled={i === 0} onClick={() => void moveCategory(i, -1)} style={{ border: 0, background: 'transparent', color: 'var(--muted)', fontSize: 10, height: 14, padding: 0 }}>
                      ▲
                    </button>
                    <button type="button" aria-label={`${c.name} 아래로`} disabled={i === rules.categories.length - 1} onClick={() => void moveCategory(i, 1)} style={{ border: 0, background: 'transparent', color: 'var(--muted)', fontSize: 10, height: 14, padding: 0 }}>
                      ▼
                    </button>
                  </span>
                  <span className="chip" style={{ background: bg, color: fg }}>
                    {c.name}
                  </span>
                  <span className="sub" style={{ fontSize: 12 }}>
                    {total}건
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {shown.map((k) => (
                    <span key={k.keyword} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 6px 0 10px', border: '1px solid var(--line)', borderRadius: 16, fontSize: 13 }}>
                      {k.label} <span className="sub">{k.count}</span>
                      <button
                        type="button"
                        aria-label={`키워드 ${k.label} 삭제`}
                        onClick={() => void guard(() => app.saveRules(removeKeyword(rules, c.name, k.keyword)))}
                        style={{ width: 22, height: 22, border: 0, borderRadius: 11, background: '#f1f2f4', color: 'var(--muted)', fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  {list.length > SHOW_KW && (
                    <button type="button" onClick={() => setKwExpanded({ ...kwExpanded, [c.name]: !expanded })} style={{ display: 'inline-flex', alignItems: 'center', height: 32, padding: '0 10px', borderRadius: 16, fontSize: 13, color: 'var(--muted)', background: 'var(--surface-2)', border: 0 }}>
                      {expanded ? '접기' : `+ ${list.length - SHOW_KW}개`}
                    </button>
                  )}
                  {list.length === 0 && <span className="sub">키워드가 없습니다. 위의 '규칙 추가'로 넣어 보세요.</span>}
                </div>
              </div>
            )
          })}
        </section>

        <section className="card card-pad" aria-label="백업과 초기화" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 className="h2">백업과 초기화</h2>
          <p className="sub" style={{ margin: 0 }}>위의 '규칙 내보내기'로 규칙과 직접 지정, 품목 합치기, 중복 설정을 JSON으로 저장할 수 있습니다.</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {!resetStep ? (
              <button type="button" className="btn sm" onClick={() => setResetStep(true)}>
                규칙과 지정 초기화
              </button>
            ) : (
              <>
                <span style={{ fontSize: 14 }}>규칙, 직접 지정, 합치기를 처음 상태로 되돌립니다(주문 데이터는 그대로).</span>
                <button type="button" className="btn sm danger" data-testid="reset-confirm" onClick={() => void resetAll()}>
                  초기화
                </button>
                <button type="button" className="btn sm" onClick={() => setResetStep(false)}>
                  취소
                </button>
              </>
            )}
          </div>
        </section>
      </main>
    </Layout>
  )
}
