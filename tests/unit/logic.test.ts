import { describe, expect, it } from 'vitest'
import { compileRules } from '../../src/lib/classify'
import { parseOrdersCsv } from '../../src/lib/csv'
import { planBuckets, presetRange } from '../../src/lib/dates'
import { cleanId, mergeGroup, piecesOf, productKey, round2, stripPrefix } from '../../src/lib/normalize'
import { prepareRows, summarize } from '../../src/lib/pipeline'
import type { OrderRow, Settings } from '../../src/lib/types'
import { MERGES, RULES } from '../helpers'

const clf = compileRules(RULES)
const settings = (over: Partial<Settings> = {}): Settings => ({
  rules: RULES,
  merges: MERGES,
  overrides: { row: {}, group: {} },
  dedupe: {},
  ...over,
})

describe('ID 정리', () => {
  it.each([
    ['\t1000000000003', '1000000000003'],
    ['\t1108798707190464512', '1108798707190464512'], // 2^53 초과, 문자열로 유지
    ['  86681535514 ', '86681535514'],
  ])('%j -> %j', (input, expected) => {
    expect(cleanId(input)).toBe(expected)
    expect(typeof cleanId(input)).toBe('string')
  })
})

describe('접두어 제거', () => {
  it.each([
    ['[반품-상]펩시 제로 슈거 라임향, 500ml, 24개', '펩시 제로 슈거 라임향, 500ml, 24개'],
    ['(무료배송) 오어브랜드 키네시올로지 근육 스포츠 테이프 테이핑, 5cm x 5m, 12개', '오어브랜드 키네시올로지 근육 스포츠 테이프 테이핑, 5cm x 5m, 12개'],
    ['[로지텍코리아 국내정품] 로지텍 마우스', '로지텍 마우스'],
  ])('%s', (input, expected) => {
    expect(stripPrefix(input)).toBe(expected)
  })
})

describe('품목 키와 병합', () => {
  it('첫 쉼표 앞부분', () => {
    expect(productKey('탐사수 무라벨, 2L, 12개')).toBe('탐사수 무라벨')
  })
  it('쉼표가 없으면 이름 전체', () => {
    expect(productKey('쿠쿠 전기보온 에그밥솥 6인용')).toBe('쿠쿠 전기보온 에그밥솥 6인용')
  })
  it('병합 목록 적용', () => {
    expect(mergeGroup('롯데칠성음료 펩시 제로 슈거 라임향', MERGES)).toBe('펩시 제로 슈거 라임향')
    expect(mergeGroup('펩시 콜라 제로 슈거 라임향 제로 카페인', MERGES)).toBe('펩시 제로 슈거 라임향')
    expect(mergeGroup('탐사수 무라벨', MERGES)).toBe('탐사수 무라벨')
  })
})

describe('개당 가격', () => {
  it.each([
    ['18개, 1개입', 23190, 1288.33],
    ['1개, 60정', 17700, 295],
    ['블랙', 20000, 20000],
    ['500ml, 24개', 20490, 853.75],
  ])('%s / %d원 -> %d', (opt, price, expected) => {
    expect(round2(price / piecesOf(opt))).toBe(expected)
  })
  it('파이썬 round와 같은 동률 처리(짝수 쪽)', () => {
    expect(round2(2.125)).toBe(2.12)
    expect(round2(2.375)).toBe(2.38)
    expect(round2(0.125)).toBe(0.12)
    expect(round2(1288.3333333)).toBe(1288.33)
  })
})

describe('분류', () => {
  it.each([
    ['디벨라 까펠리니 파스타, 500g, 3개', '식품·음료'],
    ['라운드랩 소나무 진정 시카 클렌저', '뷰티·위생'],
    ['코멧 코지 파우더 도톰한 3겹 화장지', '생활용품'],
    ['첵스초코 쿠키앤크림 시리얼', '식품·음료'],
    ['아이깨끗해 핸드워시 청포도향 리필용', '뷰티·위생'],
    ['쿠쿠 전기보온 에그밥솥 6인용', '미분류'],
  ])('%s -> %s', (name, expected) => {
    expect(clf.classify(name, name.split(',')[0])).toBe(expected)
  })

  it('파스는 건강, 파스타는 식품', () => {
    expect(clf.classify('신신파스 쿨, 20매', '신신파스 쿨')).toBe('건강·의료')
  })

  it('사용자 지정이 규칙보다 우선', () => {
    const row: OrderRow = {
      order_no: '1', seq: 0, ordered_at: '2026-01-01 00:00:00', bundle_no: null, product_no: '2',
      status: '배송완료', raw_name: '쿠쿠 전기보온 에그밥솥 6인용', qty: 1, list_price: null, sale_price: 1000, seller: null,
    }
    const byRow = prepareRows([row], null, settings({ overrides: { row: { '1:0': '생활용품' }, group: {} } }))
    expect(byRow.kept[0].category).toBe('생활용품')
    expect(byRow.kept[0].manual).toBe(true)
    const byGroup = prepareRows([row], null, settings({ overrides: { row: {}, group: { '쿠쿠 전기보온 에그밥솥 6인용': '생활용품' } } }))
    expect(byGroup.kept[0].category).toBe('생활용품')
    const none = prepareRows([row], null, settings())
    expect(none.kept[0].category).toBe('미분류')
  })

  it('키워드 예외는 해당 품목만 건너뛴다', () => {
    const rules = { ...RULES, categories: RULES.categories.map((c) => (c.name === '식품·음료' ? { ...c, keywords: [...c.keywords, '밥'] } : c)) }
    const withRule = compileRules(rules)
    expect(withRule.classify('쿠쿠 전기보온 에그밥솥 6인용', '쿠쿠 전기보온 에그밥솥 6인용')).toBe('식품·음료')
    const withExcl = compileRules({ ...rules, exclusions: [{ keyword: '밥', base: '쿠쿠 전기보온 에그밥솥 6인용' }] })
    expect(withExcl.classify('쿠쿠 전기보온 에그밥솥 6인용', '쿠쿠 전기보온 에그밥솥 6인용')).toBe('미분류')
    expect(withExcl.classify('모의 흰밥', '모의 흰밥')).toBe('식품·음료')
  })
})

