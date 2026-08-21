/**
 * AI ナレッジベース（KB）の型定義（フロント/API 共有。テクニカルライター成果物）。
 *
 * - 形式の SoT は方法論 .ai-native/methodology/roles/technical-writer.md の
 *   §KB_DOCUMENT_FORMAT（1 ドキュメント = 1 トピック = 1 RAG チャンク・フロントマター相当のメタ）。
 *   本モジュールはそのメタ項目（id / category / audience / feature / version /
 *   last_updated / related）を TypeScript の型として保持する。
 * - 物理配置は .ai-native/outputs/knowledge-base/*.md ではなく shared/domain/kb/ 配下の
 *   TS データモジュールとする（設計判断・ナビゲーター決定）: API バンドルへの同梱・
 *   モック側からの import・MD/TS の二重管理回避のため。
 * - category は KB_DOCUMENT_FORMAT の 4 分類（user-guide / ops-guide / troubleshooting / faq）に
 *   「spec」（アプリ仕様の要約 = 改善要望の AI 判定・RAG の背景知識）を追加した 5 値。
 */

/** ドキュメント分類（spec = アプリ仕様要約。他 4 値は KB_DOCUMENT_FORMAT 準拠） */
export type KbCategory = 'spec' | 'user-guide' | 'ops-guide' | 'troubleshooting' | 'faq'

/** 想定読者（end-user = 一般利用者 / ops-admin = 運用管理者 / both = 両方） */
export type KbAudience = 'end-user' | 'ops-admin' | 'both'

/** ナレッジベースの 1 ドキュメント（= 1 トピック = 1 RAG チャンク） */
export interface KbDoc {
  /** kb-{sp|ug|og|ts|faq}-{3 桁連番}（カテゴリと接頭辞は 1:1 対応） */
  id: string
  category: KbCategory
  audience: KbAudience
  /** 対応する機能 ID（例: 'F-42'）。特定機能に紐付かない場合は 'general' */
  feature: string
  title: string
  /** 関連するアプリ内ページパス（実在ルートのみ。該当なしは []） */
  pagePaths: string[]
  /** 検索補助語（同義語・言い換え。5〜12 語） */
  keywords: string[]
  /** マークダウン本文（KB_DOCUMENT_FORMAT のテンプレート構成に従う） */
  body: string
  version: string
  /** YYYY-MM-DD */
  lastUpdated: string
  /** 関連ドキュメント id（実在する id のみ） */
  related: string[]
}
