import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// 대시보드(extension.html)와 팝업(popup.html)을 extension/app/ 으로 빌드한다. 확장은 extension/ 폴더를 압축해제 로드한다.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'extension/app',
    emptyOutDir: true,
    assetsInlineLimit: 0, // 확장 CSP(script-src 'self')와 폰트 로딩을 위해 파일로 둔다
    rollupOptions: { input: { extension: resolve(import.meta.dirname, 'extension.html'), popup: resolve(import.meta.dirname, 'popup.html') } },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'tests/e2e-ext/**', 'node_modules/**'],
    testTimeout: 60000,
  },
})
