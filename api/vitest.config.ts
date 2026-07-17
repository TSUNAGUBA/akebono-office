import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 統合テスト（test/integration/**）は DATABASE_URL 必須のため
    // npm run test:integration（test/run-integration.sh）経由で実行する
  },
})
