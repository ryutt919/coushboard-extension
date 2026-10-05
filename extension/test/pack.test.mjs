// 배포 zip 검사: 항목 이름이 "./" 로 시작하면 윈도우 탐색기가 zip 안을 비어 있다고 보거나 풀지 못한다(v0.2.0 ~ v0.3.0 의 문제).
// 실행: node extension/test/pack.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { assertPortableZip, zipEntryNames } from "../../scripts/pack-ext.mjs";

// 압축 없이 저장하는 가장 단순한 zip 을 만든다(이름 검사만 보면 되므로)
function storedZip(names) {
  const parts = [], central = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name), data = Buffer.from("x"), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(1, 18); local.writeUInt32LE(1, 22); local.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(1, 20); cd.writeUInt32LE(1, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, n]));
    parts.push(local, n, data); offset += 30 + n.length + 1;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

const dir = mkdtempSync(join(tmpdir(), "pack-test-"));
const make = (names) => { const f = join(dir, `${Math.random().toString(36).slice(2)}.zip`); writeFileSync(f, storedZip(names)); return f; };
try {
  // 이름을 그대로 읽어 온다(한글 이름 포함)
  assert.deepEqual(zipEntryNames(make(["manifest.json", "app/", "app/extension.html", "icons/한글.png"])), ["manifest.json", "app/", "app/extension.html", "icons/한글.png"]);

  // 정상: 루트에 manifest.json, "./" 없음
  assertPortableZip(zipEntryNames(make(["manifest.json", "background.js", "content/", "content/collector.js", "app/assets/a.js"])));

  // v0.2.0 ~ v0.3.0 의 zip: 모든 항목이 "./" 로 시작 -> 탐색기에서 비어 보임
  assert.throws(() => assertPortableZip(zipEntryNames(make(["./", "./manifest.json", "./app/", "./app/extension.html"]))), /탐색기에서 풀 수 없는 항목 이름/);
  // 일부만 "./" 여도, 역슬래시나 절대 경로도 막는다
  assert.throws(() => assertPortableZip(["manifest.json", "./lib/a.js"]), /탐색기/);
  assert.throws(() => assertPortableZip(["manifest.json", "app\\a.js"]), /탐색기/);
  assert.throws(() => assertPortableZip(["manifest.json", "/etc/a"]), /탐색기/);
  // manifest.json 이 루트에 없으면(폴더 안에 있으면) 막는다
  assert.throws(() => assertPortableZip(["coushboard-extension/manifest.json"]), /루트에 manifest.json/);
  // zip 이 아닌 파일
  const notZip = join(dir, "x.zip"); writeFileSync(notZip, "not a zip");
  assert.throws(() => zipEntryNames(notZip), /끝 구조/);
  console.log("OK: 배포 zip 이름 검사(./ 접두사, 역슬래시, 절대 경로, 루트 manifest.json)");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
