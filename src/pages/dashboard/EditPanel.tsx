import { useEffect, useMemo, useRef, useState } from 'react'
import { CategoryPicker } from '../../components/CategoryPicker'
import { fmt } from '../../lib/format'
import { escapeRegex } from '../../lib/normalize'
import { addCategory, addKeyword, previewKeyword } from '../../lib/rulesTools'
import type { EnrichedRow } from '../../lib/types'
import { useApp } from '../../state/AppState'

type Scope = 'one' | 'same' | 'rule'

export function EditPanel({ row, onClose }: { row: EnrichedRow; onClose: () => void }) {
  const app = useApp()
  const { rules } = app.settings
  const ref = useRef<HTMLDivElement>(null)
  const [cat, setCat] = useState(row.category)
  const [scope, setScope] = useState<Scope>('same')
  const [kw, setKw] = useState(() => row.base.split(' ').slice(-1)[0])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [row.key])

  const preview = useMemo(
    () => (scope === 'rule' && kw.trim() ? previewKeyword(rules, app.prep.kept, escapeRegex(kw.trim()), cat) : []),
    [scope, kw, cat, rules, app.prep.kept],
  )
  const sameCount = app.prep.kept.filter((r) => r.base === row.base).length

  async function save() {
    if (cat === row.category && scope !== 'rule') {
      onClose()
      return
    }
    setBusy(true)
    try {
      if (scope === 'one') {
        await app.setRowOverride(row.key, cat)
      } else if (scope === 'same') {
        await app.setGroupOverride(row.base, cat)
      } else {
        const frag = escapeRegex(kw.trim())
        if (!kw.trim()) return
        await app.saveRules(addKeyword(rules, cat, frag))
        // 이전에 직접 지정한 값이 새 규칙을 가리지 않도록 이 품목의 지정은 푼다
        if (app.settings.overrides.row[row.key]) await app.setRowOverride(row.key, null)
        if (app.settings.overrides.group[row.base]) await app.setGroupOverride(row.base, null)
      }
      app.notify(scope === 'rule' ? `규칙을 저장했습니다 (${preview.length}개 품목에 적용 대상)` : '카테고리를 저장했습니다')
      onClose()
    } catch {
      /* 오류 알림은 app.run에서 이미 표시했다 */
    } finally {
      setBusy(false)
    }
  }

  const scopes: { k: Scope; label: string; hint: string }[] = [
    { k: 'one', label: '이 행만', hint: '' },
    { k: 'same', label: '같은 품목 전부', hint: `이후에 올리는 파일에도 적용 (${sameCount}건)` },
    { k: 'rule', label: '키워드 규칙으로 저장', hint: '비슷한 상품까지 자동 분류' },
  ]

  return (
    <div className="edit-panel" ref={ref} role="region" aria-label="카테고리 바꾸기">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div className="ellipsis" style={{ fontSize: 15, fontWeight: 700, minWidth: 0 }}>
          카테고리 바꾸기 · {row.base}
        </div>
        <span className="sub" style={{ whiteSpace: 'nowrap' }}>
          지금: {row.category}
        </span>
      </div>
      <div style={{ marginTop: 12 }}>
        <CategoryPicker
          rules={rules}
          current={cat}
          onPick={setCat}
          onCreate={async (name) => {
            try {
              await app.saveRules(addCategory(rules, name))
              setCat(name)
              app.notify(`'${name}' 카테고리를 추가했습니다`)
            } catch {
              /* 오류 알림은 이미 표시됨 */
            }
          }}
        />
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: '14px 0 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <legend className="sub" style={{ padding: 0, marginBottom: 4 }}>
          어디까지 적용할까요?
        </legend>
        {scopes.map((s) => (
          <label key={s.k} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 40, fontSize: 14 }}>
            <input type="radio" name="scope" checked={scope === s.k} onChange={() => setScope(s.k)} style={{ width: 18, height: 18, accentColor: 'var(--accent)', flexShrink: 0 }} />
            <span>
              {s.label} {s.hint && <span className="sub">{s.hint}</span>}
            </span>
          </label>
        ))}
      </fieldset>
      {scope === 'rule' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0 0 28px', flexWrap: 'wrap' }}>
          <span className="sub">상품명에</span>
          <input className="input" style={{ width: 140 }} aria-label="규칙 키워드" value={kw} onChange={(e) => setKw(e.target.value)} />
          <span className="sub">
            이 들어가면 · 지금 걸리는 품목 {preview.length}개 ·{' '}
            <a href={`#/categories?kw=${encodeURIComponent(kw.trim())}&cat=${encodeURIComponent(cat)}`}>미리보기</a>
          </span>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <span className="sub" style={{ fontSize: 12 }}>
          이 브라우저에 저장됩니다
          {row.amount > 0 && ` · 이 행 ${fmt(row.amount)}원`}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn sm" onClick={onClose}>
            취소
          </button>
          <button type="button" className="btn sm primary" onClick={() => void save()} disabled={busy}>
            저장
          </button>
        </div>
      </div>
    </div>
  )
}
