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
 * 保存値（JSON 配列）をパース。カタログに存在する id のみ・重複除去。
 * 未設定・不正 JSON は null（= 設定なし）。空配列は「クイックアクセスを出さない」設定として尊重する。
 */
export function parseQuickAccessIds(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return null
    const seen = new Set<string>()
    const ids: string[] = []
    for (const x of v) {
      if (typeof x === 'string' && CATALOG_IDS.has(x) && !seen.has(x)) {
        seen.add(x)
        ids.push(x)
      }
    }
    return ids
  } catch {
    return null
  }
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
