import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseOrdersCsv } from '../src/lib/csv'
import { ordersToCsv } from '../src/lib/demo'
import { runPipelineFromRows } from '../src/lib/pipeline'
import { fx, MERGES, ROOT, RULES, runOracle } from './helpers'

// 외부 주문 도구 형식을 변환한 결과를 쿠팡 형식 CSV로 바꿔 oracle.py 에 돌려, 같은 계산이 나오는지 비교한다
describe('차등: 외부 주문 도구 형식 변환 결과 vs oracle.py', () => {
  it('변환한 행의 집계가 oracle 결과와 완전히 같다', () => {
    const rows = parseOrdersCsv(fx('orders_tool_fixture.csv')).rows
    const dir = mkdtempSync(join(tmpdir(), 'tool-'))
    try {
      const file = join(dir, 'converted.csv')
      writeFileSync(file, ordersToCsv(rows), 'utf-8')
      const periods = ['ALL', '2026-06-01:2026-06-30']
      const statuses = ['ok', 'all', 'ret'] as const
      const expected = runOracle([
        '--orders', file,
        '--rules', resolve(ROOT, 'src/data/category-rules.json'),
        '--merges', resolve(ROOT, 'src/data/product-merges.json'),
        ...periods.flatMap((p) => ['--period', p]),
        ...statuses.flatMap((s) => ['--status', s]),
      ])
      const actual = runPipelineFromRows(rows, null, { rules: RULES, merges: MERGES, periods, statuses: [...statuses] })
      expect(actual).toEqual(expected)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
