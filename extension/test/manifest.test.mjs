// manifest 가 가리키는 아이콘 파일이 실제로 있고, 이름에 적힌 크기의 정사각형 PNG 인지 확인한다. 실행: node extension/test/manifest.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf-8"));

const png = (path) => {
  const b = readFileSync(resolve(dir, path)); // 없으면 여기서 던진다
  assert.equal(b.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${path}: PNG 가 아님`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), alpha: b[25] === 6 };
};

for (const [name, icons] of [["icons", manifest.icons], ["action.default_icon", manifest.action.default_icon]]) {
  assert.deepEqual(Object.keys(icons).sort(), ["128", "16", "32", "48"], `${name}: 크기 목록`);
  for (const [size, path] of Object.entries(icons)) {
    const { w, h, alpha } = png(path);
    assert.equal(w, +size, `${path}: 너비`);
    assert.equal(h, +size, `${path}: 높이`);
    assert.ok(alpha, `${path}: 투명 배경(RGBA)이어야 함`);
  }
}
assert.equal(manifest.manifest_version, 3);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
console.log(`OK: manifest v${manifest.version} 아이콘 4종(16, 32, 48, 128) 확인`);
