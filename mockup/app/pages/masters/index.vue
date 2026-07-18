<script setup lang="ts">
/**
 * F-10 マスタメンテナンス ハブ（管理者専用）
 * 14 マスタ + ナレッジ + 設定への案内カード。各カードに件数バッジ。
 */
import type { MenuCard } from '~/types/ui'

const { tbl } = useMockDb()

const members = tbl('members')
const departments = tbl('departments')
const leaveTypes = tbl('leaveTypes')
const industries = tbl('industries')
const companies = tbl('companies')
const contacts = tbl('contacts')
const companyRelations = tbl('companyRelations')
const contactRelations = tbl('contactRelations')
const relationTypes = tbl('relationTypes')
const permissionRules = tbl('permissionRules')
const projects = tbl('projects')
const knowledge = tbl('knowledge')
const codeMaster = tbl('codeMaster')
const holidays = tbl('holidays')

function activeCount(rows: { active?: boolean }[]): number {
  return rows.filter(r => r.active !== false).length
}

const cards = computed<MenuCard[]>(() => [
  {
    id: 'members',
    title: 'メンバー',
    description: '氏名・雇用区分・部門・週所定・打刻対象・ロール',
    icon: 'Users',
    to: '/masters/members',
    badge: activeCount(members.value),
  },
  {
    id: 'departments',
    title: '部署・組織図',
    description: '部署の階層・責任者・メンバーの所属。組織図の表示',
    icon: 'Network',
    to: '/masters/departments',
    badge: activeCount(departments.value),
  },
  {
    id: 'titles',
    title: '役職',
    description: 'メンバー登録の役職選択肢（追加・表示順・無効化）',
    icon: 'IdCard',
    to: '/masters/titles',
    badge: activeCount(codeMaster.value.filter(i => i.category === 'title')),
  },
  {
    id: 'leave-types',
    title: '休暇種別',
    description: '有給・夏季休暇・結婚特休等の種別と付与方式・使用期限',
    icon: 'CalendarHeart',
    to: '/masters/leave-types',
    badge: activeCount(leaveTypes.value),
  },
  {
    id: 'industries',
    title: '業界',
    description: '業界名と表示順。直交軸で管理（複合値を作らない）',
    icon: 'Factory',
    to: '/masters/industries',
    badge: activeCount(industries.value),
  },
  {
    id: 'company',
    title: '自社',
    description: '自社の会社情報・会計年度開始月（他社展開時の差し替え点）',
    icon: 'Building',
    to: '/masters/company',
    badge: companies.value.filter(c => c.kind === 'self' && c.active !== false).length,
  },
  {
    id: 'customers',
    title: '顧客(会社)',
    description: '会社名・業界（複数+主）・エイリアス・規模・担当',
    icon: 'Building2',
    to: '/masters/customers',
    badge: companies.value.filter(c => c.kind === 'customer' && c.active !== false).length,
  },
  {
    id: 'contacts',
    title: '顧客(人)',
    description: '氏名・所属会社・キーパーソン度・連絡先・メモ',
    icon: 'Contact',
    to: '/masters/contacts',
    badge: activeCount(contacts.value),
  },
  {
    id: 'relations-company',
    title: '顧客関係(会社)',
    description: '会社間の関係エッジ（納品先・競合など）。グラフ可視化',
    icon: 'Network',
    to: '/masters/relations-company',
    badge: companyRelations.value.length,
  },
  {
    id: 'relations-contact',
    title: '顧客関係(人)',
    description: '人どうしの関係エッジ（上司部下・紹介など）。グラフ可視化',
    icon: 'Network',
    to: '/masters/relations-contact',
    badge: contactRelations.value.length,
  },
  {
    id: 'relation-types',
    title: '関係種別',
    description: '顧客関係で使う関係の種類の定義（追加・編集・削除）',
    icon: 'Tags',
    to: '/masters/relation-types',
    badge: activeCount(relationTypes.value),
  },
  {
    id: 'projects',
    title: 'プロジェクト',
    description: 'PJ 名・顧客・種別・状態・担当・期間・予算・目的',
    icon: 'FolderKanban',
    to: '/masters/projects',
    badge: activeCount(projects.value),
  },
  {
    id: 'permissions',
    title: '権限設定',
    description: 'ロール・役職・個人の 3 レイヤで機能と表示項目の権限を制御',
    icon: 'ShieldCheck',
    to: '/masters/permissions',
    badge: activeCount(permissionRules.value),
  },
  {
    id: 'knowledge',
    title: 'ナレッジ',
    description: '5 ドメイン（業界/会社/人/関係/PJ）に紐付く記事と裁定還流',
    icon: 'BookOpen',
    to: '/masters/knowledge',
    badge: activeCount(knowledge.value),
  },
  {
    id: 'holidays',
    title: '祝日',
    description: '内閣府の公式データ取込と手動管理。翌営業日計算・カレンダーへ反映',
    icon: 'CalendarDays',
    to: '/masters/holidays',
    badge: holidays.value.length,
  },
  {
    id: 'settings',
    title: 'カスタム項目・区分値',
    description: 'カスタム項目・区分値の定義は設定画面で管理します',
    icon: 'Settings2',
    to: '/settings',
  },
])
</script>

<template>
  <MastersMasterShell
    title="マスタメンテナンス"
    description="管理者専用。マスタは論理削除（無効化）で運用します（関係エッジと未使用の関係種別のみ物理削除可）"
  >
    <UiCardMenu :items="cards" :cols="3" />
  </MastersMasterShell>
</template>
