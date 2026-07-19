/**
 * 権限解決（F-16 権限制御・オペレーター指示 2026-07-17）。フロント/API で共有する純粋関数。
 *
 * 解決順序（レイヤ優先）: member（個人）> title（役職）> role（ロール）。
 * - 上位レイヤに該当ルールがあれば、そのレイヤの結果で確定する（個人の allow は役職/ロールの deny を上書き）
 * - 同一レイヤ内に allow と deny が両方あれば deny 優先
 * - どのレイヤにもルールがなければ **allow（既定）** = ルール未設定の環境では挙動が変わらない（下位互換）
 *
 * 安全方向の原則: 本ルールは既存のロールガード（admin/hr/member の API ガード）を緩められない
 * 「制限レイヤ」である。allow ルールは同レイヤ/下位レイヤの deny を打ち消すためのもので、
 * 既存ガードを超える権限は付与しない（設定ミスで権限昇格が起きない）。
 */
import type { PermissionRule } from './types'

/** 権限解決の対象者（member の該当判定に使う属性） */
export interface PermissionSubject {
  memberId: string
  /** 役職名（members.title。空文字 = 役職なし） */
  title: string
  role: 'admin' | 'hr' | 'member'
}

/** 機能キーのカタログ（管理 UI の選択肢・ページ/API ガードの共通語彙） */
export const FEATURE_PERMISSION_KEYS: { key: string; label: string }[] = [
  { key: 'attendance', label: '勤怠管理（休暇含む）' },
  { key: 'shift', label: 'シフト表' },
  { key: 'reports', label: '日報・週報' },
  { key: 'ai-assistant', label: 'AI業務アシスタント（カレンダー連携含む）' },
  { key: 'poipoi', label: 'ぽいぽいポスト' },
  { key: 'minutes', label: '議事録' },
  { key: 'workflow', label: 'ワークフロー・稟議' },
  { key: 'decision', label: '意思決定支援' },
  { key: 'ai-company', label: 'AIネイティブカンパニー' },
  { key: 'akebono', label: 'AKEBONO（3D オフィス）' },
  { key: 'support', label: '業務支援ツール（ハブ）' },
  { key: 'chatbot', label: 'AIチャットボット' },
  { key: 'documents', label: 'ドキュメント管理' },
  { key: 'sales', label: '売上管理' },
  { key: 'status', label: '提供システム稼働状況' },
  { key: 'inbox', label: '通知・エスカレーション' },
  { key: 'masters', label: 'マスタメンテナンス' },
  { key: 'settings', label: '設定' },
]

/** ページパス → 機能キー（フロントのメニュー・ルートガード用。null = ガード対象外 = 常に表示可） */
export function featureKeyOfPath(path: string): string | null {
  if (path === '/support/chatbot' || path.startsWith('/support/chatbot/')) return 'chatbot'
  if (path === '/support/documents' || path.startsWith('/support/documents/')) return 'documents'
  const seg = path.split('/')[1] ?? ''
  const known = [
    'attendance', 'shift', 'reports', 'ai-assistant', 'workflow', 'decision', 'ai-company',
    'akebono', 'support', 'sales', 'status', 'inbox', 'masters', 'settings', 'poipoi', 'minutes',
  ]
  return known.includes(seg) ? seg : null
}

/** ルールが対象者に該当するか（レイヤ判定は呼び出し側） */
function matches(rule: PermissionRule, subject: PermissionSubject): boolean {
  if (rule.subjectKind === 'member') return rule.subjectId === subject.memberId
  if (rule.subjectKind === 'title') return rule.subjectId !== '' && rule.subjectId === subject.title
  return rule.subjectId === subject.role
}

/** 1 レイヤ分の判定（deny 優先。該当ルールなしは null = 次レイヤへ） */
function decideLayer(rules: PermissionRule[]): boolean | null {
  if (rules.length === 0) return null
  return rules.every(r => r.effect === 'allow')
}

