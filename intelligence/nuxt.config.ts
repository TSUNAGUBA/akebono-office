import tailwindcss from '@tailwindcss/vite'

// AKEBONO Intelligence（経営・顧客・案件の分析とフィードバックループ）。SPA + ハッシュルーティング（home と同型）
export default defineNuxtConfig({
  ssr: false,
  compatibilityDate: '2025-05-01',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    public: {
      /** API モード切替（NUXT_PUBLIC_API_BASE。空 = 完全モック動作） */
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
      title: 'AKEBONO Intelligence',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: '経営・顧客・案件の分析インサイトとフィードバックループ' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },
})
