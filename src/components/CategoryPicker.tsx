import { useState } from 'react'
import { categoryNameProblem } from '../lib/rulesTools'
import { tagColors } from '../lib/format'
import type { RulesConfig } from '../lib/types'

/**
 * 카테고리 칩 한 줄 + "+ 새 카테고리". 칩을 누르면 onPick, 새 이름을 입력하면 onCreate(이름)을 부른다.
 * 새 카테고리를 만들고 바로 지정까지 하는 흐름에서 쓴다.
 */
export function CategoryPicker({
  rules,
  current,
  onPick,
  onCreate,
  size = 36,
}: {
  rules: RulesConfig
  current?: string
  onPick: (category: string) => void
  onCreate: (name: string) => Promise<void> | void
  size?: number
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function create() {
    const problem = categoryNameProblem(rules, name)
    if (problem) {
      setErr(problem)
      return
    }
    setErr(null)
    await onCreate(name.trim())
    setName('')
    setAdding(false)
  }

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }} role="group" aria-label="카테고리 선택">
      {rules.categories.map((c) => {
        const [bg, fg] = tagColors(c.name)
        const on = current === c.name
        return (
          <button
            key={c.name}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(c.name)}
            style={{ height: size, padding: '0 10px', borderRadius: 6, fontSize: 13, fontWeight: on ? 700 : 500, border: `1px solid ${on ? fg : 'var(--line-3)'}`, background: on ? bg : '#fff', color: on ? fg : 'var(--ink)' }}
          >
            {c.name}
          </button>
        )
      })}
      {adding ? (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ height: size, width: 140 }}
            aria-label="새 카테고리 이름"
            placeholder="예: 의류"
            value={name}
            autoFocus
            onChange={(e) => {
              setName(e.target.value)
              setErr(null)
            }}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <button type="button" className="btn sm primary" style={{ height: size }} onClick={() => void create()}>
            추가하고 지정
          </button>
          <button type="button" className="btn sm" style={{ height: size }} onClick={() => setAdding(false)}>
            취소
          </button>
          {err && (
            <span role="alert" style={{ fontSize: 12, color: 'var(--bad)' }}>
              {err}
            </span>
          )}
        </span>
      ) : (
        <button type="button" onClick={() => setAdding(true)} style={{ height: size, padding: '0 10px', borderRadius: 6, fontSize: 13, fontWeight: 500, border: '1px dashed var(--accent-line)', background: '#fff', color: 'var(--accent)' }}>
          + 새 카테고리
        </button>
      )}
    </div>
  )
}
