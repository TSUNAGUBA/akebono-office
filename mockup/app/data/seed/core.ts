/**
 * 中核マスタのシードデータ（決定的・固定値）
 * 第 1 適用 = TSUNAGUBA 自社（業務コンサル / システムコンサル / システム開発・運用）
 */
import type {
  AiEmployee, AiRole, AttendanceRule, CodeMasterItem, Company, CompanyRelation,
  Contact, ContactRelation, CustomFieldDef, EscalationRule, ExternalLink,
  FeatureToggle, Industry, KnowledgeArticle, Member, Project, RelationType,
  SystemService, WorkflowRoute,
} from '~/types/domain'

export const seedMembers: Member[] = [
  { id: 'm-01', name: '山下 誠', email: 'yamashita@tsunaguba.co.jp', employmentType: 'director', dept: '経営管理部', title: '代表取締役', role: 'admin', hireDate: '2018-04-01', weeklyDays: 5, weeklyHours: 40, punchRequired: false, birthDate: '1980-06-15', active: true, custom: {} },
  { id: 'm-02', name: '佐伯 玲子', email: 'saeki@tsunaguba.co.jp', employmentType: 'director', dept: '経営管理部', title: '取締役', role: 'admin', hireDate: '2018-04-01', weeklyDays: 5, weeklyHours: 40, punchRequired: false, birthDate: '1983-11-02', active: true, custom: {} },
  { id: 'm-03', name: '葛西 大輔', email: 'kasai@tsunaguba.co.jp', employmentType: 'employee', dept: 'コンサルティング部', title: 'マネージャー', role: 'admin', hireDate: '2019-07-01', weeklyDays: 5, weeklyHours: 40, punchRequired: true, birthDate: '1987-03-21', active: true, custom: {} },
  { id: 'm-04', name: '三浦 彩', email: 'miura@tsunaguba.co.jp', employmentType: 'employee', dept: 'コンサルティング部', title: 'リーダー', role: 'member', hireDate: '2020-04-01', weeklyDays: 5, weeklyHours: 40, punchRequired: true, birthDate: '1991-08-09', active: true, custom: {} },
  { id: 'm-05', name: '小野寺 岳', email: 'onodera@tsunaguba.co.jp', employmentType: 'employee', dept: 'システム開発部', title: 'リーダー', role: 'member', hireDate: '2020-10-01', weeklyDays: 5, weeklyHours: 40, punchRequired: true, birthDate: '1990-01-30', active: true, custom: {} },
  { id: 'm-06', name: '澤村 拓海', email: 'sawamura@tsunaguba.co.jp', employmentType: 'employee', dept: 'システム開発部', title: 'メンバー', role: 'member', hireDate: '2022-04-01', weeklyDays: 5, weeklyHours: 40, punchRequired: true, birthDate: '1996-12-05', active: true, custom: {} },
  { id: 'm-07', name: '井関 美咲', email: 'iseki@tsunaguba.co.jp', employmentType: 'employee', dept: '運用部', title: 'メンバー', role: 'member', hireDate: '2023-04-01', weeklyDays: 5, weeklyHours: 40, punchRequired: true, birthDate: '1998-05-18', active: true, custom: {} },
  { id: 'm-08', name: '玉井 蓮', email: 'tamai@tsunaguba.co.jp', employmentType: 'employee', dept: '運用部', title: 'メンバー', role: 'member', hireDate: '2024-04-01', weeklyDays: 5, weeklyHours: 40, punchRequired: true, birthDate: '2000-02-27', active: true, custom: {} },
  { id: 'm-09', name: '深田 遥', email: 'fukada@tsunaguba.co.jp', employmentType: 'contract', dept: 'システム開発部', title: 'メンバー', role: 'member', hireDate: '2024-01-01', weeklyDays: 5, weeklyHours: 37.5, punchRequired: true, birthDate: '1993-09-14', active: true, custom: {} },
  { id: 'm-10', name: '村瀬 光', email: 'murase@tsunaguba.co.jp', employmentType: 'parttime', dept: '経営管理部', title: 'アシスタント', role: 'member', hireDate: '2024-09-01', weeklyDays: 3, weeklyHours: 18, punchRequired: true, birthDate: '2003-04-22', active: true, custom: {} },
  { id: 'm-11', name: '有田 望', email: 'arita@tsunaguba.co.jp', employmentType: 'parttime', dept: '運用部', title: 'アシスタント', role: 'member', hireDate: '2025-11-01', weeklyDays: 2, weeklyHours: 12, punchRequired: true, birthDate: '2008-10-03', active: true, custom: {} },
  { id: 'm-12', name: '外川 亘', email: 'togawa@partner.example.com', employmentType: 'outsource', dept: 'システム開発部', title: 'パートナー', role: 'member', hireDate: '2025-05-01', weeklyDays: 5, weeklyHours: 40, punchRequired: false, birthDate: '1985-07-07', active: true, custom: {} },
]

