export const fmt = (n: number): string => Math.round(n).toLocaleString('ko-KR')

/** 막대 위 짧은 금액 레이블: 12,345 -> 1.2만 */
export function man(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + '만'
  return fmt(n)
}

const BASE_TAGS: Record<string, [string, string]> = {
  '디지털·전자': ['#EEF2FD', '#1F4FD8'],
  '식품·음료': ['#E7F5EE', '#17643F'],
  '운동·레저': ['#FFF1E6', '#9A4A0C'],
  '건강·의료': ['#FDECEF', '#A02841'],
  '뷰티·위생': ['#F4EDFC', '#6B3FA0'],
  생활용품: ['#EEF4F5', '#2E5F66'],
  미분류: ['#F1F2F4', '#4A4F5A'],
}
const EXTRA_TAGS: [string, string][] = [
  ['#FFF8DB', '#7A5B00'],
  ['#E8F6FA', '#0F6A82'],
  ['#F5ECE6', '#7A4A2A'],
  ['#EDF7E3', '#3F6B14'],
]

export function tagColors(category: string): [string, string] {
  if (BASE_TAGS[category]) return BASE_TAGS[category]
  let h = 0
  for (const ch of category) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return EXTRA_TAGS[h % EXTRA_TAGS.length]
}

export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function csvEscape(v: string | number): string {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
