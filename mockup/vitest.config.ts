import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
  // プロジェクトの tsconfig は .nuxt 生成物に依存するため、テストでは読み込まない
  esbuild: {
    tsconfigRaw: '{"compilerOptions":{"target":"esnext","verbatimModuleSyntax":true}}',
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