export const seedIndustries: Industry[] = [
  { id: 'ind-01', name: '小売', displayOrder: 1, active: true },
  { id: 'ind-02', name: 'アパレル', displayOrder: 2, active: true },
  { id: 'ind-03', name: '製造', displayOrder: 3, active: true },
  { id: 'ind-04', name: '物流', displayOrder: 4, active: true },
  { id: 'ind-05', name: '食品', displayOrder: 5, active: true },
  { id: 'ind-06', name: 'メディア', displayOrder: 6, active: true },
  { id: 'ind-07', name: 'ホテル・観光', displayOrder: 7, active: true },
  { id: 'ind-08', name: 'IT・システム', displayOrder: 8, active: true },
  { id: 'ind-09', name: '医療・介護', displayOrder: 9, active: true },
  { id: 'ind-10', name: '金融', displayOrder: 10, active: true },
]

export const seedCompanies: Company[] = [
  { id: 'c-self', kind: 'self', name: 'TSUNAGUBA', aliases: ['ツナグバ'], industryIds: ['ind-08'], primaryIndustryId: 'ind-08', size: '10-50名', location: '東京都', description: '業務コンサルティング・システムコンサルティング・システム開発運用', ownerMemberId: 'm-01', fiscalStartMonth: 4, active: true, custom: {} },
  { id: 'c-01', kind: 'customer', name: 'アケボノ商事', aliases: ['アケボノ', 'akebono'], industryIds: ['ind-01', 'ind-02'], primaryIndustryId: 'ind-01', size: '1000名以上', location: '東京都', description: '全国展開の総合小売チェーン。SCM プラットフォーム導入先', ownerMemberId: 'm-03', fiscalStartMonth: null, active: true, custom: {} },
  { id: 'c-02', kind: 'customer', name: 'ウンドゥアパレル', aliases: ['ウンドゥ', 'UNDEUX'], industryIds: ['ind-02'], primaryIndustryId: 'ind-02', size: '300-1000名', location: '大阪府', description: '婦人服製造小売。売上分析スイートの提供先', ownerMemberId: 'm-04', fiscalStartMonth: null, active: true, custom: {} },
  { id: 'c-03', kind: 'customer', name: 'トクタケ製靴', aliases: ['トクタケ'], industryIds: ['ind-03', 'ind-09'], primaryIndustryId: 'ind-03', size: '100-300名', location: '香川県', description: '介護シューズメーカー。AI 分析プラットフォームの提供先', ownerMemberId: 'm-05', fiscalStartMonth: null, active: true, custom: {} },
  { id: 'c-04', kind: 'customer', name: '北都物流', aliases: ['ホクト'], industryIds: ['ind-04'], primaryIndustryId: 'ind-04', size: '300-1000名', location: '北海道', description: '3PL 事業者。物流改善コンサルティング先。アケボノ商事の物流受託', ownerMemberId: 'm-03', fiscalStartMonth: null, active: true, custom: {} },
  { id: 'c-05', kind: 'customer', name: 'みなみ食品', aliases: ['ミナミ'], industryIds: ['ind-05', 'ind-03'], primaryIndustryId: 'ind-05', size: '100-300名', location: '福岡県', description: '冷凍食品メーカー。業務改善コンサルティング先', ownerMemberId: 'm-04', fiscalStartMonth: null, active: true, custom: {} },
  { id: 'c-06', kind: 'customer', name: 'グランメディア', aliases: ['グラン'], industryIds: ['ind-06'], primaryIndustryId: 'ind-06', size: '50-100名', location: '東京都', description: 'Web メディア運営。記事生成 AI の PoC 先', ownerMemberId: 'm-06', fiscalStartMonth: null, active: true, custom: {} },
  { id: 'c-07', kind: 'customer', name: 'シーサイドホテルズ', aliases: ['シーサイド'], industryIds: ['ind-07'], primaryIndustryId: 'ind-07', size: '300-1000名', location: '沖縄県', description: 'リゾートホテル運営。DX 構想策定支援先', ownerMemberId: 'm-03', fiscalStartMonth: null, active: true, custom: {} },
  { id: 'c-08', kind: 'customer', name: 'テクノパーツ工業', aliases: ['テクノパーツ'], industryIds: ['ind-03'], primaryIndustryId: 'ind-03', size: '100-300名', location: '愛知県', description: '自動車部品メーカー。生産管理システム刷新の商談中', ownerMemberId: 'm-05', fiscalStartMonth: null, active: true, custom: {} },
]

