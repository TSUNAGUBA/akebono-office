# Phase 4: 技術スタック確定

- **作成日:** 2026-07-15
- **作成ロール:** 壁打ちナビゲーター（コーディングエージェント・システム監査官の視点で協議）

## 決定サマリ

| レイヤー | 採用 | バージョン方針 |
|---|---|---|
| フレームワーク | **Nuxt 4（SPA モード `ssr: false`）** | undeux-sales-suite と同系（nuxt ^4.x） |
| 言語 | TypeScript（`<script setup lang="ts">` + Composition API） | strict |
| スタイル | **Tailwind CSS v4（`@tailwindcss/vite`）+ CSS 変数デザイントークン** | tokutake の globals 一元化方式を Vue に適用 |
| チャート | **Chart.js 4 + vue-chartjs 5** | undeux と同一（プラグイン一括登録パターン） |
| アイコン | **lucide-vue-next** | オペレーター指定。絵文字アイコン禁止 |
| ルーティング | Nuxt pages（ファイルベース）+ ハッシュモード | 静的配信でそのまま動作させるため |
| 状態管理 | Nuxt `useState` + composables（Pinia 不使用） | 兄弟リポジトリと同じ最小構成 |
| モックデータ | 決定的シード生成（`Math.random` 禁止）+ localStorage 永続化 | akebono-scm-platform mockup 規範を踏襲 |
| テスト/検証 | `nuxi typecheck`（vue-tsc）+ ビルド成功 + ユーティリティの単体テスト（vitest） | モック段階の最低ライン |
| 配置 | リポジトリ直下 `mockup/` | akebono-scm-platform と同じ配置慣例 |

## 選定理由（要件との対応）

1. **Nuxt 4 SPA**: CLAUDE.md の技術スタック確認ポイントが Nuxt/Vue を前提としており、兄弟リポジトリ undeux-sales-suite（nuxt 4.4.x SPA）と規約を揃えることで将来の資産相互流用（components/composables）が効く。SSR は不要（社内アプリ・モック）であり `ssr: false` で Firestore 等の将来統合時の複雑性も回避。
2. **composables 中心の状態管理**: オペレーター要件「画面コントロールや処理部分はできるだけ再利用可能な components や composables として」に直結。Pinia を足さないのは兄弟リポジトリとの一貫性と依存最小化（開発原則 3）。
3. **Tailwind v4 + CSS 変数トークン**: 「洗練されたシンプル」なデザインをトークン 1 箇所（`app/assets/css/main.css`）で統制し、他社展開時のテーマ差し替えを容易にする。
4. **Chart.js**: undeux で KPI/推移/構成の実装パターンが確立済み。売上サマリ・勤怠集計・稼働率で再利用。
5. **決定的モックデータ**: リロードしても同じ世界が再現され、レビュー・体感評価が安定する（scm-platform `rng.ts` 方式）。ユーザー操作による変更のみ localStorage に差分保存し、「リセット」でシード状態へ戻せる（冪等性・状態保護の体感導線）。
6. **3D オフィス空間**: モック段階では**CSS/SVG によるアイソメトリック表現**を採用（three.js 等の重量依存を追加しない）。本番で WebGL 化する場合も、AI 社員の状態モデル（composable）はそのまま使える境界設計とする。

## 不採用の検討記録

| 候補 | 不採用理由 |
|---|---|
| Vite + Vue 3 素構成（scm-platform mockup と同一） | 本アプリは将来そのまま本番 UI に育てる前提があり、Nuxt の規約（pages/layouts/auto-import）が middle〜long term で有利。undeux で Nuxt 4 実績あり |
| Next.js + React（tokutake 方式） | CLAUDE.md・他兄弟リポジトリの Vue 系規約と乖離。composables 資産の相互流用ができない |
| three.js（3D オフィス） | モック目的に対して依存が過大。操作の体感はアイソメトリック表現で十分得られる |
| Pinia / Vuex | useState + composables で足りる規模。兄弟リポジトリも不使用 |
| ECharts（scm-platform 方式） | undeux の Chart.js パターンの方が本アプリの KPI/カード UI に近く、バンドルも軽い |

## インフラ・将来構成（宣言のみ）

- 本番想定: Firebase Hosting または S3+CDN で静的配信 + API バックエンド（.NET or Node/Cloud Run。Phase 7 で確定）+ PostgreSQL（`app_office` 業務スキーマ + `mart` 分析スキーマ）
- 分析基盤: akebono-scm-platform の `mart` スキーマ規約に準拠（phase5/data-design.md）

## ゲート判定（Phase 4）

- 全レイヤーの技術が確定: ✅
- 各選定に要件ベースの理由: ✅
- インフラが非機能要件と整合: ✅（モック段階の宣言 + 将来構成）

**判定: PASS（AI 判定。オペレーター最終承認は PR レビューにて）**
