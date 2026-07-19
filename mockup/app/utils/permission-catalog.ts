/**
 * 権限設定（F-16-1）の項目カタログ。ルール一覧モードと権限表モードで共有する
 * （オペレーター指示 2026-07-19: 論理名選択 / 同 #2: 権限表モード）。
 * 物理キー = shared/domain/types.ts の各インターフェース（id・active・カスタム項目は制御対象外）
 */

/** フィールド制御に使えるマスタエンティティ（resource キー = API エンティティキー） */
export const FIELD_RESOURCES: { key: string; label: string }[] = [
  { key: 'members', label: 'メンバー' },
  { key: 'companies', label: '自社・顧客(会社)' },
  { key: 'contacts', label: '顧客(人)' },
  { key: 'projects', label: 'プロジェクト' },
  { key: 'knowledge', label: 'ナレッジ' },
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
}

/** 項目キーの論理名（カタログ外 = 過去に手入力された物理名などはそのまま表示） */
export function fieldLabel(resource: string, field: string | null | undefined): string {
  if (!field) return ''
  if (field === 'ai-scope') return 'AI 参照範囲' // バッチ7g の擬似フィールド（shared AI_SCOPE_FIELD）
  return FIELD_CATALOG[resource]?.find(f => f.value === field)?.label ?? field
}
