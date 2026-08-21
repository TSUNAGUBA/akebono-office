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
  { key: 'reports', label: '日報' },
  // 週報・月報は独立機能キー（改修依頼 2026-08-20 第2バッチ。旧: 単一キー 'reports' に内包）。
  // 旧 'reports' 単一キー時代の保存済みルールは 0078 で新キーへ物理移行済み
  { key: 'weekly-report', label: '週報' },
  { key: 'monthly-report', label: '月報' },
  { key: 'ai-assistant', label: 'AI業務アシスタント（カレンダー連携含む）' },
  { key: 'poipoi', label: 'ぽいぽいポスト（改善のタネ）' },
  { key: 'minutes', label: '議事録' },
  { key: 'customer-log', label: '顧客活動' },
  { key: 'customer-context', label: '顧客コンテキスト' },
  // 営業管理（改善要望 2026-08-21・F-53/F-54）
  { key: 'sales-approach', label: '営業アプローチリスト' },
  { key: 'customer-dashboard', label: '顧客別ダッシュボード' },
  { key: 'support-activity', label: 'サポート活動' },
  { key: 'sales-activity', label: '営業活動' },
  { key: 'partner-activity', label: 'ビジネスパートナー活動' },
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
  { key: 'improvements', label: '改善要望管理' },
]

/** ページパス → 機能キー（フロントのメニュー・ルートガード用。null = ガード対象外 = 常に表示可）。
 *  クエリ・ハッシュ付きパス（例 /reports?date=2026-08-20 の通知ディープリンク）も
 *  正しく解決できるよう先頭のパス部分のみで判定する。 */
