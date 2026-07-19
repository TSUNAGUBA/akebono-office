/**
 * カードメニューのレジストリ（バッチ7h・オペレーター指示 2026-07-19 #10。SoT）。
 * ダッシュボード / マスタハブのカード定義と既定カテゴリをここに一元定義する
 * （従来は各ページの computed にハードコード = 分散。原則3）。
 * バッジ・機能トグル・権限のランタイム反映は各ページが行う（このファイルは静的定義のみ）。
 *
 * カテゴリのカスタマイズ（追加・削除・名称変更・カード割当）は configs
 * （`menu-categories-<area>`）に保存し、useMenuCategories が解決する。
 * どのカテゴリにも割り当てられていないカードは自動的に「その他」へ入る（新機能のカードが消えない）。
 */

export const MENU_AREAS = ['dashboard', 'masters'] as const
export type MenuArea = (typeof MENU_AREAS)[number]

export interface MenuCardDef {
  id: string
  title: string
  description: string
  icon: string
  to: string
  /** useAppSettings.isEnabled のキー（無効時は非表示） */
  featureToggle?: string
  /** 管理者にのみ表示 */
  adminOnly?: boolean
}

export interface MenuCategoryDef {
  id: string
  label: string
  cardIds: string[]
}

/** 未割当カードの自動カテゴリ（削除・改名不可。設定 UI では割当先の変更のみ） */
export const OTHER_CATEGORY_ID = 'other'
export const OTHER_CATEGORY_LABEL = 'その他'

export const MENU_CARDS: Record<MenuArea, MenuCardDef[]> = {
  dashboard: [
    { id: 'decision', title: '意思決定支援', description: 'AI が意味・関係・制約を整理し、選択肢と根拠を提示', icon: 'Scale', to: '/decision', featureToggle: 'decision' },
    { id: 'akebono', title: 'AKEBONO', description: 'あなた専属の AI アシスタント。要望も受付中', icon: 'Sunrise', to: '/akebono', featureToggle: 'akebono' },
    { id: 'attendance', title: '勤怠管理', description: '打刻・月次集計・36 協定アラート・休暇', icon: 'Clock', to: '/attendance' },
    { id: 'shift', title: 'シフト表', description: '希望提出・調整・確定シフトの確認', icon: 'CalendarRange', to: '/shift', featureToggle: 'shift' },
    { id: 'reports', title: '日報・週報', description: '日々の報告とチームの提出状況', icon: 'NotebookPen', to: '/reports' },
    { id: 'ai-assistant', title: 'AI業務アシスタント', description: '明日の計画と当日の振り返りを AI と。日報へ自動反映', icon: 'Sparkles', to: '/ai-assistant' },
    { id: 'poipoi', title: 'ぽいぽいポスト', description: '気づき・改善アイデアを投げ込むポスト。AI の参照対象・管理者はチーム改善のため閲覧可', icon: 'StickyNote', to: '/poipoi' },
    { id: 'minutes', title: '議事録', description: '会議の記録を蓄積。全員が参照でき AI の参照対象', icon: 'NotebookPen', to: '/minutes' },
    { id: 'workflow', title: 'ワークフロー', description: '稟議の申請・承認（職務権限マトリクス準拠）', icon: 'GitPullRequestArrow', to: '/workflow' },
    { id: 'ai-company', title: 'AIネイティブカンパニー', description: 'AI 社員の執務室。タスク依頼と活動モニタリング', icon: 'Building2', to: '/ai-company', featureToggle: 'aiCompany' },
    { id: 'sales', title: '売上管理', description: '月次売上の推移・前年比・事業種別/顧客別の内訳', icon: 'TrendingUp', to: '/sales' },
    { id: 'status', title: '提供システム稼働状況', description: '提供システムの現在状態・稼働率・インシデント履歴', icon: 'Activity', to: '/status', featureToggle: 'status' },
    { id: 'support', title: '業務支援ツール', description: 'AI チャットボット・ドキュメント管理・外部ツール', icon: 'Wrench', to: '/support' },
    { id: 'inbox', title: '通知・エスカレーション', description: '通知の確認と、現場からの暗黙の情報共有への対応', icon: 'Inbox', to: '/inbox' },
    { id: 'masters', title: 'マスタメンテナンス', description: 'メンバー・部署・顧客・案件・休暇種別等の基礎データ管理', icon: 'Database', to: '/masters', adminOnly: true },
    { id: 'settings', title: '設定', description: 'カスタム項目・汎用区分・外部リンク・機能トグル・監査ログ', icon: 'Settings', to: '/settings', adminOnly: true },
  ],
  masters: [
    { id: 'members', title: 'メンバー', description: '氏名・雇用区分・部門・週所定・打刻対象・ロール', icon: 'Users', to: '/masters/members' },
    { id: 'departments', title: '部署・組織図', description: '部署の階層・責任者・メンバーの所属。組織図の表示', icon: 'Network', to: '/masters/departments' },
    { id: 'titles', title: '役職', description: 'メンバー登録の役職選択肢（追加・表示順・無効化）', icon: 'IdCard', to: '/masters/titles' },
    { id: 'permissions', title: '権限設定', description: 'ロール・役職・個人の 3 レイヤで機能と表示項目・AI 参照・日報参照を制御', icon: 'ShieldCheck', to: '/masters/permissions' },
    { id: 'leave-types', title: '休暇種別', description: '有給・夏季休暇・結婚特休等の種別と付与方式・使用期限', icon: 'CalendarHeart', to: '/masters/leave-types' },
    { id: 'holidays', title: '祝日', description: '内閣府の公式データ取込と手動管理。翌営業日計算・カレンダーへ反映', icon: 'CalendarDays', to: '/masters/holidays' },
    { id: 'company', title: '自社', description: '自社の会社情報・会計年度開始月（他社展開時の差し替え点）', icon: 'Building', to: '/masters/company' },
    { id: 'customers', title: '顧客(会社)', description: '会社名・業界（複数+主）・エイリアス・規模・担当', icon: 'Building2', to: '/masters/customers' },
    { id: 'contacts', title: '顧客(人)', description: '氏名・所属会社・キーパーソン度・連絡先・メモ', icon: 'Contact', to: '/masters/contacts' },
    { id: 'relations-company', title: '顧客関係(会社)', description: '会社間の関係エッジ（納品先・競合など）。グラフ可視化', icon: 'Network', to: '/masters/relations-company' },
    { id: 'relations-contact', title: '顧客関係(人)', description: '人どうしの関係エッジ（上司部下・紹介など）。グラフ可視化', icon: 'Network', to: '/masters/relations-contact' },
    { id: 'relation-types', title: '関係種別', description: '顧客関係で使う関係の種類の定義（追加・編集・削除）', icon: 'Tags', to: '/masters/relation-types' },
    { id: 'industries', title: '業界', description: '業界名と表示順。直交軸で管理（複合値を作らない）', icon: 'Factory', to: '/masters/industries' },
    { id: 'projects', title: 'プロジェクト', description: 'PJ 名・顧客・種別・状態・担当・期間・予算・目的', icon: 'FolderKanban', to: '/masters/projects' },
    { id: 'work-categories', title: '業務種別', description: 'ぽいぽいポスト・議事録の分類。名称と表示順', icon: 'Tags', to: '/masters/work-categories' },
    { id: 'knowledge', title: 'ナレッジ', description: '5 ドメイン（業界/会社/人/関係/PJ）に紐付く記事と裁定還流', icon: 'BookOpen', to: '/masters/knowledge' },
    { id: 'settings', title: 'カスタム項目・区分値', description: 'カスタム項目・区分値の定義は設定画面で管理します', icon: 'Settings2', to: '/settings' },
  ],
}

