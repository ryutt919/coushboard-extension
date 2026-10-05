import { expect, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { test } from './fixtures'
import { allowedHost, expectNoSeriousA11y, FIX, trackHosts } from './helpers'

// 확장 대시보드에 픽스처를 올려 숫자와 동작을 확인한다. 실제 구매 데이터는 쓰지 않는다.
async function login(page: Page) {
  await page.goto('/')
  // 로그인 없이 바로 대시보드. 데이터는 이 브라우저(chrome.storage.local)에만 있다
  await expect(page.getByTestId('collect-bar')).toBeVisible()
}

async function wipe(page: Page) {
  await page.goto('/#/upload')
  await page.getByRole('button', { name: '내 데이터 전체 삭제' }).click()
  await page.getByRole('button', { name: '계속' }).click()
  await page.getByRole('button', { name: '네, 전부 삭제' }).click()
  await expect(page.getByRole('button', { name: '내 데이터 전체 삭제' })).toBeVisible()
}

async function moveEggCookerToDigital(page: Page) {
    await page.getByRole('searchbox', { name: '상품명 검색' }).fill('에그밥솥')
    await page.getByTestId('row').first().getByRole('button', { name: /카테고리 변경/ }).click()
    const panel = page.getByRole('region', { name: '카테고리 바꾸기' })
    await panel.getByRole('button', { name: '디지털·전자', exact: true }).click()
    await panel.getByLabel('같은 품목 전부').check()
    await panel.getByRole('button', { name: '저장' }).click()
    await expect(page.getByTestId('row').first()).toContainText('디지털·전자')
}

const total = (page: Page) => page.getByTestId('kpi-total')
const allPeriod = (page: Page) => page.getByRole('button', { name: '전체', exact: true }).click()

test.describe.configure({ mode: 'serial' })
test.describe('화면 E2E (확장 대시보드)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('1~7: 업로드부터 대시보드 숫자까지', async ({ page }) => {
    const net = trackHosts(page)
    await wipe(page)

    // 1. 주문 픽스처 업로드 -> 21행, 중복 제거 3행
    await page.getByTestId('file-input').setInputFiles(FIX('orders_fixture.csv'))
    await expect(page.getByTestId('res-raw')).toHaveText('21행', { timeout: 20000 })
    await expect(page.getByTestId('res-dedupe')).toHaveText('3행')

    // 2. 영수증 픽스처 -> 복원 1행
    await page.getByTestId('file-input').setInputFiles(FIX('receipts_fixture.csv'))
    await expect(page.getByTestId('res-dedupe-note')).toContainText('1행', { timeout: 20000 })
    await expect(page.getByTestId('res-dedupe')).toHaveText('2행')
    await expectNoSeriousA11y(page, '업로드 결과')

    // 3. 대시보드 전체 + 받은 상품만
    await page.goto('/#/')
    await allPeriod(page)
    await expect(total(page)).toContainText('361,540')
    await expectNoSeriousA11y(page, '대시보드')

    // 4. 반품·취소만
    await page.getByLabel('주문 상태').selectOption('ret')
    await expect(total(page)).toContainText('1,074,000')
    await page.getByLabel('주문 상태').selectOption('ok')

    // 5. 건강·의료 클릭 -> 표에 2행
    await page.getByTestId('cat-건강·의료').click()
    await expect(page.getByTestId('row')).toHaveCount(2)
    await page.getByTestId('cat-건강·의료').click()

    // 6. 세부 내역: 펩시 제로 슈거 라임향
    await page.getByRole('tab', { name: '세부 내역' }).click()
    await page.getByRole('button', { name: /펩시 제로 슈거 라임향/ }).first().click()
    await expect(page.getByTestId('prod-count')).toContainText('4건')
    await expect(page.getByTestId('prod-amount')).toContainText('92,580')
    await expect(page.getByTestId('unit-best').first()).toContainText('790원')
    await expect(page.getByTestId('alias')).toHaveCount(3)

    // 7. 기간 2025-01-01 ~ 2026-06-30 -> 막대 18개, 2026년 6월은 막대 없이 —
    await page.getByRole('tab', { name: '개요' }).click()
    await page.getByLabel('시작일').fill('2025-01-01')
    await page.getByLabel('종료일').fill('2026-06-30')
    await expect(page.getByTestId('bar')).toHaveCount(18)
    await expect(page.getByTestId('bar').last()).toHaveAttribute('data-future', 'true')
    await expect(page.getByTestId('bars').locator('.bar-val').last()).toHaveText('—')

    for (const h of net.hosts) expect(allowedHost(h), h).toBe(true)
  })

  test('8: 카테고리를 바꾸면 새로고침해도 유지된다', async ({ page }) => {
    await page.goto('/#/')
    await allPeriod(page)
    await moveEggCookerToDigital(page)
    await page.reload()
    await page.getByRole('searchbox', { name: '상품명 검색' }).fill('에그밥솥')
    await expect(page.getByTestId('row').first()).toContainText('디지털·전자')
  })

  test('9: 규칙과 지정 내역 내보내기, 초기화, 가져오기로 같은 숫자가 복원된다', async ({ page }, info) => {
    await page.goto('/#/')
    await allPeriod(page)
    const before = ((await page.getByTestId('cat-디지털·전자').textContent()) ?? '').replace(/\s+/g, ' ').trim()

    await page.goto('/#/categories')
    const dl = page.waitForEvent('download')
    await page.getByRole('button', { name: '규칙 내보내기 (JSON)' }).click()
    const file = info.outputPath('settings.json')
    await (await dl).saveAs(file)
    const json = JSON.parse(readFileSync(file, 'utf-8'))
    expect(json.kind).toBe('coushboard-settings')
    expect(Object.keys(json.overrides.group).length).toBeGreaterThan(0)

    await page.getByRole('button', { name: '규칙과 지정 초기화' }).click()
    await page.getByTestId('reset-confirm').click()
    await expect(page.getByTestId('st-manual')).toContainText('0')

    await page.getByTestId('import-input').setInputFiles(file)
    await expect(page.getByTestId('st-manual')).not.toContainText(/^0/, { timeout: 15000 })
    await page.goto('/#/')
    await allPeriod(page)
    await expect(page.getByTestId('cat-디지털·전자')).toHaveText(before)
  })

  test('11: 같은 파일을 두 번 올리면 안내하고 데이터는 그대로다', async ({ page }) => {
    await page.goto('/#/upload')
    await page.getByTestId('file-input').setInputFiles(FIX('orders_fixture.csv'))
    await expect(page.getByTestId('duplicate-notice')).toContainText('이미 올린 파일')
    await page.goto('/#/')
    await allPeriod(page)
    await expect(total(page)).toContainText('361,540')
  })

  test('13: 외부 주문 도구 형식: 형식 안내, 겹치는 주문 건너뛰기, 모르는 상태 짝짓기, 배송비 별도 표시', async ({ page }, info) => {
    const HEAD = '날짜,주문번호,상품명,수량,금액,배송비,상태'
    const tmp = (name: string, body: string) => {
      const f = info.outputPath(name)
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, '﻿' + HEAD + '\r\n' + body + '\r\n', 'utf-8')
      return f
    }
    const upload = (file: string) => page.getByTestId('file-input').setInputFiles(file)
    // E2E_SHIPPING=0: DB에 배송비 컬럼(마이그레이션)이 아직 없는 환경. 이때는 배송비 저장 대신 안내가 나와야 한다
    const shipping = process.env.E2E_SHIPPING !== '0'

    // 쿠팡 내보내기 픽스처를 먼저 올린다(21행)
    await wipe(page)
    await upload(FIX('orders_fixture.csv'))
    await expect(page.getByTestId('res-raw')).toHaveText('21행', { timeout: 20000 })

    // 외부 도구 형식은 바로 올리지 않고 변환 안내와 겹침 처리를 보여 준다
    await upload(FIX('orders_tool_fixture.csv'))
    const panel = page.getByTestId('pending-panel')
    await expect(panel.getByTestId('format-badge')).toHaveText('외부 주문 도구 형식')
    await expect(panel.getByTestId('format-notes')).toContainText('00:00:00')
    await expect(panel.getByTestId('format-notes')).toContainText('5,500원')
    await expect(panel.getByTestId('plan-new')).toHaveText('4')
    await expect(panel.getByTestId('plan-skip')).toHaveText('2') // 이미 쿠팡 내보내기로 올린 주문 2개
    if (shipping) await expect(panel.getByTestId('plan-shipping')).toHaveText('1') // 그중 배송비가 있는 주문 1개는 배송비만 합쳐 넣는다
    else await expect(panel.getByTestId('shipping-unsupported')).toBeVisible()
    await expectNoSeriousA11y(page, '외부 도구 형식 확인')
    await panel.getByTestId('upload-confirm').click()

    // 새 주문 5행이 추가되고, 건너뛴 주문과 배송비가 안내된다
    await expect(page.getByTestId('res-raw')).toHaveText('26행', { timeout: 20000 })
    await expect(page.getByTestId('result-skipped')).toContainText('2개')
    if (shipping) {
      await expect(page.getByTestId('result-skipped')).toContainText('배송비만 합쳐 넣었습니다')
      await expect(page.getByTestId('result-shipping')).toContainText('5,500원') // 새 주문 3,000원 + 기존 주문에 합친 2,500원
    } else {
      await expect(page.getByTestId('result-shipping')).toHaveCount(0)
    }

    // 총 지출은 금액만(341,050 + 39,800), 배송비는 따로
    await page.goto('/#/')
    await allPeriod(page)
    await expect(total(page)).toContainText('380,850')
    if (shipping) await expect(page.getByTestId('kpi-shipping')).toContainText('5,500원')
    else await expect(page.getByTestId('kpi-shipping')).toHaveCount(0)

    // 같은 파일은 다시 올릴 수 없다
    await page.goto('/#/upload')
    await upload(FIX('orders_tool_fixture.csv'))
    await expect(page.getByTestId('duplicate-notice')).toBeVisible()

    // 이미 있는 주문만 들어 있는 파일: 올릴 새 주문이 없다고 안내하고 데이터는 그대로
    await upload(tmp('only-existing.csv', '2025-01-15,1000000000002,다른 이름,1,9999,0,배송완료'))
    await page.getByTestId('upload-confirm').click()
    await expect(page.getByTestId('nothing-new')).toBeVisible()
    await page.goto('/#/')
    await allPeriod(page)
    await expect(total(page)).toContainText('380,850')

    // 모르는 상태값: 짝짓기 전에는 올릴 수 없고, 짝지으면 올라간다
    await page.goto('/#/upload')
    await upload(tmp('unknown-status.csv', '2026-06-05,2000000000007,모의과자 세트,1,5500,0,발송준비'))
    await expect(page.getByTestId('unknown-status')).toContainText('발송준비')
    await expect(page.getByTestId('upload-confirm')).toHaveCount(0)
    await page.getByTestId('status-map-발송준비').selectOption('배송중')
    await page.getByTestId('status-apply').click()
    await page.getByTestId('upload-confirm').click()
    await expect(page.getByTestId('res-raw')).toHaveText('27행', { timeout: 20000 })

    // 덮어쓰기를 고르면 이미 있는 주문도 새 내용으로 바뀐다
    await upload(tmp('overwrite.csv', '2025-01-15,1000000000002,덮어쓴 이름,1,1234,0,배송완료'))
    await page.getByTestId('mode-overwrite').check()
    await expect(page.getByTestId('plan-replace')).toHaveText('1')
    await page.getByTestId('upload-confirm').click()
    await expect(page.getByTestId('res-raw')).toBeVisible()
    await wipe(page)
  })
})