function resolve(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
  field: string | null,
): boolean {
  const applicable = rules.filter(r =>
    r.active && r.resource === resource && (r.field ?? null) === field && matches(r, subject))
  for (const kind of ['member', 'title', 'role'] as const) {
    const decided = decideLayer(applicable.filter(r => r.subjectKind === kind))
    if (decided !== null) return decided
  }
  return true // 既定 = allow（下位互換）
}

/** 機能の利用可否（メニュー表示・ページガード・API ガード共通） */
export function canUseFeature(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
): boolean {
  // admin のマスタ・設定はロックアウト防止のため deny を無視する（権限ルール自体の編集手段を失わない = 設計判断）
  if (subject.role === 'admin' && (resource === 'masters' || resource === 'settings')) return true
  return resolve(rules, subject, resource, null)
}

/** 表示項目の可否（resource = マスタエンティティキー等・field = 項目名） */
export function canViewField(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
  field: string,
): boolean {
  return resolve(rules, subject, resource, field)
}

/** オブジェクト配列から閲覧不可フィールドを取り除く（API レスポンス・モック共通の剥がし処理） */
export function stripDeniedFields<T extends Record<string, unknown>>(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
  rows: T[],
): T[] {
  const denied = [...new Set(
    rules
      .filter(r => r.active && r.resource === resource && r.field)
      .map(r => r.field as string),
  )].filter(f => !canViewField(rules, subject, resource, f))
  if (denied.length === 0) return rows
  return rows.map((row) => {
    const copy = { ...row }
    for (const f of denied) {
      if (f in copy) delete (copy as Record<string, unknown>)[f]
    }
    return copy
  })
}

// ---------- AI 参照範囲（バッチ7g・オペレーター指示 2026-07-19 #8/#9） ----------

/**
 * AI 参照範囲の擬似フィールド（permission_rules.field）。
 * resource = 機能キー・field = 'ai-scope'・effect: allow = すべて / deny = 自分の登録データのみ。
 * 既存のレイヤ解決（個人 > 役職 > ロール・同一レイヤ deny 優先）をそのまま使う
 */
export const AI_SCOPE_FIELD = 'ai-scope'

/**
 * AI 参照範囲を設定できるデータ（本人スコープを持つドメインのみ = それ以外は従来から権限準拠の全体参照）。
 * defaultScope = 未設定時の既定: ぽいぽいポストは「すべて」（オペレーター指示 #8 = 他メンバーの投稿も参照）、
 * 勤怠・タスク計画/カレンダーは「自分のみ」（C3 = 安全側。管理職等へは権限設定で「すべて」を付与する運用）
 */
export const AI_SCOPE_FEATURES: { key: string; label: string; defaultScope: 'all' | 'own' }[] = [
  { key: 'poipoi', label: 'ぽいぽいポスト', defaultScope: 'all' },
  { key: 'attendance', label: '勤怠（労働時間・有給）', defaultScope: 'own' },
  { key: 'ai-assistant', label: 'タスク計画・カレンダー', defaultScope: 'own' },
]

/**
 * AI の参照範囲（'all' = 権限範囲内のすべてのデータ / 'own' = 自分の登録データのみ）。
 * チャットボット・AI業務アシスタントの文脈供給が参照する。機能自体の deny（canUseFeature）が最優先
 * （機能が使えないユーザーの AI には当該ドメインを一切供給しない = 従来どおり）
 */
export function aiReferenceScope(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
): 'all' | 'own' {
  const def = AI_SCOPE_FEATURES.find(f => f.key === resource)?.defaultScope ?? 'own'
  const applicable = rules.filter(r =>
    r.active && r.resource === resource && (r.field ?? null) === AI_SCOPE_FIELD && matches(r, subject))
  for (const kind of ['member', 'title', 'role'] as const) {
    const layer = applicable.filter(r => r.subjectKind === kind)
    if (layer.length > 0) return layer.every(r => r.effect === 'allow') ? 'all' : 'own'
  }
  return def
}
