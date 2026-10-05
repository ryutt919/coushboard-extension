import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import rules from '../src/data/category-rules.json'
import merges from '../src/data/product-merges.json'
import type { RulesConfig } from '../src/lib/types'

export const ROOT = resolve(import.meta.dirname, '..')
export const RULES = rules as RulesConfig
export const MERGES = merges as Record<string, string>
export const fx = (name: string) => readFileSync(resolve(ROOT, 'tests/fixtures', name), 'utf-8')
export const PERIODS = ['ALL', '2025-01-01:2026-06-30']
export const STATUSES3 = ['ok', 'all', 'ret'] as const

/** tools/oracle/oracle.py 를 실제로 실행해 JSON을 돌려받는다(python3, 없으면 python) */
export function runOracle(args: string[]): unknown {
  for (const py of ['python3', 'python']) {
    const r = spawnSync(py, [resolve(ROOT, 'tools/oracle/oracle.py'), ...args], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    if (r.status === 0 && r.stdout) return JSON.parse(r.stdout)
  }
  throw new Error('oracle.py 실행 실패 (python3/python 모두)')
}
