// 날짜는 'YYYY-MM-DD' 문자열로만 다룬다. 시간대 변환 없음(KST 그대로).

export function monthsBetween(a: string, b: string): string[] {
  let y = Number(a.slice(0, 4))
  let m = Number(a.slice(5, 7))
  const ey = Number(b.slice(0, 4))
  const em = Number(b.slice(5, 7))
  const out: string[] = []
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      y += 1
      m = 1
    }
  }
  return out
}

export interface BucketPlan {
  granularity: 'year' | 'month'
  keys: string[]
  keyOf: (date: string) => string
  isFuture: (key: string, dataEnd: string) => boolean
}

/** 기간이 18개월 이하면 월별, 넘으면 연도별 */
export function planBuckets(from: string, to: string, force?: 'year' | 'month'): BucketPlan {
  const months = monthsBetween(from, to)
  const yearly = force ? force === 'year' : months.length > 18
  const keys = yearly ? [...new Set(months.map((m) => m.slice(0, 4)))] : months
  return {
    granularity: yearly ? 'year' : 'month',
    keys,
    keyOf: yearly ? (d) => d.slice(0, 4) : (d) => d.slice(0, 7),
    isFuture: yearly ? (k, e) => k > e.slice(0, 4) : (k, e) => k > e.slice(0, 7),
  }
}

function toUtc(d: string): Date {
  return new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))))
}

function fmt(dt: Date): string {
  return dt.toISOString().slice(0, 10)
}

export function addDays(d: string, n: number): string {
  const dt = toUtc(d)
  dt.setUTCDate(dt.getUTCDate() + n)
  return fmt(dt)
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86400000)
}

export function addMonths(d: string, n: number): string {
  const y = Number(d.slice(0, 4))
  const m = Number(d.slice(5, 7)) - 1 + n
  const day = Number(d.slice(8, 10))
  const first = new Date(Date.UTC(y, m, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return fmt(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last))))
}

export function monthEnd(d: string): string {
  const y = Number(d.slice(0, 4))
  const m = Number(d.slice(5, 7))
  return fmt(new Date(Date.UTC(y, m, 0)))
}

export type PresetName = '이번 달' | '최근 3개월' | '올해' | '전체' | '직접 지정'
export const PRESETS: PresetName[] = ['이번 달', '최근 3개월', '올해', '전체', '직접 지정']

/** "오늘"은 시스템 날짜가 아니라 데이터의 마지막 주문일 기준 */
export function presetRange(name: Exclude<PresetName, '직접 지정'>, dataStart: string, dataEnd: string): [string, string] {
  switch (name) {
    case '이번 달':
      return [`${dataEnd.slice(0, 7)}-01`, monthEnd(dataEnd)]
    case '최근 3개월':
      return [addDays(addMonths(dataEnd, -3), 1), dataEnd]
    case '올해':
      return [`${dataEnd.slice(0, 4)}-01-01`, `${dataEnd.slice(0, 4)}-12-31`]
    case '전체':
      return [dataStart, dataEnd]
  }
}

export function dot(d: string): string {
  return d.replace(/-/g, '.')
}
