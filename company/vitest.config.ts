import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // SFC のコンポーネントテスト用（UiMarkdown 等。Nuxt 経由の既存依存 = 新規追加なし）
  plugins: [vue()],
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
