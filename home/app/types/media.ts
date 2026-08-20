/**
 * メディア分析ドメイン型（モックモード = モックコレクション / API モード = DB テーブル 0030_media + 0048_media_channels）。
 *
 * メディア分析は **独立したメディアチャンネル（MediaChannel）** を単位に動く（オペレーター指示 2026-08-03）。
 * 任意で「どの Akebono 業務アプリ（= 業態 business_segment）と連携するか」を設定できる（連携は必須でない）。
 * - 未連携（segmentId = null）: メディア単体で分析・記事生成・単体 AI インサイトが動く
 * - 連携済み（segmentId あり）: 加えて業務 × メディアの統合 PDCA（売上 × 流入）が利用できる
 *
 * - 集計・洞察・記事生成の純ロジックは shared/domain/media-*（フロント/API 共有）が SoT（opaque id を受け取る）
 * - 本ファイルは「保存されるエンティティ」の形（チャンネル・記事インベントリ・生成物・依頼・外部記事）を定義する
 * - GA 連携・AI 分析設定はチャンネル設定画面（/media/settings）で画面操作のみで完結する
 * - API モードの SoT: GA 接続状態 = media_ga_tokens（/v1/media/status）・チャンネル設定 = media_channels・
 *   記事インベントリ = media_articles・生成物/依頼 = media_generated_articles / media_article_briefs・
 *   外部記事 = media_external_articles。全て channelId で keying する
 */
import type {
  ArticlePurpose, ArticleQuality, ArticleTone, GeneratedArticleDraft,
} from '../../../shared/domain/media-article'

/** メディア分析の目的（チャンネル設定。AI 分析・記事生成の既定に使う） */
export type MediaGoal = 'awareness' | 'leadgen' | 'nurturing' | 'conversion' | 'branding' | 'retention'

export const MEDIA_GOALS: MediaGoal[] = ['awareness', 'leadgen', 'nurturing', 'conversion', 'branding', 'retention']

/**
 * メディアチャンネル（旧 MediaSetting を置換・拡張。設定系・チャンネル 1 レコード = upsert）。
 * GA 連携の接続状態と AI 分析設定を保持する。すべて任意既定を持ち、未設定でも安全に動く（原則7）。
 * モックモードは擬似 OAuth（このレコードが接続状態の SoT）。
 * API モードは Google OAuth 2.0（analytics.readonly）で、接続状態の SoT はサーバー
 * （media_ga_tokens → /v1/media/status）。useMediaChannels が両者を同一形へ合成する。
 */
export interface MediaChannel {
  id: string
  /** チャンネル表示名（必須） */
  name: string
  /** 連携先 Akebono 業務アプリ（業態 BusinessSegment.id）。null = 単体（業態未連携） */
  segmentId: string | null
  siteName: string
  siteUrl: string
  // ---- Google Analytics 連携（モック = このレコードが SoT / API = サーバーの status を反映） ----
  gaConnected: boolean
  /** GA4 プロパティ ID（例: properties/123456789） */
  gaPropertyId: string | null
  gaPropertyName: string | null
  gaConnectedAt: string | null
  // ---- AI 分析設定 ----
  analysisGoal: MediaGoal
  /** ターゲット読者像（記事生成・インサイトの前提） */
  targetAudience: string
  /** 既定の記事トーン（記事生成フォームの初期値） */
  defaultTone: ArticleTone
  /** 重点キーワード・テーマ */
  keywords: string[]
  active: boolean
}

/**
 * サイトのコンテンツ資産（記事）= GA の page に対応するインベントリ。
 * 分析（deriveMediaMetrics）の入力になり、生成記事の採用でここへ追加される。
 */
export interface MediaArticle {
  id: string
  channelId: string
  path: string
  title: string
  /** セクション（サイト構成の第 1 階層。例: ブログ / サービス / 導入事例） */
  section: string
  publishedAt: string
  wordCount: number
  status: 'published' | 'draft'
  /** seed = 既存資産 / generated = AI 生成物を採用したもの */
  origin: 'seed' | 'generated'
  /** origin=generated のとき、元の生成記事 */
  generatedArticleId: string | null
  active: boolean
}

/** 記事生成の依頼（フォーム入力の保存。生成物と 1:1） */
export interface ArticleBrief {
  id: string
  channelId: string
  topic: string
  keyword: string
  purpose: ArticlePurpose
  quality: ArticleQuality
  tone: ArticleTone
  audience: string
  /** 過去分析から生成した場合の参照（MediaInsightRecord.id） */
  fromInsightId: string | null
  createdAt: string
  createdBy: string
}

/**
 * 生成された記事（ドラフト）。採用（インベントリ登録）・取消（論理削除）は composable が管理する（原則9.5）。
 * 生成ロジックの結果（GeneratedArticleDraft）に保存用メタを付与した形。
 */
export interface GeneratedArticle extends GeneratedArticleDraft {
  id: string
  channelId: string
  briefId: string
  createdAt: string
  createdBy: string
  /** 採用してインベントリ化したか（採用時に生成される MediaArticle.id） */
  adoptedArticleId: string | null
  /** 論理削除（取消）。復元可能 */
  active: boolean
  /** Vertex AI 生成か（API モードのみ。モック・フォールバックは false/未設定 = 決定的生成） */
  llm?: boolean
}

/**
 * 外部で投稿した記事の原文（media インサイト生成の材料）。
 * 外部媒体・SNS 等に投稿した記事の本文を保管し、AI 分析（media インサイト生成）に活用する。
 * 論理削除（active=false）で取消・復元できる（原則9.5）。
 */
export interface MediaExternalArticle {
  id: string
  channelId: string
  /** タイトル（必須） */
  title: string
  /** 投稿先 URL（任意） */
  url: string
  /** 媒体名など（任意） */
  source: string
  /** 公開日（任意。YYYY-MM-DD） */
  publishedAt: string | null
  /** 原文（必須。AI 分析に使う） */
  body: string
  /** 任意メモ */
  notes: string
  createdAt: string
  createdBy: string
  /** 論理削除（取消/復元 = 原則9.5） */
  active: boolean
}
