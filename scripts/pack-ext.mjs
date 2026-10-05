// 확장 배포용 zip 만들기: 빌드 결과(app/)와 실행에 필요한 파일만 묶어 release/ 에 둔다. 사용: npm run pack
// zip 의 루트에 manifest.json 이 오도록 만든다(압축을 풀면 바로 chrome://extensions 에서 로드 가능).
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** zip 의 중앙 디렉터리에서 항목 이름을 읽는다(외부 의존 없이 배포 전 검사에 쓴다) */
export function zipEntryNames(file) {
  const b = readFileSync(file)
  let e = b.length - 22
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--
  if (e < 0) throw new Error('zip 의 끝 구조(End of central directory)를 찾지 못했습니다')
  const count = b.readUInt16LE(e + 10)
  let p = b.readUInt32LE(e + 16)
  const names = []
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 중앙 디렉터리가 올바르지 않습니다')
    const nameLen = b.readUInt16LE(p + 28)
    const extraLen = b.readUInt16LE(p + 30)
    const commentLen = b.readUInt16LE(p + 32)
    names.push(b.toString('utf8', p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen
  }
  return names
}

/**
 * 윈도우 탐색기의 압축 폴더가 읽을 수 있는 이름인지 검사한다.
 * 항목 이름이 "./manifest.json" 처럼 "./" 로 시작하면 탐색기는 zip 안을 빈 폴더로 보여 주거나 "압축 폴더가 올바르지 않습니다" 오류로 풀지 못한다.
 * (tar 에 "." 를 넘겨 묶었던 v0.2.0 ~ v0.3.0 의 zip 이 이 문제였다) 역슬래시와 절대 경로도 같은 이유로 막는다.
 */
export function assertPortableZip(names) {
  const bad = names.filter((n) => n.startsWith('./') || n.startsWith('/') || n.includes('\\') || n === '.' || n.includes('../'))
  if (bad.length) throw new Error(`탐색기에서 풀 수 없는 항목 이름이 ${bad.length}개 있습니다(예: ${bad.slice(0, 3).join(', ')})`)
  if (!names.includes('manifest.json')) throw new Error('zip 의 루트에 manifest.json 이 없습니다')
}

// 직접 실행했을 때만 zip 을 만든다(다른 파일이 위 검사 함수만 가져다 쓸 수 있게)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..')
  const ext = resolve(root, 'extension')
  if (!existsSync(resolve(ext, 'app/extension.html'))) throw new Error('app/ 이 없습니다. 먼저 npm run build 를 실행하세요')

  const { version } = JSON.parse(readFileSync(resolve(ext, 'manifest.json'), 'utf-8'))
  const stage = resolve(root, 'release/stage')
  const out = resolve(root, `release/coushboard-extension-v${version}.zip`)
  rmSync(resolve(root, 'release'), { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  for (const f of ['manifest.json', 'background.js', 'content', 'lib', 'icons', 'app']) cpSync(resolve(ext, f), resolve(stage, f), { recursive: true })

  // 묶을 대상은 "." 가 아니라 이름을 하나씩 넘긴다. "." 로 묶으면 모든 항목 이름이 "./" 로 시작해 윈도우 탐색기가 읽지 못한다.
  // Windows 의 Compress-Archive 는 경로에 역슬래시를 써서 다른 OS 에서 깨지므로, Windows 내장 tar.exe(bsdtar)로 만든다(Git Bash 의 GNU tar 와 구별하려고 전체 경로 사용).
  const names = readdirSync(stage)
  const r =
    process.platform === 'win32'
      ? spawnSync(resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', out, '-C', stage, ...names], { stdio: 'inherit' })
      : spawnSync('zip', ['-qr', out, ...names], { cwd: stage, stdio: 'inherit' })
  if (r.status !== 0) throw new Error('zip 만들기에 실패했습니다')
  rmSync(stage, { recursive: true, force: true })

  assertPortableZip(zipEntryNames(out)) // 문제가 있으면 여기서 실패하고 배포 파일로 쓰지 못하게 한다
  console.log(`만들었습니다: ${out}`)
}
