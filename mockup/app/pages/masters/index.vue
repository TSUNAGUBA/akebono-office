<script setup lang="ts">
/**
 * F-10 マスタメンテナンス ハブ（管理者専用）
 * 16 マスタ + 設定への案内カード。各カードに件数バッジ。
 * カード定義 = utils/menu-registry.ts・カテゴリ絞り込み = useMenuCategories（バッチ7h）
 */
import type { MenuCard } from '~/types/ui'
import { MENU_CARDS } from '~/utils/menu-registry'

const { tbl } = useMockDb()

const members = tbl('members')
const departments = tbl('departments')
const leaveTypes = tbl('leaveTypes')
const industries = tbl('industries')
const workCategories = tbl('workCategories')
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

/** カードのランタイムバッジ（有効件数。レジストリは静的定義のみ） */
const badgeOf = computed<Record<string, number | undefined>>(() => ({
  'members': activeCount(members.value),
  'departments': activeCount(departments.value),
  'titles': activeCount(codeMaster.value.filter(i => i.category === 'title')),
  'leave-types': activeCount(leaveTypes.value),
  'industries': activeCount(industries.value),
  'work-categories': activeCount(workCategories.value),
  'company': companies.value.filter(c => c.kind === 'self' && c.active !== false).length,
  'customers': companies.value.filter(c => c.kind === 'customer' && c.active !== false).length,
  'contacts': activeCount(contacts.value),
  'relations-company': companyRelations.value.length,
  'relations-contact': contactRelations.value.length,
  'relation-types': activeCount(relationTypes.value),
  'projects': activeCount(projects.value),
  'permissions': activeCount(permissionRules.value),
  'knowledge': activeCount(knowledge.value),
  'holidays': holidays.value.length,
}))

const cards = computed<MenuCard[]>(() => MENU_CARDS.masters.map(d => ({
  id: d.id, title: d.title, description: d.description, icon: d.icon, to: d.to, badge: badgeOf.value[d.id],
})))

// カテゴリ絞り込み（バッチ7h。選択は sessionStorage 記憶）
const { categorize } = useMenuCategories('masters')
const sections = computed(() => categorize(cards.value))
const selectedCategory = ref('all')
onMounted(() => {
  const saved = sessionStorage.getItem('menu-cat-masters')
  if (saved) selectedCategory.value = saved
})
watch(selectedCategory, v => sessionStorage.setItem('menu-cat-masters', v))
watchEffect(() => {
  if (selectedCategory.value !== 'all' && !sections.value.some(s => s.id === selectedCategory.value)) {
    selectedCategory.value = 'all'
  }
})
const categoryChips = computed(() => [
  { value: 'all', label: 'すべて' },
  ...sections.value.map(s => ({ value: s.id, label: s.label })),
])
const shownSections = computed(() =>
  selectedCategory.value === 'all' ? sections.value : sections.value.filter(s => s.id === selectedCategory.value))
</script>

<template>
  <MastersMasterShell
    title="マスタメンテナンス"
    description="管理者専用。マスタは論理削除（無効化）で運用します（関係エッジと未使用の関係種別のみ物理削除可）"
  >
    <div class="grid gap-3">
      <UiChipTabs v-model="selectedCategory" :options="categoryChips" aria-label="マスタカテゴリ" />
      <div v-for="sec in shownSections" :key="sec.id">
        <p class="mb-1.5 text-[11px] font-bold text-muted">{{ sec.label }}</p>
        <UiCardMenu :items="sec.cards" :cols="3" />
      </div>
    </div>
  </MastersMasterShell>
</template>