export const seedContacts: Contact[] = [
  { id: 'p-01', companyId: 'c-01', name: '曙 一郎', dept: '経営企画部', title: '執行役員', keyPerson: 3, email: 'akebono-i@example.com', phone: '03-0000-0001', notes: 'SCM 導入の意思決定者。数字で語ると刺さる', active: true, custom: {} },
  { id: 'p-02', companyId: 'c-01', name: '春日 由紀', dept: '情報システム部', title: '部長', keyPerson: 2, email: 'kasuga@example.com', phone: '03-0000-0002', notes: '技術面の窓口。慎重派', active: true, custom: {} },
  { id: 'p-03', companyId: 'c-01', name: '夏木 陽平', dept: '商品部', title: 'バイヤー', keyPerson: 1, email: 'natsuki@example.com', phone: '03-0000-0003', notes: '現場ユーザー代表', active: true, custom: {} },
  { id: 'p-04', companyId: 'c-02', name: '宇野 貴子', dept: '営業本部', title: '本部長', keyPerson: 3, email: 'uno@example.com', phone: '06-0000-0001', notes: '売上分析スイートのスポンサー', active: true, custom: {} },
  { id: 'p-05', companyId: 'c-02', name: '堂島 諒', dept: 'MD 部', title: '課長', keyPerson: 2, email: 'dojima@example.com', phone: '06-0000-0002', notes: '週次データの実務担当', active: true, custom: {} },
  { id: 'p-06', companyId: 'c-03', name: '徳丸 康夫', dept: '経営企画室', title: '室長', keyPerson: 3, email: 'tokumaru@example.com', phone: '087-000-0001', notes: 'AI 活用に前向き。現場の負担増を最も懸念', active: true, custom: {} },
  { id: 'p-07', companyId: 'c-03', name: '桜井 芽衣', dept: 'お客様相談室', title: '主任', keyPerson: 1, email: 'sakurai@example.com', phone: '087-000-0002', notes: '問い合わせ分析の利用者', active: true, custom: {} },
  { id: 'p-08', companyId: 'c-04', name: '北原 剛', dept: '営業部', title: '部長', keyPerson: 2, email: 'kitahara@example.com', phone: '011-000-0001', notes: 'アケボノ商事の担当も兼務', active: true, custom: {} },
  { id: 'p-09', companyId: 'c-05', name: '南 佳奈', dept: '製造部', title: '工場長', keyPerson: 2, email: 'minami@example.com', phone: '092-000-0001', notes: '現場改善の推進役', active: true, custom: {} },
  { id: 'p-10', companyId: 'c-06', name: '倉持 慎', dept: '編集部', title: '編集長', keyPerson: 2, email: 'kuramochi@example.com', phone: '03-0000-0011', notes: 'PoC の評価者', active: true, custom: {} },
  { id: 'p-11', companyId: 'c-07', name: '汐見 玲', dept: '経営企画部', title: '取締役', keyPerson: 3, email: 'shiomi@example.com', phone: '098-000-0001', notes: 'DX 構想のオーナー。曙 一郎氏の紹介', active: true, custom: {} },
  { id: 'p-12', companyId: 'c-08', name: '真鍋 隆', dept: '生産管理部', title: '部長', keyPerson: 2, email: 'manabe@example.com', phone: '052-000-0001', notes: '商談中。RFP 作成を支援', active: true, custom: {} },
]