/** 既定カテゴリ（ダッシュボードは従来のセクション構成・マスタは領域別の新設分類） */
export const DEFAULT_MENU_CATEGORIES: Record<MenuArea, MenuCategoryDef[]> = {
  dashboard: [
    { id: 'decision', label: '意思決定支援', cardIds: ['decision'] },
    { id: 'akebono', label: 'AKEBONO', cardIds: ['akebono'] },
    { id: 'work', label: '業務ツール', cardIds: ['attendance', 'shift', 'reports', 'ai-assistant', 'poipoi', 'minutes', 'workflow'] },
    { id: 'ai-company', label: 'AIネイティブカンパニー', cardIds: ['ai-company'] },
    { id: 'insights', label: '経営・状況', cardIds: ['sales', 'status'] },
    { id: 'support', label: '業務支援', cardIds: ['support', 'inbox'] },
    { id: 'admin', label: '管理', cardIds: ['masters', 'settings'] },
  ],
  masters: [
    { id: 'org', label: '組織・権限', cardIds: ['members', 'departments', 'titles', 'permissions'] },
    { id: 'hr', label: '勤怠・休暇', cardIds: ['leave-types', 'holidays'] },
    { id: 'crm', label: '会社・顧客', cardIds: ['company', 'customers', 'contacts', 'relations-company', 'relations-contact', 'relation-types', 'industries'] },
    { id: 'biz', label: '業務・ナレッジ', cardIds: ['projects', 'work-categories', 'knowledge', 'settings'] },
  ],
}
