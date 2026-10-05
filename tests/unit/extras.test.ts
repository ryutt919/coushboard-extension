import { describe, expect, it } from 'vitest'
import { compileRules } from '../../src/lib/classify'
import { splitName } from '../../src/lib/normalize'
import { prepareRows } from '../../src/lib/pipeline'
import { addCategory, categoryNameProblem, findConflicts, removeCategory } from '../../src/lib/rulesTools'
import { unitStats } from '../../src/lib/stats'
import { DEFAULT_MERGES, DEFAULT_RULES, DEFAULT_RULES_EXTENDED, EXTRAS_VERSION, effectiveRules, withExtras } from '../../src/lib/stored'
import type { OrderRow } from '../../src/lib/types'

const ext = compileRules(DEFAULT_RULES_EXTENDED)
const base = compileRules(DEFAULT_RULES)
const cls = (raw: string, c = ext) => {
  const { name, base: b } = splitName(raw)
  return c.classify(name, b)
}

describe('확장 키워드: 사용자가 직접 지정했던 유형은 자동으로 같은 카테고리가 된다', () => {
  // 가상 상품명. 실제 구매 품목이 아니라 같은 유형을 흉내 낸 것
  it.each([
    ['모의농원 컷팅 파인애플 스틱, 300g, 3개', '식품·음료'],
    ['샘플제당 올리고당, 1.2kg, 2개', '식품·음료'],
    ['가상바 더 바삭한 김, 4.5g, 12개', '식품·음료'],
    ['예시푸드 밀또띠아 오리지널 8인치, 10개', '식품·음료'],
    ['예시농장 손질 배추, 1kg, 1개', '식품·음료'],
    ['모의농장 절단무 450g, 2개', '식품·음료'],
    ['모의피트 모노크레아틴 플러스, 500g', '운동·레저'],
    ['샘플홈 통세탁 사계절 토퍼, 퀸', '생활용품'],
    ['가상스포츠 방수배낭커버 반사 야광 덮개, 45L', '생활용품'],
    ['샘플핏 스마트워치 BIP 6, 블랙', '디지털·전자'],
    ['모의주방 전기보온 에그밥솥 6인용', '생활용품'],
    ['샘플가구 도미닉 서랍장 2.2단, 화이트', '생활용품'],
    ['가상의류 쿨링 라운드넥 반팔 티셔츠 3p, 블랙', '생활용품'],
  ])('%s -> %s', (name, expected) => {
    expect(cls(name)).toBe(expected)
  })

  it('일반 식재료, 생활, 운동 용품도 폭넓게 분류한다', () => {
    expect(cls('모의수산 삼겹살 수육보쌈용, 500g')).toBe('식품·음료')
    expect(cls('샘플제과 사우어 젤리, 80g, 5개')).toBe('식품·음료')
    expect(cls('예시푸드 우거지갈비탕, 500g, 3개')).toBe('식품·음료')
    expect(cls('샘플주방 티타늄코팅 궁중팬, 28cm')).toBe('생활용품')
    expect(cls('모의가전 탁상용 써큘레이터 선풍기')).toBe('생활용품')
    expect(cls('가상캠핑 접이식 텐트, 4인용')).toBe('운동·레저')
    expect(cls('예시뷰티 비타민 앰플 세럼, 30ml')).toBe('뷰티·위생')
    expect(cls('모의약국 상처 연고, 10g, 2개')).toBe('건강·의료')
    expect(cls('샘플전자 노트북 파우치, 15인치')).toBe('디지털·전자')
  })

  it('헷갈리는 단어를 잘못 잡지 않는다', () => {
    expect(cls('라이프 익스텐션 인히비터 캡슐, 60정')).toBe('건강·의료') // '스텐'이 '익스텐션'에 걸리지 않는다
    expect(cls('통기성 스판 래쉬가드 속바지 반바지, 자외선차단')).toBe('운동·레저')
    expect(cls('김강 모의 입체 수면안대')).not.toBe('식품·음료') // 사람 이름의 '김'
    expect(cls('모의오뚜기 미역국, 3개')).toBe('식품·음료')
    expect(cls('샘플쓰 무라벨 생수, 2L, 12개')).toBe('식품·음료')
  })

  it('기본 규칙(handoff, oracle 기준)은 그대로다', () => {
    expect(cls('쿠쿠 전기보온 에그밥솥 6인용', base)).toBe('미분류')
    expect(DEFAULT_RULES.categories.map((c) => c.name)).toEqual(['디지털·전자', '생활용품', '뷰티·위생', '건강·의료', '운동·레저', '식품·음료'])
  })

  it('기존에 분류되던 핵심 사례는 바뀌지 않는다', () => {
    for (const [name, expected] of [
      ['디벨라 까펠리니 파스타, 500g, 3개', '식품·음료'],
      ['라운드랩 소나무 진정 시카 클렌저', '뷰티·위생'],
      ['코멧 코지 파우더 도톰한 3겹 화장지', '생활용품'],
      ['첵스초코 쿠키앤크림 시리얼', '식품·음료'],
      ['아이깨끗해 핸드워시 청포도향 리필용', '뷰티·위생'],
    ] as const) {
      expect(cls(name)).toBe(expected)
    }
  })
})