export const seedRelationTypes: RelationType[] = [
  { id: 'rt-supplies', label: '納品先', direction: 'directed', appliesTo: 'company', active: true },
  { id: 'rt-fulfills', label: '物流受託先', direction: 'directed', appliesTo: 'company', active: true },
  { id: 'rt-sells-via', label: '販売チャネル', direction: 'directed', appliesTo: 'company', active: true },
  { id: 'rt-competitor', label: '競合', direction: 'mutual', appliesTo: 'company', active: true },
  { id: 'rt-capital', label: '資本関係', direction: 'directed', appliesTo: 'company', active: true },
  { id: 'rt-boss', label: '上司・部下', direction: 'directed', appliesTo: 'contact', active: true },
  { id: 'rt-decision-line', label: '意思決定ライン', direction: 'directed', appliesTo: 'contact', active: true },
  { id: 'rt-referral', label: '紹介', direction: 'directed', appliesTo: 'contact', active: true },
]

export const seedCompanyRelations: CompanyRelation[] = [
  { id: 'cr-01', fromCompanyId: 'c-02', toCompanyId: 'c-01', relationTypeId: 'rt-supplies', notes: 'ウンドゥの婦人服をアケボノ商事の店舗で展開' },
  { id: 'cr-02', fromCompanyId: 'c-04', toCompanyId: 'c-01', relationTypeId: 'rt-fulfills', notes: '北都物流がアケボノ商事の EC 物流を受託' },
  { id: 'cr-03', fromCompanyId: 'c-03', toCompanyId: 'c-01', relationTypeId: 'rt-sells-via', notes: '介護シューズをアケボノ商事の店舗チャネルで販売' },
  { id: 'cr-04', fromCompanyId: 'c-05', toCompanyId: 'c-01', relationTypeId: 'rt-supplies', notes: '冷凍食品を食品売場へ納品' },
  { id: 'cr-05', fromCompanyId: 'c-02', toCompanyId: 'c-08', relationTypeId: 'rt-competitor', notes: '（例示）同一商圏での競合はなし。将来削除可' },
]

export const seedContactRelations: ContactRelation[] = [
  { id: 'pr-01', fromContactId: 'p-01', toContactId: 'p-02', relationTypeId: 'rt-boss', notes: '曙氏が春日氏の上長' },
  { id: 'pr-02', fromContactId: 'p-02', toContactId: 'p-03', relationTypeId: 'rt-decision-line', notes: 'システム選定は春日氏→現場確認は夏木氏' },
  { id: 'pr-03', fromContactId: 'p-01', toContactId: 'p-11', relationTypeId: 'rt-referral', notes: '曙氏がシーサイド汐見氏を紹介（DX 構想案件の起点）' },
]

export const seedProjects: Project[] = [
  { id: 'pj-01', name: 'アケボノ商事 SCM プラットフォーム導入', companyId: 'c-01', type: 'sys_consulting', status: 'active', priority: 'high', ownerMemberId: 'm-03', memberIds: ['m-03', 'm-05', 'm-06', 'm-12'], startDate: '2025-10-01', endDate: '2026-12-31', budget: 48000000, objective: 'SCM プラットフォームの全社導入と定着化', active: true, custom: {} },
  { id: 'pj-02', name: 'ウンドゥ 売上分析スイート運用', companyId: 'c-02', type: 'operation', status: 'active', priority: 'mid', ownerMemberId: 'm-04', memberIds: ['m-04', 'm-07'], startDate: '2025-04-01', endDate: null, budget: 12000000, objective: '売上分析基盤の運用・改善サイクル定着', active: true, custom: {} },
  { id: 'pj-03', name: 'トクタケ AI 分析プラットフォーム開発', companyId: 'c-03', type: 'development', status: 'active', priority: 'high', ownerMemberId: 'm-05', memberIds: ['m-05', 'm-06', 'm-09'], startDate: '2025-08-01', endDate: '2026-09-30', budget: 36000000, objective: '問い合わせ・アンケートの AI 分析基盤構築', active: true, custom: {} },
  { id: 'pj-04', name: '北都物流 物流改善コンサルティング', companyId: 'c-04', type: 'biz_consulting', status: 'active', priority: 'mid', ownerMemberId: 'm-03', memberIds: ['m-03', 'm-04'], startDate: '2026-01-01', endDate: '2026-08-31', budget: 15000000, objective: '庫内オペレーション改善と KPI 体系整備', active: true, custom: {} },
  { id: 'pj-05', name: 'みなみ食品 業務改善支援', companyId: 'c-05', type: 'biz_consulting', status: 'active', priority: 'low', ownerMemberId: 'm-04', memberIds: ['m-04'], startDate: '2026-03-01', endDate: '2026-10-31', budget: 8000000, objective: '受発注業務の標準化とペーパーレス化', active: true, custom: {} },
  { id: 'pj-06', name: 'グランメディア 記事生成 AI PoC', companyId: 'c-06', type: 'development', status: 'onhold', priority: 'low', ownerMemberId: 'm-06', memberIds: ['m-06'], startDate: '2026-02-01', endDate: '2026-06-30', budget: 4000000, objective: '記事生成ワークフローの PoC 検証', active: true, custom: {} },
  { id: 'pj-07', name: 'シーサイドホテルズ DX 構想策定', companyId: 'c-07', type: 'biz_consulting', status: 'planned', priority: 'mid', ownerMemberId: 'm-03', memberIds: ['m-03'], startDate: '2026-08-01', endDate: '2027-01-31', budget: 10000000, objective: '中期 DX ロードマップの策定', active: true, custom: {} },
  { id: 'pj-08', name: 'AKEBONO Office 開発（自社）', companyId: 'c-self', type: 'internal', status: 'active', priority: 'high', ownerMemberId: 'm-01', memberIds: ['m-01', 'm-05', 'm-06', 'm-09'], startDate: '2026-06-01', endDate: null, budget: 0, objective: '社内オフィスアプリの構築と他社展開の土台づくり', active: true, custom: {} },
]

