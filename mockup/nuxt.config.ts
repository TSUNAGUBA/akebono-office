import tailwindcss from '@tailwindcss/vite'

// モックアップは SPA + ハッシュルーティング（静的配信でそのまま動作させるため）
export default defineNuxtConfig({
  ssr: false,
  compatibilityDate: '2025-05-01',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    public: {
      /** API モード切替（NUXT_PUBLIC_API_BASE。空 = 従来どおりの完全モック動作） */
      apiBase: '',
      /** dev 認証（NUXT_PUBLIC_DEV_MEMBER_ID。ローカル・E2E 専用。x-dev-member-id で送出） */
      devMemberId: '',
      /** Firebase Web アプリ設定 JSON（NUXT_PUBLIC_FIREBASE_CONFIG。API モードのログインに使用） */
      firebaseConfig: '',
    },
  },
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
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },
})