describe('확장 키워드 병합', () => {
  it('두 번 적용해도 같다(멱등)', () => {
    expect(withExtras(withExtras(DEFAULT_RULES))).toEqual(withExtras(DEFAULT_RULES))
  })

  it('저장된 규칙에 확장 버전이 없으면 확장을 합치고, 사용자 키워드와 예외는 지킨다', () => {
    const stored = {
      ...DEFAULT_RULES,
      categories: DEFAULT_RULES.categories.map((c) => (c.name === '식품·음료' ? { ...c, keywords: [...c.keywords, '내키워드'] } : c)),
      exclusions: [{ keyword: '밥', base: 'x' }],
    }
    const eff = effectiveRules(stored)
    expect(eff.extrasVersion).toBe(EXTRAS_VERSION)
    const food = eff.categories.find((c) => c.name === '식품·음료')!
    expect(food.keywords).toContain('내키워드')
    expect(food.keywords).toContain('배추')
    expect(eff.exclusions).toEqual([{ keyword: '밥', base: 'x' }])
  })

  it('확장 버전이 찍힌 규칙은 다시 합치지 않는다(사용자가 지운 키워드가 되살아나지 않는다)', () => {
    const eff = withExtras(DEFAULT_RULES)
    const without = { ...eff, categories: eff.categories.map((c) => (c.name === '식품·음료' ? { ...c, keywords: c.keywords.filter((k) => k !== '배추') } : c)) }
    expect(effectiveRules(without).categories.find((c) => c.name === '식품·음료')!.keywords).not.toContain('배추')
  })

  it('사용자가 지운 카테고리는 되살리지 않는다', () => {
    const stored = { ...DEFAULT_RULES, categories: DEFAULT_RULES.categories.filter((c) => c.name !== '운동·레저') }
    expect(effectiveRules(stored).categories.map((c) => c.name)).not.toContain('운동·레저')
  })
})

describe('카테고리 추가와 삭제', () => {
  const rules = DEFAULT_RULES_EXTENDED
  it('새 카테고리를 추가한다', () => {
    const next = addCategory(rules, '의류')
    expect(next.categories[next.categories.length - 1]).toEqual({ name: '의류', keywords: [] })
  })
  it('이름 검사: 비어 있음, 중복, 기본 항목, 너무 김', () => {
    expect(categoryNameProblem(rules, '  ')).toMatch(/입력/)
    expect(categoryNameProblem(rules, '식품·음료')).toMatch(/이미/)
    expect(categoryNameProblem(rules, '미분류')).toMatch(/기본/)
    expect(categoryNameProblem(rules, 'ㅏ'.repeat(21))).toMatch(/20자/)
    expect(categoryNameProblem(rules, '의류')).toBeNull()
  })
  it('삭제하면 그 카테고리의 키워드는 더 이상 쓰이지 않는다', () => {
    const next = removeCategory(rules, '운동·레저')
    expect(next.categories.map((c) => c.name)).not.toContain('운동·레저')
    expect(compileRules(next).classify('모의스포츠 요가 매트', '모의스포츠 요가 매트')).not.toBe('운동·레저')
  })
  it('새 카테고리에 키워드를 넣으면 그 카테고리로 분류된다', () => {
    const next = addCategory(rules, '반려동물')
    const withKw = { ...next, categories: next.categories.map((c) => (c.name === '반려동물' ? { ...c, keywords: ['강아지'] } : c)) }
    // 반려동물은 맨 뒤라 앞선 카테고리에 안 걸리는 이름만 해당
    expect(compileRules(withKw).classify('모의펫 강아지 장난감', '모의펫 강아지 장난감')).toBe('반려동물')
  })
})