export const seedKnowledge: KnowledgeArticle[] = [
  { id: 'k-01', domain: 'industry', targetId: 'ind-01', title: '小売業の年間商戦カレンダー', body: '小売業は 3 月・9 月の季節切替、年末年始・GW・お盆が繁忙。システム導入は 1-2 月 / 6-7 月の閑散期に行うのが定石。', tags: ['商習慣'], source: 'manual', sourceRefId: null, updatedAt: '2026-06-10T09:00:00+09:00', active: true },
  { id: 'k-02', domain: 'company', targetId: 'c-01', title: 'アケボノ商事の意思決定プロセス', body: '執行役員会は毎月第 2 火曜。1,000 万円超の投資は経営会議マター。現場パイロット→数値実証→全社展開の 3 段階を好む。', tags: ['意思決定'], source: 'manual', sourceRefId: null, updatedAt: '2026-06-20T09:00:00+09:00', active: true },
  { id: 'k-03', domain: 'contact', targetId: 'p-01', title: '曙執行役員との会話メモ', body: '数字とベンチマークで説得するのが有効。抽象的な「DX」という言葉を嫌う。現場出身で店舗オペレーションに詳しい。', tags: ['キーパーソン'], source: 'manual', sourceRefId: null, updatedAt: '2026-07-01T09:00:00+09:00', active: true },
  { id: 'k-04', domain: 'relation', targetId: 'cr-02', title: '北都物流とアケボノ商事の受託関係', body: '北都はアケボノの EC 物流を受託しており、SCM 導入の在庫データ連携で両社の合意が必要。片方だけに提案すると角が立つ。', tags: ['注意点'], source: 'manual', sourceRefId: null, updatedAt: '2026-06-25T09:00:00+09:00', active: true },
  { id: 'k-05', domain: 'project', targetId: 'pj-01', title: 'SCM 導入 Phase2 の合意事項', body: '2026/06 の定例で在庫スナップショットの粒度を「日次×SKU×拠点」で合意。棚卸月（2 月・8 月）はバッチ停止枠を設ける。', tags: ['合意事項'], source: 'manual', sourceRefId: null, updatedAt: '2026-06-30T09:00:00+09:00', active: true },
  { id: 'k-06', domain: 'industry', targetId: 'ind-09', title: '介護業界の購買特性', body: '介護施設の購買は 4 月の年度予算執行が中心。ケアマネジャー経由の推奨が個人購買に効く。', tags: ['商習慣'], source: 'manual', sourceRefId: null, updatedAt: '2026-05-15T09:00:00+09:00', active: true },
  { id: 'k-07', domain: 'company', targetId: 'c-03', title: 'トクタケ製靴の現場文化', body: '現場の職人気質が強く、ツール導入は「入力の手間を増やさない」ことが絶対条件。桜井主任が現場の信頼を得ている。', tags: ['文化'], source: 'manual', sourceRefId: null, updatedAt: '2026-06-05T09:00:00+09:00', active: true },
  { id: 'k-08', domain: 'project', targetId: 'pj-04', title: '物流改善の裁定: KPI は 5 個まで', body: 'KPI 乱立の相談に対し「現場ボードに載せる KPI は 5 個まで、それ以外は月次レビューで見る」と裁定。', tags: ['裁定'], source: 'escalation', sourceRefId: 'esc-0003', updatedAt: '2026-07-05T09:00:00+09:00', active: true },
]

