/**
 * メディア分析ドメイン型（永続化 = モックコレクション / 本実装 = DB テーブル）。
 * Akebono 業務の「事業セグメント（業態）」と 1:1 で対になる（segmentId 参照）。
 *
 * - 集計・洞察・記事生成の純ロジックは shared/domain/media-*（フロント/API 共有）が SoT
 * - 本ファイルは「保存されるエンティティ」の形（設定・記事インベントリ・生成物・依頼）を定義する
 * - GA 連携・AI 分析設定は各セグメントの設定画面（/media/settings）で画面操作のみで完結する
 */
import type {
  ArticlePurpose, ArticleQuality, ArticleTone, GeneratedArticleDraft,
} from '../../../shared/domain/media-article'

/** メディア分析の目的（セグメント設定。AI 分析・記事生成の既定に使う） */
export type MediaGoal = 'awareness' | 'leadgen' | 'nurturing' | 'conversion' | 'branding' | 'retention'

export const MEDIA_GOALS: MediaGoal[] = ['awareness', 'leadgen', 'nurturing', 'conversion', 'branding', 'retention']

/**
 * セグメント（業態）ごとのメディア設定（設定系・1 セグメント 1 レコード = upsert）。
 * GA 連携（擬似 OAuth の接続状態 = アプリ側が SoT）と AI 分析設定を保持する。
 * すべて任意既定を持ち、未設定でも安全に動く（原則7）。
 */
export interface MediaSetting {
  id: string
  /** 対象セグメント（BusinessSegment.id）。一意 */
  segmentId: string
  siteName: string
  siteUrl: string
  // ---- Google Analytics 連携（擬似 OAuth。接続状態の SoT はアプリ側） ----
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
  segmentId: string
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
  segmentId: string
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
  segmentId: string
  briefId: string
  createdAt: string
  createdBy: string
  /** 採用してインベントリ化したか（採用時に生成される MediaArticle.id） */
  adoptedArticleId: string | null
  /** 論理削除（取消）。復元可能 */
  active: boolean
}