describe('구간', () => {
  it('18개월은 월별 18칸', () => {
    const p = planBuckets('2025-01-01', '2026-06-30')
    expect(p.granularity).toBe('month')
    expect(p.keys).toHaveLength(18)
  })
  it('19개월은 연도별 3칸', () => {
    const p = planBuckets('2024-11-03', '2026-05-31')
    expect(p.granularity).toBe('year')
    expect(p.keys).toEqual(['2024', '2025', '2026'])
  })
  it('데이터 끝 이후 구간만 future', () => {
    const rows = prepareRows([], null, settings()).kept
    const s = summarize(rows, '2025-01-01', '2026-06-30', 'ok', '2026-05-31')
    const fut = Object.entries(s.buckets).filter(([, b]) => b.future).map(([k]) => k)
    expect(fut).toEqual(['2026-06'])
  })
  it('프리셋은 시스템 날짜가 아니라 데이터 끝 기준', () => {
    expect(presetRange('이번 달', '2021-11-17', '2026-10-01')).toEqual(['2026-10-01', '2026-10-31'])
    expect(presetRange('최근 3개월', '2021-11-17', '2026-10-01')).toEqual(['2026-07-02', '2026-10-01'])
    expect(presetRange('올해', '2021-11-17', '2026-10-01')).toEqual(['2026-01-01', '2026-12-31'])
    expect(presetRange('전체', '2021-11-17', '2026-10-01')).toEqual(['2021-11-17', '2026-10-01'])
  })
})

describe('상태', () => {
  it('배송중, 교환완료는 지출에 포함', () => {
    const mk = (status: string, seq: number): OrderRow => ({
      order_no: '9', seq, ordered_at: '2026-01-01 00:00:00', bundle_no: null, product_no: String(seq + 1),
      status, raw_name: '상품 ' + seq, qty: 1, list_price: null, sale_price: 100, seller: null,
    })
    const prep = prepareRows(['배송중', '교환완료', '배송완료', '반품완료', '취소완료'].map(mk), null, settings())
    const ok = summarize(prep.kept, '2026-01-01', '2026-01-31', 'ok', '2026-01-01')
    const ret = summarize(prep.kept, '2026-01-01', '2026-01-31', 'ret', '2026-01-01')
    expect(ok.rows).toBe(3)
    expect(ret.rows).toBe(2)
  })
})

describe('CSV 파싱', () => {
  it('BOM, CRLF, 탭 붙은 ID를 처리한다', () => {
    const csv = '﻿주문번호,주문일시,상품번호,상태,상품명,수량,판매가\r\n\t123,2026-01-01 10:00:00,\t456,배송완료,"가, 나",2,1000\r\n'
    const r = parseOrdersCsv(csv)
    expect(r.missing).toEqual([])
    expect(r.issues).toEqual([])
    expect(r.rows[0]).toMatchObject({ order_no: '123', product_no: '456', raw_name: '가, 나', qty: 2, sale_price: 1000, seq: 0 })
  })
  it('없는 열을 알려 주고, 열 짝짓기로 해결한다', () => {
    const csv = 'no,일시,상품번호,상태,상품명,수량,판매가\n1,2026-01-01 10:00:00,2,배송완료,a,1,100\n'
    const r = parseOrdersCsv(csv)
    expect(r.missing).toEqual(['주문번호', '주문일시'])
    const mapped = parseOrdersCsv(csv, { 주문번호: 'no', 주문일시: '일시' })
    expect(mapped.missing).toEqual([])
    expect(mapped.rows).toHaveLength(1)
  })
  it('잘못된 행은 줄 번호와 사유만 보고한다(내용은 담지 않는다)', () => {
    const csv = '주문번호,주문일시,상품번호,상태,상품명,수량,판매가\nabc,2026-01-01 10:00:00,2,배송완료,비밀상품,1,100\n'
    const r = parseOrdersCsv(csv)
    expect(r.rows).toHaveLength(0)
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].line).toBe(2)
    expect(JSON.stringify(r.issues)).not.toContain('비밀상품')
  })
})
