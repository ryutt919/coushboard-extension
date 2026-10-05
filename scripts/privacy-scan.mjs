// 개인정보 가드 (H6). 실패하면 종료 코드 1.
// - 저장소 밖(.gitignore 제외) 추적 대상 파일만 검사한다.
// - 상품명 대조는 로컬에서만: COUPANG_REAL_CSV 환경변수에 실데이터 경로를 주면, 상품명을 메모리에서만 만들어 대조한다(목록을 저장하지 않음).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import Papa from 'papaparse'

const root = resolve(import.meta.dirname, '..')
const fail = []
const ok = (m) => console.log('  ok  ' + m)

function listFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf-8' })
    return out.split('\0').filter(Boolean).map((f) => f.split('/').join(sep))
  } catch {
    // git이 없으면 간단한 순회로 대체(.gitignore 대신 고정 제외 목록)
    const skip = new Set(['node_modules', '.git', 'dist', 'data', 'verify-output', 'ref', 'test-results', 'playwright-report'])
    const res = []
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        if (skip.has(n)) continue
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else res.push(relative(root, p))
      }
    }
    walk(root)
    return res
  }
}

const files = listFiles()
const isFixture = (f) => {
  const p = f.split(sep).join('/')
  return p.startsWith('tests/fixtures/')
}
const textExt = /\.(ts|tsx|js|mjs|cjs|json|html|css|sql|yml|yaml|md|txt|py|svg|toml|env|example)$/i

// 1. 픽스처 밖의 CSV/XLSX
const badData = files.filter((f) => /\.(csv|xlsx)$/i.test(f) && !isFixture(f))
if (badData.length) fail.push(`tests/fixtures 밖에 CSV/XLSX가 있습니다: ${badData.join(', ')}`)
else ok('픽스처 밖 CSV/XLSX 없음')

// 2. 실제 쿠팡 주문번호 형식
const orderRe = /321\d{11}/
const hitOrders = []
for (const f of files) {
  if (!textExt.test(f)) continue
  const t = readFileSync(join(root, f), 'utf-8')
  if (orderRe.test(t)) hitOrders.push(f)
}
if (hitOrders.length) fail.push(`실제 주문번호 형식(321로 시작하는 14자리)이 있습니다: ${hitOrders.join(', ')}`)
else ok('실제 주문번호 형식 없음')

// 3. service_role (문서 제외, 이 파일 제외) + 빌드 결과물
const self = 'scripts/privacy-scan.mjs'
const scanTargets = files.filter((f) => textExt.test(f) && !/\.md$/i.test(f) && f.split(sep).join('/') !== self && !f.split(sep).join('/').startsWith('handoff/'))
const dist = join(root, 'dist')
const distFiles = []
if (existsSync(dist)) {
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(js|html|css|json|map|txt)$/i.test(n)) distFiles.push(p)
    }
  }
  walk(dist)
}
const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g
const roleOf = (payload) => {
  try {
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')).role
  } catch {
    return null
  }
}
const srHits = []
for (const p of [...scanTargets.map((f) => join(root, f)), ...distFiles]) {
  const t = readFileSync(p, 'utf-8')
  if (/service_role/i.test(t)) srHits.push(relative(root, p) + ' (문자열)')
  for (const m of t.matchAll(jwtRe)) if (roleOf(m[1]) === 'service_role') srHits.push(relative(root, p) + ' (JWT)')
}
if (srHits.length) fail.push(`service_role 키/문자열이 있습니다: ${[...new Set(srHits)].join(', ')}`)
else ok(`service_role 없음 (소스 ${scanTargets.length}개, 빌드 결과물 ${distFiles.length}개 검사)`)

// 4. .env 추적 여부
const envTracked = files.filter((f) => /(^|[\\/])\.env(\..*)?$/.test(f) && !/\.env\.example$/.test(f))
if (envTracked.length) fail.push(`.env 파일이 저장소 대상입니다: ${envTracked.join(', ')}`)
else ok('.env 파일 없음')

// 5. 로컬 전용: 실데이터 상품명 대조
const real = process.env.COUPANG_REAL_CSV
if (real && existsSync(real)) {
  const text = readFileSync(real, 'utf-8').replace(/^\ufeff/, '')
  const rows = Papa.parse(text, { header: true, skipEmptyLines: true }).data
  const names = new Set()
  for (const r of rows) {
    const raw = (r['상품명'] ?? '').replace(/^(\[[^\]]*\]|\([^)]*\))\s*/, '')
    const base = raw.split(',')[0].trim()
    if (base.length >= 6) names.add(base)
  }
  // 공개 픽스처에 이미 있는 상품명은 가짜 데이터로 간주해 제외한다
  const fixtureText = files.filter(isFixture).map((f) => readFileSync(join(root, f), 'utf-8')).join(String.fromCharCode(10))
  for (const name of [...names]) if (fixtureText.includes(name)) names.delete(name)
  const leaked = new Map()
  for (const f of files) {
    if (isFixture(f) || !textExt.test(f)) continue
    // handoff 가 초기 품목 병합 목록으로 지정한 파일(공개된 마트 상품명 몇 개). 사용자 데이터에서 새로 가져온 것이 아니므로 예외
    if (f.split(sep).join('/') === 'src/data/product-merges.json') continue
    const t = readFileSync(join(root, f), 'utf-8')
    let n = 0
    for (const name of names) if (t.includes(name)) n += 1
    if (n) leaked.set(f, n)
  }
  if (leaked.size) fail.push(`실데이터 상품명이 들어 있는 파일: ${[...leaked].map(([f, n]) => `${f}(${n}종)`).join(', ')}`)
  else ok(`실데이터 상품명 ${names.size}종 대조: 발견 0건`)
} else {
  console.log('  skip 실데이터 상품명 대조 (COUPANG_REAL_CSV 미설정)')
}

if (fail.length) {
  console.error('\nprivacy-scan 실패:')
  for (const m of fail) console.error(' - ' + m)
  process.exit(1)
}
console.log('privacy-scan 통과')
