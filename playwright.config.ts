import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

// 확장을 Chromium 에 로드해 화면 시나리오(tests/e2e)와 수집 시나리오(tests/e2e-ext)를 돌린다. 쿠팡 서버에는 접속하지 않는다.
// 수집 시나리오는 mc.coupang.com 요청을 가로채 합성 응답을 준다. 예시 데이터는 tsx 로 JSON 에 뽑아 두고 테스트가 읽는다.
process.env.E2E_DEMO_JSON = resolve('test-results/ext-demo.json')
execFileSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/dump-demo.ts', process.env.E2E_DEMO_JSON], { stdio: 'inherit' })

export default defineConfig({
  testDir: './tests',
  testMatch: ['e2e/*.spec.ts', 'e2e-ext/*.spec.ts'],
  timeout: 180000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
})
