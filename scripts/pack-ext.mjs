// 확장 배포용 zip 만들기: 빌드 결과(app/)와 실행에 필요한 파일만 묶어 release/ 에 둔다. 사용: npm run pack:ext
// zip 의 루트에 manifest.json 이 오도록 만든다(압축을 풀면 바로 chrome://extensions 에서 로드 가능).
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const ext = resolve(root, 'extension')
if (!existsSync(resolve(ext, 'app/extension.html'))) throw new Error('app/ 이 없습니다. 먼저 npm run build 를 실행하세요')

const { version } = JSON.parse(readFileSync(resolve(ext, 'manifest.json'), 'utf-8'))
const stage = resolve(root, 'release/stage')
const out = resolve(root, `release/coushboard-extension-v${version}.zip`)
rmSync(resolve(root, 'release'), { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
for (const f of ['manifest.json', 'background.js', 'content', 'lib', 'app']) cpSync(resolve(ext, f), resolve(stage, f), { recursive: true })

// Windows 의 Compress-Archive 는 항목 경로에 역슬래시를 써서 다른 OS 에서 깨지므로, Windows 내장 tar.exe(bsdtar)로 zip 을 만든다(Git Bash 의 GNU tar 와 구별하려고 전체 경로 사용)
const r =
  process.platform === 'win32'
    ? spawnSync(resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', out, '-C', stage, '.'], { stdio: 'inherit' })
    : spawnSync('zip', ['-qr', out, '.'], { cwd: stage, stdio: 'inherit' })
if (r.status !== 0) throw new Error('zip 만들기에 실패했습니다')
rmSync(stage, { recursive: true, force: true })
console.log(`만들었습니다: ${out}`)
