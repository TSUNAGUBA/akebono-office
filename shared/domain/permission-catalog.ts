/**
 * 権限設定（F-16-1）の項目カタログ。フロント（ルール一覧・権限表）と API（マスタ全体
 * deny 時の項目剥がし = stripDeniedFields）で共有する SoT（バッチ7m で home/app/utils から移動）。
 * 物理キー = shared/domain/types.ts の各インターフェース（id・active・カスタム項目は制御対象外）
 */

/** フィールド制御に使えるマスタエンティティ（resource キー = API エンティティキー） */
export const FIELD_RESOURCES: { key: string; label: string }[] = [
  { key: 'members', label: 'メンバー' },
  { key: 'companies', label: '自社・顧客(会社)' },
  { key: 'contacts', label: '顧客(人)' },
  { key: 'projects', label: 'プロジェクト' },
  { key: 'knowledge', label: 'ナレッジ' },
  { key: 'documents', label: 'ドキュメント' },
]

/** 項目キーの論理名カタログ */
export const FIELD_CATALOG: Record<string, { value: string; label: string }[]> = {
  members: [
    { value: 'name', label: '氏名' },
    { value: 'email', label: 'メールアドレス' },
    { value: 'employmentType', label: '雇用区分' },
    { value: 'departmentId', label: '所属部署' },
    { value: 'title', label: '役職' },
    { value: 'role', label: '権限ロール' },
    { value: 'hireDate', label: '入社日' },
    { value: 'weeklyDays', label: '週所定日数' },
    { value: 'weeklyHours', label: '週所定時間' },
    { value: 'punchRequired', label: '打刻要否' },
    { value: 'googleCalendarConnected', label: 'カレンダー連携状態' },
    { value: 'attendanceRuleId', label: '勤務体系' },
    { value: 'birthDate', label: '生年月日' },
    { value: 'avatar', label: 'プロフィール画像' },
  ],
  companies: [
    { value: 'kind', label: '区分（自社/顧客）' },
    { value: 'name', label: '会社名' },
    { value: 'aliases', label: '別名' },
    { value: 'industryIds', label: '業界' },
    { value: 'primaryIndustryId', label: '主業界' },
    { value: 'size', label: '規模' },
    { value: 'location', label: '所在地' },
    { value: 'description', label: '概要' },
    { value: 'ownerMemberId', label: '自社担当' },
    { value: 'fiscalStartMonth', label: '会計年度開始月' },
  ],
  contacts: [
    { value: 'companyId', label: '所属会社' },
    { value: 'name', label: '氏名' },
    { value: 'dept', label: '部署' },
    { value: 'title', label: '役職' },
    { value: 'keyPerson', label: 'キーパーソン度' },
    { value: 'email', label: 'メールアドレス' },
    { value: 'phone', label: '電話番号' },
    { value: 'notes', label: 'メモ' },
  ],
  projects: [
    { value: 'name', label: 'プロジェクト名' },
    { value: 'companyId', label: '顧客（会社）' },
    { value: 'type', label: '種別' },
    { value: 'status', label: '状態' },
    { value: 'priority', label: '優先度' },
    { value: 'ownerMemberId', label: '担当者' },
    { value: 'memberIds', label: '参画メンバー' },
    { value: 'startDate', label: '開始日' },
    { value: 'endDate', label: '終了日' },
    { value: 'budget', label: '予算' },
    { value: 'objective', label: '目的' },
  ],
  knowledge: [
    { value: 'domain', label: 'ドメイン' },
    { value: 'targetId', label: '対象' },
    { value: 'title', label: 'タイトル' },
    { value: 'body', label: '本文' },
    { value: 'tags', label: 'タグ' },
    { value: 'source', label: '出典' },
    { value: 'sourceRefId', label: '出典参照' },
    { value: 'updatedAt', label: '更新日時' },
  ],
  // ドキュメント管理（バッチ7l）。summary の deny = 本文相当（抽出テキスト・原本ダウンロード・URL）も不可
  documents: [
    { value: 'name', label: 'ファイル名' },
    { value: 'tags', label: 'タグ' },
    { value: 'summary', label: '概要・本文（抽出テキスト/原本を含む）' },
  ],
}

/**
 * タブメニュー単位の権限カタログ（改修依頼 2026-08-18: メニュー（ページ）＞タブメニューの階層制御）。
 * ここに載せたページのタブは、権限表で `tab:<key>` の擬似フィールドとして利用可否を制御できる
 * （既定 allow・機能全体〔field=null〕のルールへフォールバック = 項目と同型）。
 * - 管理者限定タブ（稟議の全件/経路設定・シフトの調整/募集期間）はロールガードが基底で、
 *   権限ルールは deny 方向にのみ働く（allow で非管理者へ開放はできない = 制限レイヤの原則）。
 * - 勤怠（attendance）のタブは既存の専用擬似フィールド（timecard-all）が担うため本カタログの対象外。
 * - inbox のカテゴリタブは通知タブ設定（useNotificationTabs）が担うため対象外。
 */
