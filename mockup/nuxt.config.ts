import tailwindcss from '@tailwindcss/vite'

// モックアップは SPA + ハッシュルーティング（静的配信でそのまま動作させるため）
export default defineNuxtConfig({
  ssr: false,
  compatibilityDate: '2025-05-01',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  vite: {
    plugins: [tailwindcss()],
  },
  router: {
    options: {
      hashMode: true,
    },
  },
  app: {
    head: {
      htmlAttrs: { lang: 'ja' },
      title: 'AKEBONO Office',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'TSUNAGUBA 社内オフィスアプリ（モックアップ）' },
      ],
    },
  },
})
