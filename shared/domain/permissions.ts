/**
 * 権限解決（F-16 権限制御・オペレーター指示 2026-07-17）。フロント/API で共有する純粋関数。
 *
 * 解決順序（レイヤ優先）: member（個人）> title（役職）> role（ロール）。
 * - 上位レイヤに該当ルールがあれば、そのレイヤの結果で確定する（個人の allow は役職/ロールの deny を上書き）
 * - 同一レイヤ内に allow と deny が両方あれば deny 優先
 * - 同一レイヤ内では明示キー（項目・対象メンバー）→ 一括キー（マスタ全体 = field null・全メンバー =
 *   member:*）の順で参照する（バッチ7m: 権限表の階層一括設定。個別設定が一括設定より優先）
 * - どのレイヤにもルールがなければ **既定値**（canUseFeature/canViewField/日報参照 = allow・
 *   AI業務アシスタント参照 = deny の許可制）= ルール未設定の環境では挙動が変わらない（下位互換）
 *
 * 安全方向の原則: 本ルールは既存のロールガード（admin/hr/member の API ガード）を緩められない
 * 「制限レイヤ」である。allow ルールは同レイヤ/下位レイヤの deny を打ち消すためのもので、
 * 既存ガードを超える権限は付与しない（設定ミスで権限昇格が起きない）。
 */
import { FIELD_CATALOG } from './permission-catalog'
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
  { key: 'timecard', label: 'タイムカード（自分の打刻）' },
  { key: 'attendance', label: '勤怠管理（休暇含む）' },
  { key: 'shift', label: 'シフト表' },
  { key: 'reports', label: '日報・週報' },
  { key: 'ai-assistant', label: 'AI業務アシスタント（カレンダー連携含む）' },
  { key: 'poipoi', label: 'ぽいぽいポスト' },
  { key: 'minutes', label: '議事録' },
  { key: 'workflow', label: '稟議' },
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
    'timecard', 'attendance', 'shift', 'reports', 'ai-assistant', 'workflow', 'decision', 'ai-company',
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

/**
 * fieldKeys は「明示キー → 一括キー」の順（例: ['email', null] / ['member:m-01', 'member:*']）。
 * 同一レイヤ内で明示キーのルールがあればそれで確定し、無ければ一括キーへフォールバックする。
 * どちらかで確定したレイヤがあれば下位レイヤは見ない（レイヤ優先は従来どおり）
 */
function resolve(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
  fieldKeys: (string | null)[],
  defaultAllow = true,
): boolean {
  const applicable = rules.filter(r => r.active && r.resource === resource && matches(r, subject))
  for (const kind of ['member', 'title', 'role'] as const) {
    const layer = applicable.filter(r => r.subjectKind === kind)
    for (const key of fieldKeys) {
      const decided = decideLayer(layer.filter(r => (r.field ?? null) === key))
      if (decided !== null) return decided
    }
  }
  return defaultAllow // 既定（下位互換 = allow。閲覧許可制のリソースは deny を既定にする）
}

/** 機能の利用可否（メニュー表示・ページガード・API ガード共通） */
export function canUseFeature(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
): boolean {
  // admin のマスタ・設定はロックアウト防止のため deny を無視する（権限ルール自体の編集手段を失わない = 設計判断）
  if (subject.role === 'admin' && (resource === 'masters' || resource === 'settings')) return true
  return resolve(rules, subject, resource, [null])
}

/**
 * 表示項目の可否（resource = マスタエンティティキー等・field = 項目名）。
 * 項目に明示ルールが無いレイヤでは「マスタ全体」（同一 resource・field=null）のルールへ
 * フォールバックする（バッチ7m: 権限表のマスタ全体行 = 全項目の一括既定。個別項目の設定が優先）。
 * resource が機能キーでもある documents では field=null ルール = 機能利用可否と共用（設計判断:
 * 機能を止めたドキュメントは項目も既定で隠れる。個別項目 allow で例外を作れる）
 */
export function canViewField(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
  field: string,
): boolean {
  return resolve(rules, subject, resource, [field, null])
}

/** オブジェクト配列から閲覧不可フィールドを取り除く（API レスポンス・モック共通の剥がし処理） */
export function stripDeniedFields<T extends Record<string, unknown>>(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
  rows: T[],
): T[] {
  // 判定候補 = ルールに現れた項目 ∪ カタログの全項目。カタログ分を含めるのは「マスタ全体
  // （field=null）deny」が個別ルールなしで全項目に及ぶため（id・active 等のカタログ外キーは
  // 従来どおり制御対象外 = ルールで名指しされた場合のみ）
  const denied = [...new Set([
    ...rules.filter(r => r.active && r.resource === resource && r.field).map(r => r.field as string),
    ...(FIELD_CATALOG[resource] ?? []).map(f => f.value),
  ])].filter(f => !canViewField(rules, subject, resource, f))
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
  // 'all' で供給されるのはチームのタスク計画のみ（カレンダー予定は本人分に限る）。ラベルは実挙動に合わせる
  { key: 'ai-assistant', label: 'タスク計画', defaultScope: 'own' },
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
  return resolve(rules, subject, resource, [AI_SCOPE_FIELD], def === 'all') ? 'all' : 'own'
}

