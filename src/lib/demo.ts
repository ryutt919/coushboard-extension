// 예시 화면용 가짜(mock) 주문 데이터. 실제 구매 데이터가 아니며 시드 고정이라 항상 같은 결과가 나온다.
import { addDays } from './dates'
import { csvEscape } from './format'
import { emptyStored, type StoredData } from './stored'
import type { OrderRow, ReceiptRow } from './types'

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Item {
  name: string
  price: [number, number]
  weight: number // 구매 빈도 가중치
}

const ITEMS: Item[] = [
  // 식품·음료
  { name: '모의농장 유기농 사과, 3kg, 1박스', price: [14900, 21900], weight: 6 },
  { name: '샘플마트 보리차 티백, 100개입, 2개', price: [7900, 10900], weight: 5 },
  { name: '가상식당 냉동 만두, 1kg, 2개', price: [10900, 14900], weight: 6 },
  { name: '예시목장 플레인 요거트, 85g, 24개', price: [9900, 13900], weight: 7 },
  { name: '임시수산 냉동 연어 필렛, 500g, 1개', price: [12900, 18900], weight: 3 },
  { name: '모의쌀 현미 쌀, 10kg, 1포', price: [29900, 39900], weight: 2 },
  { name: '샘플커피 원두 커피백, 50개입, 1개', price: [12900, 17900], weight: 4 },
  { name: '예시음료 레몬 탄산수, 500ml, 20개', price: [9900, 13900], weight: 8 },
  { name: '모의농원 방울 토마토, 1kg, 2개', price: [8900, 12900], weight: 4 },
  { name: '테스트제분 부침가루, 1kg, 3개', price: [5900, 8900], weight: 2 },
  // 생활용품
  { name: '샘플홈 주방 키친타월, 150매, 6롤', price: [8900, 12900], weight: 5 },
  { name: '모의생활 빨래 세제 캡슐, 60개입, 2개', price: [14900, 19900], weight: 3 },
  { name: '예시리빙 쓰레기 봉투 대형, 50매, 4개', price: [6900, 9900], weight: 4 },
  { name: '임시홈 멀티 수납 정리함, 화이트', price: [12900, 24900], weight: 1 },
  { name: '가상리빙 욕실 수건 타월, 5장, 1세트', price: [11900, 17900], weight: 2 },
  // 뷰티·위생
  { name: '모의뷰티 선크림 SPF50, 50ml, 2개', price: [14900, 22900], weight: 2 },
  { name: '샘플케어 단백질 샴푸, 750ml, 2개', price: [13900, 18900], weight: 3 },
  { name: '예시덴탈 미백 치약, 120g, 6개', price: [8900, 12900], weight: 3 },
  { name: '가상코스 딸기향 립밤, 4.5g, 3개', price: [5900, 8900], weight: 1 },
  // 건강·의료
  { name: '샘플헬스 루테인 영양제, 90정, 2개', price: [19900, 29900], weight: 2 },
  { name: '모의팜 생유산균 프로바이오틱스, 60포, 1개', price: [17900, 27900], weight: 2 },
  { name: '예시케어 발목 보호대, 블랙', price: [9900, 16900], weight: 1 },
  { name: '임시메디 일회용 마스크, 50매, 4개', price: [9900, 14900], weight: 3 },
  // 운동·레저
  { name: '모의스포츠 헬스 글러브, 블랙', price: [9900, 16900], weight: 1 },
  { name: '가상핏 요가 블록, 2개입', price: [8900, 13900], weight: 1 },
  { name: '샘플런 러닝 양말, 5켤레', price: [7900, 11900], weight: 2 },
  // 디지털·전자
  { name: '예시테크 USB 허브 4포트, 그레이', price: [9900, 17900], weight: 2 },
  { name: '모의디지털 노트북 거치대, 실버', price: [14900, 24900], weight: 1 },
  { name: '샘플전자 블루투스 이어폰, 화이트', price: [19900, 39900], weight: 1 },
  { name: '가상폰 보호 필름 2매입, 투명', price: [4900, 8900], weight: 2 },
  // 미분류(키워드 규칙에 걸리지 않는 품목)
  { name: '모의가구 접이식 의자, 베이지', price: [19900, 34900], weight: 1 },
  { name: '샘플주방 스테인리스 냄비 세트, 3종', price: [29900, 54900], weight: 1 },
  { name: '예시완구 블록 장난감 세트, 500pcs', price: [19900, 34900], weight: 1 },
  { name: '가상문구 스프링 노트, 5권', price: [5900, 9900], weight: 2 },
]

const SELLERS = ['예시마트(주)', '모의상회', '샘플스토어']

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0')
}

export const DEMO_END = '2026-09-28'

