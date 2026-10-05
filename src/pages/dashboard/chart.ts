import { planBuckets } from '../../lib/dates'

export interface BucketLabeler {
  yearly: boolean
  label: (key: string) => string
}

/** 막대 아래 레이블: 연도별은 2025년, 한 해 안의 월별은 3월, 여러 해에 걸친 월별은 25.3 */
export function labeler(from: string, to: string, force?: 'year' | 'month'): BucketLabeler {
  const plan = planBuckets(from, to, force)
  const yearly = plan.granularity === 'year'
  const oneYear = !yearly && new Set(plan.keys.map((k) => k.slice(0, 4))).size === 1
  return {
    yearly,
    label: (k) => (yearly ? `${k}년` : oneYear ? `${Number(k.slice(5))}월` : `${k.slice(2, 4)}.${Number(k.slice(5))}`),
  }
}