// ---------- 日報・週報の参照対象（バッチ7h・オペレーター指示 2026-07-19 #10 = F-16-6。2026-07-22 で週報にも適用） ----------

/**
 * 日報・週報の参照対象の擬似フィールド（permission_rules.field）。
 * resource = 'reports'・field = `member:<対象メンバー id>`・effect: deny = その対象者の日報を参照不可。
 * 未設定 = 参照可（下位互換 = 従来の「提出済みは全員参照可」を維持）。解決は canViewField と同一
 */
export const REPORT_MEMBER_FIELD_PREFIX = 'member:'

/**
 * 参照対象（日報・AI業務アシスタント）の全メンバー一括キー（バッチ7m: 権限表の階層一括設定）。
 * 対象メンバー個別の明示ルールが無いレイヤでは本キーのルールへフォールバックする
 * （例: role=member に reports/member:* deny + 個人に member:<id> allow で「既定参照不可・例外許可」）。
 * '*' はメンバー id として発番されない前提の予約値
 */
export const MEMBER_VIEW_ALL_FIELD = 'member:*'

/**
 * 対象メンバーの日報（提出済み）を参照できるか。
 * 自分の日報は常に参照可（deny ルールの設定ミスで本人の記録が見えなくなる事故を防ぐ）。
 * 適用範囲: チームマトリクス・全員の日報・全員の週報・詳細表示・API の日報/週報一覧・チャットボットの他人日報文脈
 */
export function canViewMemberReports(
  rules: PermissionRule[],
  subject: PermissionSubject,
  targetMemberId: string,
): boolean {
  if (targetMemberId === subject.memberId) return true
  return resolve(rules, subject, 'reports',
    [`${REPORT_MEMBER_FIELD_PREFIX}${targetMemberId}`, MEMBER_VIEW_ALL_FIELD])
}

// ---------- AI業務アシスタントの参照対象（F-14・オペレーター指示 2026-07-21 = F-16-7） ----------

/**
 * AI業務アシスタント（タスク計画・振り返り）の参照対象の擬似フィールド（permission_rules.field）。
 * resource = 'ai-assistant'・field = `member:<対象メンバー id>`・effect: allow = その対象者のページを readonly 参照可。
 *
 * 日報（canViewMemberReports）との違い: 日報は「提出済みは全員参照可」が既定（deny で絞る）だが、
 * AI業務アシスタントは個人の作業計画・振り返りのため **既定は参照不可**（allow で明示的に許可する）。
 * 自分のページは常に参照可。解決レイヤ（個人 > 役職 > ロール・同一レイヤ deny 優先）は canViewField と同一。
 */
export const ASSIST_MEMBER_FIELD_PREFIX = 'member:'

/**
 * 対象メンバーの AI業務アシスタントページ（タスク計画・振り返り）を readonly 参照できるか。
 * 自分のページは常に参照可。既定 = 参照不可（allow ルールで明示的に許可した対象者のみ）。
 * 適用範囲: AI業務アシスタントページの対象メンバー切替（readonly 表示）・API の他メンバー計画/ログ取得。
 */
export function canViewMemberTaskPlans(
  rules: PermissionRule[],
  subject: PermissionSubject,
  targetMemberId: string,
): boolean {
  if (targetMemberId === subject.memberId) return true
  return resolve(rules, subject, 'ai-assistant',
    [`${ASSIST_MEMBER_FIELD_PREFIX}${targetMemberId}`, MEMBER_VIEW_ALL_FIELD], false)
}

// ---------- 全員のタイムカードの参照（オペレーター指示 2026-07-22） ----------

/**
 * 全員のタイムカード（勤怠管理の全メンバー出退勤一覧）の参照可否の擬似フィールド
 * （permission_rules.field）。resource = 'attendance'・field = 'timecard-all'。
 * 既定 = 管理者/人事のみ参照可（従来のロールガードと同値 = 下位互換）。
 * 権限表の明示ルールで一般メンバーへの許可・人事からの剥奪ができる（レイヤ解決は canViewField と同一）
 */
export const TIMECARD_ALL_FIELD = 'timecard-all'

/** 全員のタイムカードの参照可否の既定値（明示ルールが無い場合。= 従来の管理者/人事ガード） */
export function timecardAllDefault(role: PermissionSubject['role']): boolean {
  return role === 'admin' || role === 'hr'
}

/** 全員のタイムカード（一覧・サーバー集計 API）を参照できるか */
export function canViewAllTimecards(
  rules: PermissionRule[],
  subject: PermissionSubject,
): boolean {
  return resolve(rules, subject, 'attendance', [TIMECARD_ALL_FIELD], timecardAllDefault(subject.role))
}