export const seedCodeMaster: CodeMasterItem[] = [
  { id: 'cm-01', category: 'dept', code: 'consulting', label: 'コンサルティング部', displayOrder: 1, active: true },
  { id: 'cm-02', category: 'dept', code: 'development', label: 'システム開発部', displayOrder: 2, active: true },
  { id: 'cm-03', category: 'dept', code: 'operation', label: '運用部', displayOrder: 3, active: true },
  { id: 'cm-04', category: 'dept', code: 'corporate', label: '経営管理部', displayOrder: 4, active: true },
  { id: 'cm-05', category: 'title', code: 'ceo', label: '代表取締役', displayOrder: 1, active: true },
  { id: 'cm-06', category: 'title', code: 'director', label: '取締役', displayOrder: 2, active: true },
  { id: 'cm-07', category: 'title', code: 'manager', label: 'マネージャー', displayOrder: 3, active: true },
  { id: 'cm-08', category: 'title', code: 'leader', label: 'リーダー', displayOrder: 4, active: true },
  { id: 'cm-09', category: 'title', code: 'staff', label: 'メンバー', displayOrder: 5, active: true },
  { id: 'cm-10', category: 'title', code: 'assistant', label: 'アシスタント', displayOrder: 6, active: true },
  { id: 'cm-11', category: 'title', code: 'partner', label: 'パートナー', displayOrder: 7, active: true },
  { id: 'cm-12', category: 'documentTag', code: 'rule', label: '規程', displayOrder: 1, active: true },
  { id: 'cm-13', category: 'documentTag', code: 'minutes', label: '議事録', displayOrder: 2, active: true },
  { id: 'cm-14', category: 'documentTag', code: 'proposal', label: '提案書', displayOrder: 3, active: true },
  { id: 'cm-15', category: 'documentTag', code: 'design', label: '設計書', displayOrder: 4, active: true },
  { id: 'cm-16', category: 'documentTag', code: 'manual', label: 'マニュアル', displayOrder: 5, active: true },
  { id: 'cm-17', category: 'companySize', code: 's', label: '50名未満', displayOrder: 1, active: true },
  { id: 'cm-18', category: 'companySize', code: 'm', label: '50-100名', displayOrder: 2, active: true },
  { id: 'cm-19', category: 'companySize', code: 'l', label: '100-300名', displayOrder: 3, active: true },
  { id: 'cm-20', category: 'companySize', code: 'xl', label: '300-1000名', displayOrder: 4, active: true },
  { id: 'cm-21', category: 'companySize', code: 'xxl', label: '1000名以上', displayOrder: 5, active: true },
]

export const seedCustomFieldDefs: CustomFieldDef[] = [
  { id: 'cf-01', entity: 'member', key: 'certifications', label: '保有資格', fieldType: 'multiselect', options: ['中小企業診断士', 'PMP', '基本情報', '応用情報', '簿記2級'], required: false, displayOrder: 1, active: true },
  { id: 'cf-02', entity: 'company', key: 'contractType', label: '契約形態', fieldType: 'select', options: ['顧問契約', 'プロジェクト契約', '保守契約', '未契約'], required: false, displayOrder: 1, active: true },
  { id: 'cf-03', entity: 'contact', key: 'meetingFreq', label: '面談頻度', fieldType: 'select', options: ['週次', '隔週', '月次', '四半期', '不定期'], required: false, displayOrder: 1, active: true },
  { id: 'cf-04', entity: 'project', key: 'billingType', label: '請求区分', fieldType: 'select', options: ['準委任(月額)', '請負(一括)', '請負(分割)', 'レベニューシェア'], required: false, displayOrder: 1, active: true },
]

export const seedExternalLinks: ExternalLink[] = [
  { id: 'el-01', title: 'サポート管理表', url: 'https://www.google.com/', description: '顧客サポートの起票・対応状況管理（スプレッドシート）', icon: 'Table2', displayOrder: 1, active: true },
  { id: 'el-02', title: '経費精算 SaaS', url: 'https://www.google.com/', description: '立替経費の精算はこちら（稟議の経費承認と連動）', icon: 'Receipt', displayOrder: 2, active: true },
  { id: 'el-03', title: '社内 Wiki（旧）', url: 'https://www.google.com/', description: '移行中の旧ナレッジベース', icon: 'BookOpen', displayOrder: 3, active: true },
]

