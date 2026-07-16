<script setup lang="ts">
/**
 * F-10-3 自社マスタ（管理者専用）
 * companies の kind==='self' の 1 件を対象にした編集フォーム（一覧なし）。
 * 顧客(会社)マスタと同じ項目構造 + fiscalStartMonth（会計年度開始月）。
 */
import { splitAliases } from '~/components/masters/MasterShell.vue'
import type { Company, CustomValues } from '~/types/domain'
import type { FieldDef } from '~/types/ui'

const crud = useMasterCrud('companies', 'c')
const industryCrud = useMasterCrud('industries', 'ind')
const memberCrud = useMasterCrud('members', 'm')
const { itemsOf } = useCodeMaster()
const { defsFor, formSchemaFor } = useCustomFields()
const toast = useToast()

const self = computed<Company | null>(() =>
  ((crud.list.value as Company[]).find(c => c.kind === 'self') ?? null),
)

const form = ref<Record<string, unknown>>({
  name: '', aliasesText: '', industryIds: [], primaryIndustryId: '', size: '',
  location: '', description: '', ownerMemberId: '', fiscalStartMonth: '4', custom: {},
})
const errors = ref<Record<string, string>>({})

function loadForm(s: Company): void {
  const clone = JSON.parse(JSON.stringify(s)) as Record<string, unknown>
  form.value = {
    ...clone,
    aliasesText: s.aliases.join(', '),
    primaryIndustryId: s.primaryIndustryId ?? '',
    ownerMemberId: s.ownerMemberId ?? '',
    fiscalStartMonth: s.fiscalStartMonth != null ? String(s.fiscalStartMonth) : '',
  }
}

watch(self, (s) => { if (s) loadForm(s) }, { immediate: true })

const industryOptions = computed(() =>
  industryCrud.activeList.value
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map(i => ({ value: i.id, label: i.name })),
)

/** 主業界は選択済みの業界からのみ選べる */
const primaryOptions = computed(() => {
  const chosen = (form.value.industryIds as string[] | undefined) ?? []
  return industryOptions.value.filter(o => chosen.includes(o.value))
})

const memberOptions = computed(() =>
  memberCrud.activeList.value.map(m => ({ value: m.id, label: m.name })),
)

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}月` }))

const formFields = computed<FieldDef[]>(() => [
  { key: 'name', label: '会社名', type: 'text', required: true },
  {
    key: 'aliasesText', label: 'エイリアス（表記ゆれ）', type: 'text',
    placeholder: '例）ツナグバ, TSUNAGUBA', hint: 'カンマ・読点区切り。2文字未満は除外されます',
  },
  { key: 'industryIds', label: '業界（複数可）', type: 'multiselect', options: industryOptions.value },
  {
    key: 'primaryIndustryId', label: '主業界', type: 'select', options: primaryOptions.value,
    hint: '選択済みの業界から 1 つ指定します',
  },
  { key: 'size', label: '規模', type: 'select', options: itemsOf('companySize') },
  { key: 'location', label: '所在地', type: 'text' },
  { key: 'description', label: '事業内容', type: 'textarea' },
  { key: 'ownerMemberId', label: '担当メンバー', type: 'select', options: memberOptions.value },
  {
    key: 'fiscalStartMonth', label: '会計年度開始月', type: 'select', options: MONTH_OPTIONS,
    hint: '自社固有の設定。売上サマリ等の年度集計に使用',
  },
  ...formSchemaFor('company'),
])

function save(): void {
  const e: Record<string, string> = {}
  if (!String(form.value.name ?? '').trim()) e.name = '会社名は必須です'
  const industryIds = (form.value.industryIds as string[] | undefined) ?? []
  const primary = String(form.value.primaryIndustryId ?? '')
  if (primary && !industryIds.includes(primary)) {
    e.primaryIndustryId = '主業界は選択済みの業界リストに含まれている必要があります'
  }
  const custom = (form.value.custom ?? {}) as CustomValues
  for (const d of defsFor('company')) {
    const v = custom[d.key]
    if (d.required && (v == null || v === '' || (Array.isArray(v) && v.length === 0))) {
      e[`custom.${d.key}`] = `${d.label}は必須です`
    }
  }
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('AKO-GEN-001: 入力内容を確認してください', 'crit')
    return
  }

  const payload: Partial<Company> & { id?: string } = {
    kind: 'self',
    name: String(form.value.name ?? '').trim(),
    aliases: splitAliases(String(form.value.aliasesText ?? '')),
    industryIds,
    primaryIndustryId: primary || null,
    size: String(form.value.size ?? ''),
    location: String(form.value.location ?? ''),
    description: String(form.value.description ?? ''),
    ownerMemberId: String(form.value.ownerMemberId ?? '') || null,
    fiscalStartMonth: form.value.fiscalStartMonth ? Number(form.value.fiscalStartMonth) : null,
    custom,
  }
  if (self.value) payload.id = self.value.id

  const res = crud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('自社情報を保存しました')
}

function resetForm(): void {
  if (self.value) {
    loadForm(self.value)
    errors.value = {}
    toast.show('編集内容を破棄しました', 'info')
  }
}
</script>

<template>
  <MastersMasterShell
    title="自社マスタ"
    description="顧客(会社)マスタと同じ項目構造を持ちます（他社展開時はここを差し替え）"
  >
    <UiSectionCard
      :title="self ? `自社情報（${self.name}）` : '自社情報（未登録）'"
      description="会社名・業界・規模などの基本情報と、会計年度開始月などの自社固有設定"
    >
      <div class="max-w-xl">
        <UiSchemaForm v-model="form" :fields="formFields" :errors="errors" />
        <div class="mt-4 flex items-center justify-end gap-2 border-t border-line pt-3">
          <button type="button" class="btn" :disabled="!self" @click="resetForm">元に戻す</button>
          <button type="button" class="btn btn-primary" @click="save">保存</button>
        </div>
      </div>
    </UiSectionCard>
  </MastersMasterShell>
</template>