describe('직접 확인할 상품(규칙 충돌)', () => {
  const mk = (order: number, raw: string, status = '배송완료'): OrderRow => ({
    order_no: String(order), seq: 0, ordered_at: '2026-01-01 10:00:00', bundle_no: null, product_no: String(order),
    status, raw_name: raw, qty: 1, list_price: null, sale_price: 1000, seller: null,
  })
  it('같은 단어에 걸렸지만 뜻이 갈리는 상품을 품목 단위로 알려 준다', () => {
    const rows = [
      mk(1, '모의케어 전신 마사지기, 화이트'),
      mk(2, '샘플푸드 마사지 오일 쿠키, 3개'), // '마사지'와 '쿠키'(식품)에 모두 걸림
      mk(3, '예시헬스 마사지볼, 2개'),
    ]
    const prep = prepareRows(rows, null, { rules: DEFAULT_RULES_EXTENDED, merges: DEFAULT_MERGES, overrides: { row: {}, group: {} }, dedupe: {} })
    const conflicts = findConflicts(DEFAULT_RULES_EXTENDED, prep.kept)
    const massage = conflicts.find((c) => c.label === '마사지')
    expect(massage).toBeTruthy()
    expect(massage!.products.some((p) => p.base.includes('쿠키'))).toBe(true)
    expect(massage!.products[0].count).toBeGreaterThan(0)
  })
})

describe('요약 지표는 1개당 가격 기준', () => {
  const mk = (n: number, price: number, qty: number, dt = '2026-01-01 10:00:00'): OrderRow => ({
    order_no: String(n), seq: 0, ordered_at: dt, bundle_no: null, product_no: String(n),
    status: '배송완료', raw_name: `모의상품 ${n}, 1개`, qty, list_price: null, sale_price: price, seller: null,
  })
  const run = (rows: OrderRow[]) => {
    const prep = prepareRows(rows, null, { rules: DEFAULT_RULES_EXTENDED, merges: DEFAULT_MERGES, overrides: { row: {}, group: {} }, dedupe: {} })
    return unitStats(prep.kept)
  }

  it('가장 큰 구매는 금액이 아니라 1개당 가격이 가장 큰 행이다', () => {
    const s = run([mk(1, 10000, 5), mk(2, 30000, 1), mk(3, 2000, 2)]) // 금액 기준이면 1번(50,000원)이 가장 큼
    expect(s.top?.price).toBe(30000)
    expect(s.top?.base).toBe('모의상품 2')
  })

  it('1개당 가격이 같으면 더 최근 거래를 고른다', () => {
    const s = run([mk(1, 5000, 1, '2026-01-01 10:00:00'), mk(2, 5000, 1, '2026-03-01 10:00:00')])
    expect(s.top?.base).toBe('모의상품 2')
  })

  it('평균은 총 지출을 총 수량으로 나눈 1개당 평균이다', () => {
    const s = run([mk(1, 10000, 5), mk(2, 30000, 1), mk(3, 2000, 2)])
    expect(s.totalQty).toBe(8)
    expect(s.avgUnit).toBe((50000 + 30000 + 4000) / 8)
  })

  it('행이 없으면 0과 null', () => {
    expect(run([])).toEqual({ top: null, totalQty: 0, avgUnit: 0 })
  })
})