export function generateDemo(): { orders: OrderRow[]; receipts: ReceiptRow[] } {
  const rand = rng(20261002)
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)]
  const total = ITEMS.reduce((a, i) => a + i.weight, 0)
  const weighted = () => {
    let x = rand() * total
    for (const it of ITEMS) {
      x -= it.weight
      if (x <= 0) return it
    }
    return ITEMS[0]
  }

  const orders: OrderRow[] = []
  let orderSeq = 0
  const addOrder = (date: string, items: { item: Item; price: number; qty: number; status: string; dup?: boolean }[]) => {
    orderSeq += 1
    const order_no = `9001${pad(orderSeq, 9)}`
    const time = `${pad(7 + Math.floor(rand() * 15))}:${pad(Math.floor(rand() * 60))}:${pad(Math.floor(rand() * 60))}`
    const bundle = `9101${pad(orderSeq, 9)}`
    let seq = 0
    for (const it of items) {
      const copies = it.dup ? 2 : 1 // 내보내기 중복 행 재현
      for (let c = 0; c < copies; c++) {
        orders.push({
          order_no,
          seq: seq++,
          ordered_at: `${date} ${time}`,
          bundle_no: bundle,
          product_no: String(8000000 + ITEMS.indexOf(it.item) * 37 + 11),
          status: it.status,
          raw_name: it.item.name,
          qty: it.qty,
          list_price: Math.round(it.price * 1.08),
          sale_price: it.price,
          seller: pick(SELLERS),
        })
      }
    }
    return order_no
  }

  // 날짜 범위: 2024-11 ~ 2026-09. 2025-03 이전은 드문드문, 이후는 매달.
  const startDay = '2024-11-04'
  const days = 693 // 2024-11-04 ~ 2026-09-28
  let dupOrder = ''
  for (let d = 0; d <= days; d++) {
    const date = addDays(startDay, d)
    const sparse = date < '2025-03-01'
    const p = sparse ? 0.06 : 0.32
    if (rand() > p) continue
    const n = 1 + Math.floor(rand() * 4)
    const items = []
    for (let i = 0; i < n; i++) {
      const item = weighted()
      const price = Math.round((item.price[0] + rand() * (item.price[1] - item.price[0])) / 10) * 10
      const r = rand()
      const status = date > '2026-09-25' ? '배송중' : r < 0.04 ? '반품완료' : r < 0.07 ? '취소완료' : r < 0.09 ? '교환완료' : '배송완료'
      items.push({ item, price, qty: item.price[1] < 15000 && rand() < 0.15 ? 2 : 1, status, dup: false })
    }
    // 같은 상품이 한 주문에 두 번 겹친 내보내기 중복(영수증 대조 사례용)
    if (!dupOrder && date >= '2026-02-01' && items[0].status === '배송완료') items[0].dup = true
    const no = addOrder(date, items)
    if (items[0].dup && !dupOrder) dupOrder = no
  }

  // 영수증: 일부 주문만. 중복 사례 주문은 실제로 2개 산 것으로 찍힌다(복원 사례).
  const receipts: ReceiptRow[] = []
  const byOrder = new Map<string, OrderRow[]>()
  for (const o of orders) byOrder.set(o.order_no, [...(byOrder.get(o.order_no) ?? []), o])
  let k = 0
  for (const [order_no, rows] of byOrder) {
    if (order_no !== dupOrder && rand() > 0.07) continue
    k += 1
    const sum = rows.reduce((a, r) => a + r.sale_price * r.qty, 0)
    receipts.push({
      receipt_key: `demo-${pad(k, 4)}`,
      order_no,
      paid_at: rows[0].ordered_at,
      item_name: rows[0].raw_name.split(',')[0],
      item_count: rows.length,
      total: sum + (rand() < 0.2 ? 3000 : 0),
    })
  }
  return { orders, receipts }
}

export function demoStored(): StoredData {
  const { orders, receipts } = generateDemo()
  const s = emptyStored()
  // 일부 주문(7번째마다)의 첫 행에 배송비를 붙여, 지출과 별도로 보이는 배송비 표시를 예시에서도 볼 수 있게 한다
  const seen = new Map<string, number>()
  s.orders = orders.map((o) => {
    const n = seen.get(o.order_no)
    if (n !== undefined) return o
    seen.set(o.order_no, seen.size)
    return seen.size % 7 === 0 ? { ...o, shipping_fee: 3000 } : o
  })
  s.receipts = receipts
  return s
}

export const ORDER_CSV_HEADER = '주문번호,주문일시,묶음배송번호,상품번호,상태,상품명,수량,정가,판매가,금액(판매가x수량),중복표시의심,정리본포함,주문별합계(정가기준),판매자'

/** 쿠팡 주문목록 CSV와 같은 열 구성(탭 붙은 ID, BOM 포함)으로 내려받을 수 있게 만든다 */
export function ordersToCsv(rows: OrderRow[]): string {
  const lines = rows.map((r) =>
    [
      '\t' + r.order_no,
      r.ordered_at,
      '\t' + (r.bundle_no ?? ''),
      '\t' + r.product_no,
      r.status,
      r.raw_name,
      r.qty,
      r.list_price ?? '',
      r.sale_price,
      r.sale_price * r.qty,
      '',
      '',
      '',
      r.seller ?? '',
    ]
      .map(csvEscape)
      .join(','),
  )
  return '﻿' + [ORDER_CSV_HEADER, ...lines].join('\r\n') + '\r\n'
}
