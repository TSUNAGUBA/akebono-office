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
  // 通知（ベルアイコン）もアプリヘッダー設定の候補にする（改修依頼 2026-08-18）。
  // レイアウトヘッダーは本 id を「未読バッジ付きベル」として特別描画する（一般のページ導線とは別枠）
  { id: 'inbox', label: '通知', icon: 'Bell', to: '/inbox' },
  { id: 'attendance', label: '勤怠管理', icon: 'Clock', to: '/attendance' },
  { id: 'reports', label: '日報', icon: 'NotebookPen', to: '/reports' },
  { id: 'workflow', label: '稟議', icon: 'GitPullRequestArrow', to: '/workflow' },
  { id: 'customer-log', label: '顧客活動', icon: 'MessageSquare', to: '/customer-log' },
  { id: 'ai-assistant', label: 'AI業務アシスタント', icon: 'Sparkles', to: '/ai-assistant' },
  { id: 'shift', label: 'シフト表', icon: 'CalendarRange', to: '/shift', featureKey: 'shift' },
  { id: 'sales', label: '売上管理', icon: 'TrendingUp', to: '/sales' },
  // AIチャットボット・改善のタネ（旧称: ぽいぽいポスト）を候補に追加（改善要望 2026-08-17）
  { id: 'chatbot', label: 'AIチャットボット', icon: 'Bot', to: '/support/chatbot', featureKey: 'chatbot' },
  { id: 'poipoi', label: 'ぽいぽいポスト', icon: 'StickyNote', to: '/poipoi' },
]

/** 既定のクイックアクセス（従来のヘッダー = タイムカード + 通知ベル。ユーザー/組織が未設定のときの表示） */
export const DEFAULT_QUICK_ACCESS_IDS = ['timecard', 'inbox']

/**
 * 保存形式のバージョン。v1（素の id 配列）は「通知（inbox）が候補になる前」の保存値のため、
 * パース時に 'inbox' を補完する（当時はベルが常時表示 = 見えていた状態を維持する下位互換。原則7）。
 * v2（`{ v: 2, ids: [...] }`）は「通知を外す」選択を保存できる（補完しない）。
 */
export const QUICK_ACCESS_FORMAT_VERSION = 2

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

/** カタログに存在する id のみ・重複除去（parse の共通後処理） */
function sanitizeIds(arr: unknown[]): string[] {
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

/**
 * 保存値をパース。カタログに存在する id のみ・重複除去。
 * 未設定・不正値は null（= 設定なし）。空配列は **v2（`{ v: 2, ids: [] }`）でのみ**「クイックアクセスを
 * 出さない」設定として尊重する（v1 の空配列は inbox 補完により「ベルのみ」= 保存当時の見え方の維持）。
 *
 * 保存経路の二態を両方受理する（parseDashboardLayout と同じ流儀）:
 *  - mock / localStorage: JSON 文字列（例 '["timecard"]'）
 *  - API モード: /v1/me の prefs は JSONB のためデシリアライズ済みの配列/オブジェクトがそのまま渡る
 * 文字列だけを前提にすると、API モードで配列が来たときに null 扱いになり設定が反映されない（実障害）。
 *
 * 保存形式の二態（下位互換 = 原則7）:
 *  - v1（素の id 配列）: 「通知（inbox）」が候補になる前の保存値。当時はベルが常時表示だったため
 *    'inbox' を末尾に補完し、保存時に見えていた表示を維持する
 *  - v2（`{ v: 2, ids: [...] }`）: 現行形式。保存値をそのまま尊重する（'inbox' を外す選択が可能）
 */
export function parseQuickAccessIds(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return null
    try { value = JSON.parse(raw) } catch { return null }
  }
  if (Array.isArray(value)) {
    const ids = sanitizeIds(value)
    if (!ids.includes('inbox')) ids.push('inbox') // v1 互換: ベル常時表示時代の保存値
    return ids
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    // バージョンは完全一致のみ受理する。未知の将来版（v3 等）を v2 として誤読すると、
    // 形式変更で ids が全滅 →「何も表示しない」設定と誤解釈される。null = 既定へフォールバックが安全
    if (rec.v === QUICK_ACCESS_FORMAT_VERSION && Array.isArray(rec.ids)) {
      return sanitizeIds(rec.ids)
    }
  }
  return null
}

/** 保存用の v2 形式（`{ v: 2, ids }`）へシリアライズ（persist の共通経路。JSON 化は呼び出し側） */
export function serializeQuickAccessIds(ids: string[]): { v: number; ids: string[] } {
  return { v: QUICK_ACCESS_FORMAT_VERSION, ids: sanitizeIds(ids) }
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
