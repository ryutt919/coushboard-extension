// 확장 E2E 용: 웹앱의 예시(mock) 데이터를 JSON 파일로 뽑는다. Playwright 의 TS 로더는 JSON import 를 못 읽어 tsx 로 따로 만든다.
// 사용: tsx scripts/dump-demo.ts <출력 경로>
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { demoStored } from '../src/lib/demo'

const out = process.argv[2]
if (!out) throw new Error('출력 경로가 필요합니다')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(demoStored()))