export const seedWorkflowRoutes: WorkflowRoute[] = [
  { id: 'wr-01', category: 'purchase', minAmount: 0, maxAmount: 100000, steps: [{ order: 1, approverRole: 'manager', approverMemberId: null, mode: 'serial' }], active: true },
  { id: 'wr-02', category: 'purchase', minAmount: 100000, maxAmount: 1000000, steps: [{ order: 1, approverRole: 'manager', approverMemberId: null, mode: 'serial' }, { order: 2, approverRole: 'director', approverMemberId: null, mode: 'serial' }], active: true },
  { id: 'wr-03', category: 'purchase', minAmount: 1000000, maxAmount: null, steps: [{ order: 1, approverRole: 'manager', approverMemberId: null, mode: 'serial' }, { order: 2, approverRole: 'director', approverMemberId: null, mode: 'serial' }, { order: 3, approverRole: 'president', approverMemberId: null, mode: 'serial' }], active: true },
  { id: 'wr-04', category: 'contract', minAmount: 0, maxAmount: null, steps: [{ order: 1, approverRole: 'manager', approverMemberId: null, mode: 'serial' }, { order: 2, approverRole: 'director', approverMemberId: null, mode: 'serial' }, { order: 3, approverRole: 'president', approverMemberId: null, mode: 'serial' }], active: true },
  { id: 'wr-05', category: 'expense', minAmount: 0, maxAmount: 50000, steps: [{ order: 1, approverRole: 'manager', approverMemberId: null, mode: 'serial' }], active: true },
  { id: 'wr-06', category: 'expense', minAmount: 50000, maxAmount: null, steps: [{ order: 1, approverRole: 'manager', approverMemberId: null, mode: 'serial' }, { order: 2, approverRole: 'director', approverMemberId: null, mode: 'serial' }], active: true },
  { id: 'wr-07', category: 'hiring', minAmount: 0, maxAmount: null, steps: [{ order: 1, approverRole: 'director', approverMemberId: null, mode: 'serial' }, { order: 2, approverRole: 'president', approverMemberId: null, mode: 'serial' }], active: true },
  { id: 'wr-08', category: 'trip', minAmount: 0, maxAmount: 150000, steps: [{ order: 1, approverRole: 'manager', approverMemberId: null, mode: 'serial' }], active: true },
  { id: 'wr-09', category: 'trip', minAmount: 150000, maxAmount: null, steps: [{ order: 1, approverRole: 'manager', approverMemberId: null, mode: 'serial' }, { order: 2, approverRole: 'director', approverMemberId: null, mode: 'serial' }], active: true },
  { id: 'wr-10', category: 'other', minAmount: 0, maxAmount: null, steps: [{ order: 1, approverRole: 'manager', approverMemberId: null, mode: 'serial' }, { order: 2, approverRole: 'director', approverMemberId: null, mode: 'serial' }], active: true },
]

export const seedAttendanceRules: AttendanceRule[] = [
  { id: 'ar-01', name: '正社員（フレックス）', appliesTo: ['employee'], workStart: '09:00', workEnd: '18:00', breakMinutes: 60, flex: { enabled: true, coreStart: '10:00', coreEnd: '15:00', settlementMonths: 1 }, closingDay: 31, legalHolidayWeekday: 0, active: true },
  { id: 'ar-02', name: '契約社員（固定時間）', appliesTo: ['contract'], workStart: '09:30', workEnd: '18:00', breakMinutes: 60, flex: null, closingDay: 31, legalHolidayWeekday: 0, active: true },
  { id: 'ar-03', name: 'アルバイト（シフト制）', appliesTo: ['parttime'], workStart: '10:00', workEnd: '17:00', breakMinutes: 45, flex: null, closingDay: 31, legalHolidayWeekday: 0, active: true },
]