export const TAB_PERMISSION_CATALOG: Record<string, { key: string; label: string }[]> = {
  // 改修依頼 2026-08-20 第2バッチ: 週報・月報を独立機能キー（weekly-report / monthly-report）へ分離
  // （旧: 単一キー reports に weekly-*/monthly-* タブキーを内包 = 2026-08-19 第4弾）。
  // 旧 reports の weekly-*/monthly-* タブキーの保存済みルールは、当初は解決層の動的継承で互換を
  // 取っていたが権限表から見えない deny を生むため、0078 で新キーへ物理移行した（2026-08-21）。
  reports: [
    { key: 'mine', label: '自分の日報' },
    { key: 'all', label: '全員の日報' },
    { key: 'team', label: 'チーム' },
  ],
  'weekly-report': [
    { key: 'mine', label: '自分の週報' },
    { key: 'all', label: '全員の週報' },
    { key: 'team', label: 'チーム' },
  ],
  'monthly-report': [
    { key: 'mine', label: '自分の月報' },
    { key: 'all', label: '全員の月報' },
    { key: 'team', label: 'チーム' },
  ],
  workflow: [
    { key: 'mine', label: '自分の申請' },
    { key: 'pending', label: '承認待ち' },
    { key: 'all', label: '全件' },
    { key: 'routes', label: '経路設定' },
  ],
  // 改修依頼 2026-08-20: タブを 受付箱（inbox）/ 改修案件（items）の 2 つへ再編し、カンバン/ガントは
  // 各タブ内の表示切替（?view=）へ移行。旧タブキー（req-kanban/req-gantt/kanban/gantt）は
  // 既存の permission_rules（field='tab:<旧キー>'）を無効化しないため**表示切替の利用可否**として残す
  // （improvements.vue が view の選択肢を canTab(旧キー) でゲートする = 旧 deny ルールがそのまま効く。原則7）。
  improvements: [
    { key: 'inbox', label: '受付箱' },
    { key: 'items', label: '改修案件' },
    { key: 'req-kanban', label: '受付箱: カンバン表示' },
    { key: 'req-gantt', label: '受付箱: ガント表示' },
    { key: 'kanban', label: '改修案件: カンバン表示' },
    { key: 'gantt', label: '改修案件: ガント表示' },
  ],
  shift: [
    { key: 'confirmed', label: '確定シフト' },
    { key: 'wish', label: '希望提出' },
    { key: 'adjust', label: '調整' },
    { key: 'periods', label: '募集期間' },
  ],
}

/** タブキーの論理名（カタログ外はキーをそのまま表示） */
export function tabLabel(feature: string, tabKey: string): string {
  const hit = TAB_PERMISSION_CATALOG[feature]?.find(t => t.key === tabKey)?.label
  if (hit) return hit
  // 旧 reports リソースの週報・月報タブキー（0078 移行前の inactive 履歴行の表示互換 = 原則7）
  if (feature === 'reports') {
    const m = /^(weekly|monthly)-(mine|all|team)$/.exec(tabKey)
    if (m) {
      const label = TAB_PERMISSION_CATALOG[`${m[1]}-report`]?.find(t => t.key === m[2])?.label
      if (label) return `${label}（旧キー）`
    }
  }
  return tabKey
}

/** 項目キーの論理名（カタログ外 = 過去に手入力された物理名などはそのまま表示） */
export function fieldLabel(resource: string, field: string | null | undefined): string {
  if (!field) return ''
  if (field === 'ai-scope') return 'AI 参照範囲' // バッチ7g の擬似フィールド（shared AI_SCOPE_FIELD）
  if (field === 'timecard-all') return '全員のタイムカードの参照' // 2026-07-22 の擬似フィールド（shared TIMECARD_ALL_FIELD）
  // タブ利用可否の擬似フィールド（tab:<key> = 改修依頼 2026-08-18）
  if (field.startsWith('tab:')) return `タブ: ${tabLabel(resource, field.slice('tab:'.length))}`
  // 項目の更新権限の擬似フィールド（<item>:write = 改修依頼 2026-08-18。参照/更新の階層）
  if (field.endsWith(':write')) {
    const base = field.slice(0, -':write'.length)
    return `${FIELD_CATALOG[resource]?.find(f => f.value === base)?.label ?? base}（更新）`
  }
  // AI 参照対象の擬似フィールド（ai-scope:<対象> = 改修依頼 2026-08-18。「AIの参照範囲」タブで設定）
  if (field.startsWith('ai-scope:')) {
    const target = field.slice('ai-scope:'.length)
    if (target === '*') return 'AI参照対象: 全メンバー（一括既定）'
    const [kind, ...rest] = target.split(':')
    const id = rest.join(':')
    const kindLabel = kind === 'role' ? 'ロール' : kind === 'title' ? '役職' : kind === 'member' ? '個人' : kind
    const roleLabel = id === 'admin' ? '管理者' : id === 'hr' ? '人事' : id === 'member' ? '一般' : id
    return `AI参照対象: ${kindLabel}=${kind === 'role' ? roleLabel : id}`
  }
  return FIELD_CATALOG[resource]?.find(f => f.value === field)?.label ?? field
}
