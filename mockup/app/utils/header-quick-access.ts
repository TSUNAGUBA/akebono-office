/**
 * ヘッダーのクイックアクセス（ヘッダーカスタマイズ）。純ロジック（候補カタログ・パース・解決）の SoT。
 *
 * 解決順 = ユーザー設定 > 組織（テナント）設定 > 既定。ユーザー個人設定が優先（オペレーター指示）。
 * 永続化はデュアルモード（useHeaderQuickAccess）: ユーザー層 = /v1/me pref（mock=localStorage）/
 * テナント層 = configs `header-quick-access`。新 API ルート/マイグレーションは不要（既存の汎用 key/value を利用）。
 */

export interface QuickAccessItem {
  id: string
  label: string
  icon: string // lucide アイコン名
  /** 遷移先（未指定 = 特殊アクション） */
  to?: string
  /** 特殊アクション（punch = ヘッダーの打刻モーダルを開く） */
  action?: 'punch'
  /** 機能トグルのキー（無効時は候補から除外） */
  featureKey?: string
  /** 権限判定に使うパス（未指定は to を使用。特殊アクションは fallbackPath を指定） */
  permPath?: string
}

/** 候補カタログ（ヘッダーに出せるクイックアクセスの全集合）。ページ導線 SoT（navigation.ts）と整合させる */
export const QUICK_ACCESS_CATALOG: QuickAccessItem[] = [
  { id: 'timecard', label: 'タイムカード', icon: 'Clock3', action: 'punch', permPath: '/attendance' },
  { id: 'attendance', label: '勤怠管理', icon: 'Clock', to: '/attendance' },
  { id: 'reports', label: '日報・週報', icon: 'NotebookPen', to: '/reports' },
  { id: 'workflow', label: '稟議', icon: 'GitPullRequestArrow', to: '/workflow' },
  { id: 'customer-log', label: '顧客ログ', icon: 'MessageSquare', to: '/customer-log' },
  { id: 'ai-assistant', label: 'AI業務アシスタント', icon: 'Sparkles', to: '/ai-assistant' },
  { id: 'shift', label: 'シフト表', icon: 'CalendarRange', to: '/shift', featureKey: 'shift' },
  { id: 'sales', label: '売上管理', icon: 'TrendingUp', to: '/sales' },
  // AIチャットボット・改善のタネ（旧称: ぽいぽいポスト）を候補に追加（改善要望 2026-08-17）
  { id: 'chatbot', label: 'AIチャットボット', icon: 'Bot', to: '/support/chatbot', featureKey: 'chatbot' },
  { id: 'poipoi', label: '改善のタネ', icon: 'StickyNote', to: '/poipoi' },
]

/** 既定のクイックアクセス（従来のヘッダー = タイムカードのみ。ユーザー/組織が未設定のときの表示） */
export const DEFAULT_QUICK_ACCESS_IDS = ['timecard']

const CATALOG_IDS = new Set(QUICK_ACCESS_CATALOG.map(i => i.id))

/** id → カタログ項目 */
export function quickAccessItemOf(id: string): QuickAccessItem | undefined {
  return QUICK_ACCESS_CATALOG.find(i => i.id === id)
}

/** 権限判定に使うパス（特殊アクションは permPath、それ以外は to） */
export function quickAccessPermPath(item: QuickAccessItem): string | undefined {
  return item.permPath ?? item.to
}

export type QuickAccessScope = 'user' | 'tenant' | 'default'

/**
 * 保存値をパース。カタログに存在する id のみ・重複除去。
 * 未設定・不正値は null（= 設定なし）。空配列は「クイックアクセスを出さない」設定として尊重する。
 *
 * 保存経路の二態を両方受理する（parseDashboardLayout と同じ流儀）:
 *  - mock / localStorage: JSON 文字列（例 '["timecard"]'）
 *  - API モード: /v1/me の prefs は JSONB のためデシリアライズ済みの配列がそのまま渡る
 * 文字列だけを前提にすると、API モードで配列が来たときに null 扱いになり設定が反映されない（実障害）。
 */
export function parseQuickAccessIds(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null
  let arr: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return null
    try { arr = JSON.parse(raw) } catch { return null }
  }
  if (!Array.isArray(arr)) return null
  const seen = new Set<string>()
  const ids: string[] = []
  for (const x of arr) {
    if (typeof x === 'string' && CATALOG_IDS.has(x) && !seen.has(x)) {
      seen.add(x)
      ids.push(x)
    }
  }
  return ids
}

/** 解決: ユーザー > テナント > 既定 */
export function resolveQuickAccessIds(
  userRaw: unknown,
  tenantRaw: unknown,
): { ids: string[]; scope: QuickAccessScope } {
  const u = parseQuickAccessIds(userRaw)
  if (u) return { ids: u, scope: 'user' }
  const t = parseQuickAccessIds(tenantRaw)
  if (t) return { ids: t, scope: 'tenant' }
  return { ids: [...DEFAULT_QUICK_ACCESS_IDS], scope: 'default' }
}
