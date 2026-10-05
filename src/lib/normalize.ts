const PREFIX_RE = /^(\[[^\]]*\]|\([^)]*\))\s*/
const PIECES_RE = /\d+(?=\s*(?:개|롤|구|정|캔))/g

/** 엑셀 숫자 변환 방지용 탭/공백 제거. 숫자로 바꾸지 않고 문자열로 둔다. */
export function cleanId(v: string | null | undefined): string {
  return (v ?? '').trim()
}

/** 상품명 앞의 [..] 또는 (..) 접두어 1개 제거 */
export function stripPrefix(raw: string): string {
  return raw.replace(PREFIX_RE, '')
}

export function splitName(raw: string): { name: string; base: string; opt: string } {
  const name = stripPrefix(raw)
  const cut = name.indexOf(',')
  const base = (cut < 0 ? name : name.slice(0, cut)).trim()
  const opt = cut < 0 ? '' : name.slice(cut + 1).trim()
  return { name, base, opt }
}

export function productKey(raw: string): string {
  return splitName(raw).base
}

export function piecesOf(opt: string): number {
  const nums = [...opt.matchAll(PIECES_RE)].map((m) => Number(m[0]))
  return nums.length ? Math.max(...nums) : 1
}

/** 파이썬 round(x, 2)와 같은 동작(정확한 이진 값 기준, 동률은 짝수 쪽). */
export function round2(x: number): number {
  if (!Number.isFinite(x)) return x
  const neg = x < 0
  const s = Math.abs(x).toFixed(60)
  const dot = s.indexOf('.')
  const ip = s.slice(0, dot)
  const fp = s.slice(dot + 1)
  let n = BigInt(ip + fp.slice(0, 2))
  const rest = fp.slice(2)
  const first = rest[0]
  const tailNonZero = /[1-9]/.test(rest.slice(1))
  if (first > '5' || (first === '5' && (tailNonZero || n % 2n === 1n))) n += 1n
  const v = Number(n) / 100
  return neg ? -v : v
}

export function mergeGroup(base: string, merges: Record<string, string>): string {
  return Object.prototype.hasOwnProperty.call(merges, base) ? merges[base] : base
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 정규식 조각을 화면용 글자로 되돌린다(이스케이프 제거). */
export function displayKeyword(k: string): string {
  return k.replace(/\\(.)/g, '$1')
}