export function featureKeyOfPath(pathWithQuery: string): string | null {
  const path = pathWithQuery.split(/[?#]/)[0] ?? ''
  if (path === '/support/chatbot' || path.startsWith('/support/chatbot/')) return 'chatbot'
  if (path === '/support/documents' || path.startsWith('/support/documents/')) return 'documents'
  const seg = path.split('/')[1] ?? ''
  const known = [
    'timecard', 'attendance', 'shift', 'reports', 'weekly-report', 'monthly-report',
    'ai-assistant', 'workflow', 'decision', 'ai-company',
    'akebono', 'support', 'sales', 'status', 'inbox', 'masters', 'settings', 'poipoi', 'minutes', 'customer-log',
    'customer-context', 'improvements', 'support-activity', 'sales-activity', 'partner-activity',
    'sales-approach', 'customer-dashboard',
  ]
  return known.includes(seg) ? seg : null
}

// ---------- 週報・月報の機能キー独立（改修依頼 2026-08-20 第2バッチ → 継承撤去 2026-08-21） ----------

/**
 * 週報・月報はトップレベル機能（機能キー 'weekly-report' / 'monthly-report'）として日報（'reports'）
 * から独立した。当初は「新キーの明示ルールが無い間は旧 'reports' 設定を継承する」動的フォールバックで
 * 下位互換を取っていたが、**旧キーの deny が権限管理画面に表示されず解除もできない**
 * （権限表は ✓ なのに週報のタブが出ない）という実バグを生んだため、マイグレーション 0078 で
 * 旧 'reports' の weekly-* / monthly-* タブルールと機能レベルルールを新キーへ物理移行し、
 * 動的継承は撤去した（改善要望 2026-08-21）。以後、権限表に見えるルール = 実効ルール。
 * モックモードは日次再シードで旧形式ルールが翌日に残らないため移行処理は不要。
 *
 * resolveFeatureResource / resolveTabPermission は呼び出し側 I/F の互換のため残置（素通し）。
 * フロント（usePermissions.can / canTab）と API（featureGuard）は本ヘルパを共通で通る
 * （UI と API の判定一致。判定ロジックの SoT はこのファイル）。
 */

/**
 * 既読管理（/v1/reports/reads）の kind 別機能キー（改修依頼 2026-08-20 第2バッチ・レビュー R1）。
 * reads は 3 kind 混在の共用エンドポイントのためパスガードでなくハンドラ内で kind 単位に判定する
 * （'reports' 固定だと「日報 deny × 週報 allow」設定で週報・月報の既読管理まで 403 になる）
 */
export function reportReadsFeatureKey(kind: 'daily' | 'weekly' | 'monthly'): string {
  return kind === 'weekly' ? 'weekly-report' : kind === 'monthly' ? 'monthly-report' : 'reports'
}

/**
 * 機能利用可否の判定に使う実効リソースキー（canUseFeature へ渡す前に解決する）。
 * 旧 'reports' 継承の撤去（0078）後は素通し（呼び出し側 I/F 互換のため残置）
 */
export function resolveFeatureResource(_rules: PermissionRule[], resource: string): string {
  return resource
}

/**
 * タブ利用可否の判定に使う実効（リソース, タブキー）（canUseTab へ渡す前に解決する）。
 * 旧 'reports' 継承の撤去（0078）後は素通し（呼び出し側 I/F 互換のため残置）
 */
export function resolveTabPermission(
  _rules: PermissionRule[],
  resource: string,
  tabKey: string,
): { resource: string; tabKey: string } {
  return { resource, tabKey }
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
  { key: 'poipoi', label: 'ぽいぽいポスト（改善のタネ）', defaultScope: 'all' },
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

// ---------- 顧客活動の参照対象（撤去 = 改修依頼 2026-08-18） ----------
// 旧「顧客ログの参照対象」（resource='customer-log'・field='member:<id>' の許可制 =
// canViewMemberCustomerLog）は、改修依頼 2026-08-18「一覧は全メンバーの登録データを全員が閲覧できる」に
// 伴い撤去した。既存の当該ルールは migration 0066 で無効化（active=false = 監査可能な論理無効化）済み。
// 編集・取消の本人限定は permission_rules ではなく API/モックの所有チェック（AKO-CLG-002）が引き続き担う。

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

// ---------- タブメニュー単位の利用可否（改修依頼 2026-08-18: メニュー＞タブメニューの階層制御） ----------

/**
 * タブ利用可否の擬似フィールド（permission_rules.field = `tab:<タブキー>`）。
 * resource = 機能キー（ページ）・タブキーは shared/domain/permission-catalog.ts の
 * TAB_PERMISSION_CATALOG が SoT。既定 = allow（未設定環境では従来どおり全タブ表示 = 下位互換）。
 * 明示ルールが無いレイヤでは機能全体（field=null）のルールへフォールバックする（項目と同型）。
 */
export const TAB_FIELD_PREFIX = 'tab:'

/**
 * ページ内タブの利用可否（タブ表示・タブ内容ガード共通）。
 * 制限レイヤの原則: 管理者限定タブ（稟議の全件/経路設定等）のロールガードは本判定より優先で、
 * allow ルールを置いても非管理者へは開放されない（呼び出し側のロールガードが基底）。
 */
export function canUseTab(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
  tabKey: string,
): boolean {
  return resolve(rules, subject, resource, [`${TAB_FIELD_PREFIX}${tabKey}`, null])
}

// ---------- 項目の更新権限（改修依頼 2026-08-18: 項目＞参照/更新の階層制御） ----------

/**
 * 項目の更新可否の擬似フィールド（permission_rules.field = `<項目キー>:write`）。
 * 参照（canViewField）＞更新の階層: 参照 deny の項目は更新も不可（:write allow でも開かない）。
 * 既定 = allow（未設定環境では従来どおり参照可能な項目は更新も可能 = 下位互換）。
 * ':write' はカタログの物理キー（camelCase）と衝突しない予約サフィックス
 */
export const WRITE_FIELD_SUFFIX = ':write'

/**
 * 項目を更新できるか。参照不可なら常に更新不可（参照＞更新の階層）。
 * 参照可の場合のみ `<項目キー>:write` のルールをレイヤ解決する（明示 deny のみ更新を閉じる）
 */
export function canEditField(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
  field: string,
): boolean {
  if (!canViewField(rules, subject, resource, field)) return false
  return resolve(rules, subject, resource, [`${field}${WRITE_FIELD_SUFFIX}`])
}

/**
 * 更新 body から更新不可の項目キーを取り除く（API の PATCH・モックの更新処理共通）。
 * 対象 = ルールに現れた項目 ∪ カタログの全項目（stripDeniedFields と同じ考え方。
 * id・active 等のカタログ外キーは制御対象外）。全キーが剥がされて空になったかは呼び出し側で判定する
 */
export function stripDeniedWriteKeys<T extends Record<string, unknown>>(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
  body: T,
): T {
  const controlled = new Set<string>([
    ...rules.filter(r => r.active && r.resource === resource && r.field)
      .map(r => r.field as string)
      .map(f => (f.endsWith(WRITE_FIELD_SUFFIX) ? f.slice(0, -WRITE_FIELD_SUFFIX.length) : f)),
    ...(FIELD_CATALOG[resource] ?? []).map(f => f.value),
  ])
  const denied = Object.keys(body).filter(k => controlled.has(k) && !canEditField(rules, subject, resource, k))
  if (denied.length === 0) return body
  const copy = { ...body }
  for (const k of denied) delete (copy as Record<string, unknown>)[k]
  return copy
}

// ---------- AI の参照対象（改修依頼 2026-08-18: 「AIの参照範囲」タブ = 登録者単位の参照制御） ----------

/**
 * AI 参照対象の擬似フィールド（permission_rules.field = `ai-scope:<対象種別>:<値>`）。
 * resource = データ種類（機能キー）・対象 = `member:<id>` / `title:<役職名>` / `role:<ロール>`・
 * `ai-scope:*` = 全メンバー一括。effect: allow = その登録者のデータを AI が参照可 / deny = 不可。
 * 明示キー → 一括キー → レガシー二値（'ai-scope' = バッチ7g）の順で参照し、どのレイヤにも
 * ルールが無ければ**権限表の参照権限に基づく既定**（aiReferenceOwnerDefault）へフォールバックする
 * （改修依頼: 既定値は権限表の参照権限。AI参照範囲の設定を優先）
 */
export const AI_SCOPE_TARGET_PREFIX = 'ai-scope:'

/** AI 参照対象の全メンバー一括キー（権限表の member:* と同じ「一括 → 個別優先」の考え方） */
export const AI_SCOPE_TARGET_ALL_FIELD = 'ai-scope:*'

/**
 * 「AIの参照範囲」タブで設定できるデータ種類（メニュー単位）。
 * 本人スコープ（登録者）を持ち AI の文脈供給に使われるドメインのみ。
 * AI_SCOPE_FEATURES（レガシー二値）に日報・週報を加えた集合で、既定値は
 * aiReferenceOwnerDefault が権限表の参照権限から導出する
 */
export const AI_REFERENCE_DATATYPES: { key: string; label: string }[] = [
  { key: 'poipoi', label: 'ぽいぽいポスト（改善のタネ）' },
  { key: 'attendance', label: '勤怠（労働時間・有給）' },
  { key: 'ai-assistant', label: 'タスク計画' },
  { key: 'reports', label: '日報・週報' },
]

/**
 * AI 参照対象の既定値（ai-scope 系ルールがどのレイヤにも無い場合）= 権限表の参照権限に揃える。
 * - reports: 日報・週報の参照対象（canViewMemberReports = 既定 参照可・deny で絞る）
 * - ai-assistant: タスク計画の参照対象（canViewMemberTaskPlans = 既定 参照不可・allow 許可制）
 * - poipoi/attendance: レガシー既定（AI_SCOPE_FEATURES.defaultScope。all = 参照可 / own = 不可）
 */
function aiReferenceOwnerDefault(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
  ownerMemberId: string,
): boolean {
  if (resource === 'reports') return canViewMemberReports(rules, subject, ownerMemberId)
  if (resource === 'ai-assistant') return canViewMemberTaskPlans(rules, subject, ownerMemberId)
  return (AI_SCOPE_FEATURES.find(f => f.key === resource)?.defaultScope ?? 'own') === 'all'
}

/**
 * AI（チャットボット・業務アシスタント）が対象登録者のデータを文脈に含めてよいか。
 * 自分の登録データは常に参照可（設定ミスで本人のデータが AI から見えなくなる事故を防ぐ）。
 * 機能自体の deny（canUseFeature）が最優先である点は従来どおり（呼び出し側でガード済み）。
 * owner は登録者の属性（memberId・title・role）。解決順序:
 * 個人指定 → 役職指定 → ロール指定 → 全メンバー一括 → レガシー二値 → 権限表既定
 */
export function canAiReferenceOwner(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
  owner: PermissionSubject,
): boolean {
  if (owner.memberId === subject.memberId) return true
  const keys: (string | null)[] = [`${AI_SCOPE_TARGET_PREFIX}member:${owner.memberId}`]
  if (owner.title) keys.push(`${AI_SCOPE_TARGET_PREFIX}title:${owner.title}`)
  keys.push(`${AI_SCOPE_TARGET_PREFIX}role:${owner.role}`)
  keys.push(AI_SCOPE_TARGET_ALL_FIELD)
  keys.push(AI_SCOPE_FIELD)
  return resolve(rules, subject, resource, keys,
    aiReferenceOwnerDefault(rules, subject, resource, owner.memberId))
}

/**
 * 参照可能な登録者の memberId 一覧（SQL の `= ANY($ids)` やモックの filter 用ヘルパー）。
 * owners = 全登録者候補（通常は在籍メンバー全員）。自分は常に含まれる
 */
export function aiAllowedOwnerIds(
  rules: PermissionRule[],
  subject: PermissionSubject,
  resource: string,
  owners: PermissionSubject[],
): string[] {
  const ids = owners.filter(o => canAiReferenceOwner(rules, subject, resource, o)).map(o => o.memberId)
  if (!ids.includes(subject.memberId)) ids.push(subject.memberId)
  return ids
}

// ---------- 改善要望管理（F-42・オペレーター指示 2026-08-11 = 権限を持つ人のみ閲覧） ----------

/**
 * 改善要望の一覧・集約・ステータス管理ページ（/improvements）と管理系 API を閲覧・操作できるか。
 *
 * 要件「権限を持つ人のみが閲覧できる」= **既定は参照不可（deny-by-default）**。
 * 管理者は常時可（masters/settings と同思想 = 権限設定の編集手段を失わないためのロックアウト防止で、
 * かつ機微な要望データの初期閲覧者を管理者に限定する）。それ以外のロール/役職/個人へは
 * 権限設定（権限表・ルール一覧）で resource='improvements' の allow を付与して初めて閲覧できる。
 * 解決レイヤ（個人 > 役職 > ロール・同一レイヤ deny 優先）は canViewField と同一。
 *
 * 注: 要望の「投稿」（各ページの「要望を送る」）は認証済み全員が可能で、本ゲートの対象外。
 */
export function canManageImprovements(
  rules: PermissionRule[],
  subject: PermissionSubject,
): boolean {
  if (subject.role === 'admin') return true
  return resolve(rules, subject, 'improvements', [null], false)
}
