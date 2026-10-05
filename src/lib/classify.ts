import type { RulesConfig } from './types'

export interface Classifier {
  /** 사용자 지정 없이 키워드 규칙만으로 분류 */
  classify(name: string, base: string): string
  /** 특정 키워드를 빼고 분류(규칙 충돌 감지용). 걸리는 게 없으면 null */
  classifyWithout(name: string, base: string, category: string, keyword: string): string | null
  /** 이름이 걸리는 (카테고리, 키워드) 목록, 규칙 순서대로 */
  matches(name: string, base: string): { category: string; keyword: string }[]
}

export function compileRules(rules: RulesConfig): Classifier {
  const excl = new Map<string, Set<string>>()
  for (const e of rules.exclusions ?? []) {
    if (!excl.has(e.keyword)) excl.set(e.keyword, new Set())
    excl.get(e.keyword)!.add(e.base)
  }
  const hasExcl = excl.size > 0
  const cats = rules.categories.map((c) => ({
    name: c.name,
    rx: c.keywords.length ? new RegExp(c.keywords.join('|')) : null,
    kws: c.keywords.map((k) => ({ k, rx: new RegExp(k) })),
  }))

  const skip = (k: string, base: string) => hasExcl && !!excl.get(k)?.has(base)

  return {
    classify(name, base) {
      for (const c of cats) {
        if (!c.rx) continue
        if (!hasExcl) {
          if (c.rx.test(name)) return c.name
        } else if (c.kws.some((kw) => kw.rx.test(name) && !skip(kw.k, base))) {
          return c.name
        }
      }
      return rules.fallback
    },
    classifyWithout(name, base, category, keyword) {
      for (const c of cats) {
        if (c.kws.some((kw) => !(c.name === category && kw.k === keyword) && kw.rx.test(name) && !skip(kw.k, base))) {
          return c.name
        }
      }
      return null
    },
    matches(name, base) {
      const out: { category: string; keyword: string }[] = []
      for (const c of cats) {
        for (const kw of c.kws) {
          if (kw.rx.test(name) && !skip(kw.k, base)) out.push({ category: c.name, keyword: kw.k })
        }
      }
      return out
    },
  }
}
