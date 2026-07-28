/**
 * メディア分析ドメインの純関数ユーティリティ（Vue 非依存・ラベル SoT・単体テスト対象）。
 * ラベル・セクション選択肢・セグメント既定のメディア設定生成をここに集約する。
 */
import {
  ARTICLE_PURPOSES, ARTICLE_QUALITIES, ARTICLE_TONES,
  articlePurposeLabel, articleQualityLabel, articleToneLabel,
  type ArticlePurpose, type ArticleQuality, type ArticleTone,
} from '../../../shared/domain/media-article'
import type { MediaFindingKind } from '../../../shared/domain/media-insight'
import type { IndustryType } from '~/types/akebono'
import type { MediaGoal, MediaSetting } from '~/types/media'
import type { Tone } from '~/types/ui'

// 記事生成の区分は shared/domain/media-article が SoT。画面からは utils/media 経由で参照する（深い相対パスの回避）
export {
  ARTICLE_PURPOSES, ARTICLE_QUALITIES, ARTICLE_TONES,
  articlePurposeLabel, articleQualityLabel, articleToneLabel,
}
export type { ArticlePurpose, ArticleQuality, ArticleTone }

/** select 用の選択肢（value = 区分値・label = 日本語） */
export const ARTICLE_PURPOSE_OPTIONS = ARTICLE_PURPOSES.map(v => ({ value: v, label: articlePurposeLabel(v) }))
export const ARTICLE_QUALITY_OPTIONS = ARTICLE_QUALITIES.map(v => ({ value: v, label: articleQualityLabel(v) }))
export const ARTICLE_TONE_OPTIONS = ARTICLE_TONES.map(v => ({ value: v, label: articleToneLabel(v) }))

export const MEDIA_GOAL_LABELS: Record<MediaGoal, string> = {
  awareness: '認知拡大',
  leadgen: 'リード獲得',
  nurturing: '顧客育成',
  conversion: 'コンバージョン',
  branding: 'ブランディング',
  retention: 'リテンション',
}

export const MEDIA_GOALS_LIST: MediaGoal[] = ['awareness', 'leadgen', 'nurturing', 'conversion', 'branding', 'retention']
export const MEDIA_GOAL_OPTIONS = MEDIA_GOALS_LIST.map(v => ({ value: v, label: MEDIA_GOAL_LABELS[v] }))

/** サイト構成のセクション選択肢（記事インベントリの section で使う） */
export const MEDIA_SECTION_CHOICES = ['ブログ', 'コラム', 'サービス', '導入事例', 'お知らせ', '料金', 'トップ'] as const

/** インサイト分類 → バッジトーン（U-2: 状態は色で直感表示。色だけに頼らずラベル併記） */
export function findingTone(kind: MediaFindingKind): Tone {
  return kind === 'win' ? 'ok' : kind === 'issue' ? 'warn' : 'brand'
}
export const FINDING_KIND_LABELS: Record<MediaFindingKind, string> = {
  win: '好調', issue: '課題', opportunity: '機会',
}

/** 優先度 → トーン */
export function priorityTone(priority: 'high' | 'mid' | 'low'): Tone {
  return priority === 'high' ? 'crit' : priority === 'mid' ? 'warn' : 'info'
}
export const PRIORITY_LABELS: Record<'high' | 'mid' | 'low', string> = { high: '高', mid: '中', low: '低' }

// ---------- セグメント既定のメディア設定（1:1 ペアリングの初期化。原則1） ----------

const INDUSTRY_GOAL: Record<IndustryType, MediaGoal> = {
  retail: 'conversion', maker: 'leadgen', logistics: 'awareness', it_service: 'leadgen', other: 'awareness',
}
const INDUSTRY_TONE: Record<IndustryType, ArticleTone> = {
  retail: 'friendly', maker: 'formal', logistics: 'formal', it_service: 'expert', other: 'formal',
}

/**
 * セグメントに対する既定のメディア設定を生成する（未設定セグメントの初回・シードで共有）。
 * GA は未連携（画面操作で連携）を既定にする。id は呼び出し側（採番）で確定する。
 */
export function defaultMediaSetting(
  segment: { id: string; name: string; industryType: IndustryType },
  id: string,
): MediaSetting {
  return {
    id,
    segmentId: segment.id,
    siteName: `${segment.name} オウンドメディア`,
    siteUrl: '',
    gaConnected: false,
    gaPropertyId: null,
    gaPropertyName: null,
    gaConnectedAt: null,
    analysisGoal: INDUSTRY_GOAL[segment.industryType],
    targetAudience: '',
    defaultTone: INDUSTRY_TONE[segment.industryType],
    keywords: [],
    active: true,
  }
}