export const seedSystemServices: SystemService[] = [
  {
    id: 'svc-01', name: 'AKEBONO SCM', description: 'アケボノ商事向け SCM プラットフォーム', url: 'https://scm.example.com',
    components: [
      { id: 'svc-01-api', name: 'API' },
      { id: 'svc-01-web', name: '管理画面' },
      { id: 'svc-01-batch', name: '夜間バッチ' },
      { id: 'svc-01-sync', name: 'データ連携' },
    ],
  },
  {
    id: 'svc-02', name: 'UNDEUX Sales Suite', description: 'ウンドゥアパレル向け売上分析スイート', url: 'https://sales.example.com',
    components: [
      { id: 'svc-02-api', name: 'API' },
      { id: 'svc-02-web', name: '分析画面' },
      { id: 'svc-02-mart', name: 'マート再構築' },
    ],
  },
  {
    id: 'svc-03', name: 'TOKUTAKE AI Platform', description: 'トクタケ製靴向け AI 分析プラットフォーム', url: 'https://ai.example.com',
    components: [
      { id: 'svc-03-web', name: '分析画面' },
      { id: 'svc-03-ai', name: 'AI 生成' },
      { id: 'svc-03-etl', name: 'ETL' },
    ],
  },
]

export const seedAiRoles: AiRole[] = [
  { id: 'r-01', name: 'リサーチャー', mission: '業界・競合・技術動向の調査と要約', systemPrompt: 'あなたは調査専門の AI 社員です。一次情報を優先し、出典を必ず示してください。', permissions: ['knowledge:read', 'web:search'], modelTier: 'standard', active: true },
  { id: 'r-02', name: 'ドキュメンター', mission: '議事録・提案書ドラフト・ナレッジ整備', systemPrompt: 'あなたは文書作成専門の AI 社員です。社内テンプレートに従い、簡潔に書いてください。', permissions: ['knowledge:read', 'knowledge:write', 'documents:write'], modelTier: 'standard', active: true },
  { id: 'r-03', name: 'データアナリスト', mission: '業務データ・スタースキーマの分析と示唆出し', systemPrompt: 'あなたはデータ分析専門の AI 社員です。半加法メジャーの時間軸集計に注意してください。', permissions: ['mart:read', 'knowledge:read'], modelTier: 'pro', active: true },
  { id: 'r-04', name: 'QA サポート', mission: '社内からの質問対応と一次切り分け', systemPrompt: 'あなたは社内サポートの AI 社員です。わからないことは推測せずエスカレーションしてください。', permissions: ['knowledge:read', 'masters:read'], modelTier: 'lite', active: true },
]

export const seedAiEmployees: AiEmployee[] = [
  { id: 'ai-01', name: 'アキ', roleId: 'r-01', status: 'working', deskPosition: { x: 1, y: 1 }, active: true },
  { id: 'ai-02', name: 'ハル', roleId: 'r-02', status: 'idle', deskPosition: { x: 2, y: 1 }, active: true },
  { id: 'ai-03', name: 'ソラ', roleId: 'r-03', status: 'working', deskPosition: { x: 1, y: 2 }, active: true },
  { id: 'ai-04', name: 'レン', roleId: 'r-04', status: 'waiting_approval', deskPosition: { x: 2, y: 2 }, active: true },
  { id: 'ai-05', name: 'ユキ', roleId: 'r-02', status: 'idle', deskPosition: { x: 3, y: 1 }, active: true },
]

export const seedFeatureToggles: FeatureToggle[] = [
  { key: 'decision', label: '意思決定支援ツール', enabled: true },
  { key: 'akebono', label: 'AKEBONO', enabled: true },
  { key: 'shift', label: 'シフト表', enabled: true },
  { key: 'aiCompany', label: 'AIネイティブカンパニー', enabled: true },
  { key: 'chatbot', label: 'AIチャットボット', enabled: true },
  { key: 'documents', label: 'ドキュメント管理', enabled: true },
  { key: 'status', label: '稼働状況ページ', enabled: true },
]

export const seedEscalationRules: EscalationRule[] = [
  { key: 'issue_reported', label: '日報の課題記入', enabled: true, threshold: null, thresholdLabel: null, cooldownDays: 3 },
  { key: 'stalled_task', label: 'タスク停滞', enabled: true, threshold: 3, thresholdLabel: '停滞日数', cooldownDays: 7 },
  { key: 'overload', label: '過負荷', enabled: true, threshold: 7, thresholdLabel: '保有タスク数', cooldownDays: 7 },
  { key: 'low_confidence', label: 'AI 確信度低', enabled: true, threshold: null, thresholdLabel: null, cooldownDays: 1 },
  { key: 'overtime_alert', label: '残業アラート', enabled: true, threshold: 36, thresholdLabel: '月間時間外(h)', cooldownDays: 7 },
]
