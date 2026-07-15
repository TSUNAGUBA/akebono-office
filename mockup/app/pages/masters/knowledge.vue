<script setup lang="ts">
/**
 * F-10-8 ナレッジ（管理者専用）
 * 5 ドメイン（業界/顧客(会社)/顧客(人)/顧客関係/プロジェクト）に紐付く記事。
 * 出典: manual=手動 / escalation=裁定還流（F-12-3 からの還流）。
 * 検索はタイトル+本文+タグを横断。
 */
import { Plus } from 'lucide-vue-next'
import {
  ACTIVE_FILTER_OPTIONS, matchesActiveFilter, splitTags,
} from '~/components/masters/MasterShell.vue'
import type {
  Company, CompanyRelation, Contact, Industry, KnowledgeArticle, KnowledgeDomain,
  Project, RelationType,
} from '~/types/domain'
import type { FieldDef, TableColumn, TabItem, Tone } from '~/types/ui'
import { fmtDateLong } from '~/utils/format'
import { KNOWLEDGE_DOMAIN_LABELS } from '~/utils/labels'

const crud = useMasterCrud('knowledge', 'k')
const { tbl } = useMockDb()
const toast = useToast()
const confirm = useConfirm()

/** 画面固有の固定区分（labels.ts は共有ファイルのためページ内定義） */
const SOURCE_META: Record<string, { label: string; tone: Tone }> = {
  manual: { label: '手動', tone: 'neutral' },
  escalation: { label: '裁定還流', tone: 'info' },
}

// ---------- 対象の参照（ドメイン別 JOIN） ----------

const industries = tbl('industries')
const companies = tbl('companies')
const contacts = tbl('contacts')
const companyRelations = tbl('companyRelations')
const relationTypes = tbl('relationTypes')
const projects = tbl('projects')

function companyName(id: string): string {
  return (companies.value as Company[]).find(c => c.id === id)?.name ?? id
}

function relationLabel(r: CompanyRelation): string {
  const rt = (relationTypes.value as RelationType[]).find(t => t.id === r.relationTypeId)
  return `${companyName(r.fromCompanyId)} → ${companyName(r.toCompanyId)}（${rt?.label ?? '関係'}）`
}

function targetLabel(domain: KnowledgeDomain, targetId: string): string {
  if (domain === 'industry') return (industries.value as Industry[]).find(i => i.id === targetId)?.name ?? targetId
  if (domain === 'company') return companyName(targetId)
  if (domain === 'contact') return (contacts.value as Contact[]).find(c => c.id === targetId)?.name ?? targetId
  if (domain === 'relation') {
    const r = (companyRelations.value as CompanyRelation[]).find(x => x.id === targetId)
    return r ? relationLabel(r) : targetId
  }
  return (projects.value as Project[]).find(p => p.id === targetId)?.name ?? targetId
}

function targetOptionsFor(domain: KnowledgeDomain): { value: string; label: string }[] {
  if (domain === 'industry') {
    return (industries.value as Industry[]).filter(i => i.active).map(i => ({ value: i.id, label: i.name }))
  }
  if (domain === 'company') {
    return (companies.value as Company[]).filter(c => c.active).map(c => ({ value: c.id, label: c.name }))
  }
  if (domain === 'contact') {
    return (contacts.value as Contact[]).filter(c => c.active).map(c => ({ value: c.id, label: `${c.name}（${companyName(c.companyId)}）` }))
  }
  if (domain === 'relation') {
    return (companyRelations.value as CompanyRelation[]).map(r => ({ value: r.id, label: relationLabel(r) }))
  }
  return (projects.value as Project[]).filter(p => p.active).map(p => ({ value: p.id, label: p.name }))
}

// ---------- タブ・一覧 ----------

const domainTabs: TabItem[] = (Object.entries(KNOWLEDGE_DOMAIN_LABELS) as [KnowledgeDomain, string][])
  .map(([key, label]) => ({ key, label }))

const currentDomain = ref<KnowledgeDomain>('industry')
/** UiTabBar（string 契約）とのブリッジ */
const domainTab = computed({
  get: () => currentDomain.value as string,
  set: (v: string) => { currentDomain.value = v as KnowledgeDomain },
})
const search = ref('')
const statusFilter = ref('active')

const filtered = computed(() =>
  (crud.list.value as KnowledgeArticle[]).filter((a) => {
    if (a.domain !== currentDomain.value) return false
    if (!matchesActiveFilter(a, statusFilter.value)) return false
    const q = search.value.trim().toLowerCase()
    if (!q) return true
    // タイトル + 本文 + タグの横断検索
    return [a.title, a.body, ...a.tags].some(v => v.toLowerCase().includes(q))
  }),
)

const tableRows = computed(() =>
  filtered.value.map(a => ({
    ...a,
    targetName: targetLabel(a.domain, a.targetId),
    tagsText: a.tags.join('、'),
  })) as unknown as Record<string, unknown>[],
)

const columns: TableColumn[] = [
  { key: 'title', label: 'タイトル', primary: true },
  { key: 'targetName', label: '対象', primary: true },
  { key: 'tagsText', label: 'タグ' },
  { key: 'source', label: '出典', primary: true },
  { key: 'updatedAt', label: '更新日', width: '110px' },
  { key: 'active', label: '状態' },
]

function asArticle(row: Record<string, unknown>): KnowledgeArticle & { targetName: string; tagsText: string } {
  return row as unknown as KnowledgeArticle & { targetName: string; tagsText: string }
}

// ---------- 詳細・編集 ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<KnowledgeArticle | null>(() =>
  selectedId.value ? ((crud.byId(selectedId.value) as KnowledgeArticle | undefined) ?? null) : null,
)
const form = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})

const drawerTitle = computed(() =>
  mode.value === 'create' ? 'ナレッジを追加' : mode.value === 'edit' ? 'ナレッジを編集' : 'ナレッジ詳細',
)

const formFields = computed<FieldDef[]>(() => [
  {
    key: 'domain', label: 'ドメイン', type: 'select', required: true,
    options: Object.entries(KNOWLEDGE_DOMAIN_LABELS).map(([value, label]) => ({ value, label })),
    hint: 'ドメインを変えると対象の選択肢が切り替わります',
  },
  {
    key: 'targetId', label: '対象', type: 'select', required: true,
    options: targetOptionsFor((form.value.domain as KnowledgeDomain) ?? 'industry'),
  },
  { key: 'title', label: 'タイトル', type: 'text', required: true },
  { key: 'body', label: '本文', type: 'textarea', placeholder: '商習慣・意思決定プロセス・裁定内容など、AI と人が参照する知見' },
  { key: 'tagsText', label: 'タグ', type: 'text', placeholder: '例）商習慣, 意思決定', hint: 'カンマ・読点区切り' },
])

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  mode.value = 'view'
  drawerOpen.value = true
}

function openCreate(): void {
  selectedId.value = null
  form.value = { domain: currentDomain.value, targetId: '', title: '', body: '', tagsText: '' }
  errors.value = {}
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  if (!selected.value) return
  const clone = JSON.parse(JSON.stringify(selected.value)) as Record<string, unknown>
  form.value = { ...clone, tagsText: selected.value.tags.join(', ') }
  errors.value = {}
  mode.value = 'edit'
}

function cancelEdit(): void {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

/** ドメイン変更時、対象がそのドメインに存在しない場合のみリセット（編集フォームの初期表示は保持） */
watch(() => form.value.domain, (nv) => {
  if (mode.value === 'view') return
  const opts = targetOptionsFor((nv as KnowledgeDomain) ?? 'industry')
  const cur = String(form.value.targetId ?? '')
  if (cur && !opts.some(o => o.value === cur)) {
    form.value = { ...form.value, targetId: '' }
  }
})

function save(): void {
  const e: Record<string, string> = {}
  if (!String(form.value.title ?? '').trim()) e.title = 'タイトルは必須です'
  if (!String(form.value.targetId ?? '')) e.targetId = '対象は必須です'
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('AKO-GEN-001: 必須項目を入力してください', 'crit')
    return
  }

  const payload: Partial<KnowledgeArticle> & { id?: string } = {
    domain: form.value.domain as KnowledgeDomain,
    targetId: String(form.value.targetId),
    title: String(form.value.title ?? '').trim(),
    body: String(form.value.body ?? ''),
    tags: splitTags(String(form.value.tagsText ?? '')),
    updatedAt: new Date().toISOString(),
  }
  if (mode.value === 'edit' && selectedId.value) {
    payload.id = selectedId.value
  } else {
    payload.source = 'manual'
    payload.sourceRefId = null
  }

  const res = crud.save(payload)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(mode.value === 'create' ? 'ナレッジを追加しました' : 'ナレッジを更新しました')
  // 追加/編集後は該当ドメインのタブへ移動して確認できるようにする
  currentDomain.value = (payload.domain ?? currentDomain.value) as KnowledgeDomain
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
}

async function archiveSelected(): Promise<void> {
  if (!selected.value) return
  const ok = await confirm.ask(
    'ナレッジの無効化',
    `「${selected.value.title}」を無効化しますか？（論理削除。あとから復元できます）`,
    { danger: true, confirmLabel: '無効化' },
  )
  if (!ok) return
  const res = crud.archive(selected.value.id)
  if (res.ok) toast.show('無効化しました', 'warn')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

function restoreSelected(): void {
  if (!selected.value) return
  const res = crud.restore(selected.value.id)
  if (res.ok) toast.show('復元しました')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}
</script>

<template>
  <MastersMasterShell
    title="ナレッジ"
    description="5 ドメインに紐付く知見を管理します。エスカレーション裁定（F-12）からの還流は出典「裁定還流」で記録されます"
  >
    <template #actions>
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新規追加
      </button>
    </template>

    <template #filter>
      <UiSearchInput v-model="search" placeholder="タイトル・本文・タグを横断検索" />
      <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
    </template>

    <div>
      <UiTabBar v-model="domainTab" :tabs="domainTabs" />
      <UiSectionCard class="mt-3" :title="`${KNOWLEDGE_DOMAIN_LABELS[currentDomain]}のナレッジ（${filtered.length}件）`" flush>
        <UiDataTable
          :columns="columns"
          :rows="tableRows"
          clickable
          empty-title="該当するナレッジがありません"
          empty-hint="「新規追加」から知見を記録できます"
          @row-click="openDetail"
        >
          <template #cell-title="{ row }">
            <span class="font-medium">{{ asArticle(row).title }}</span>
          </template>
          <template #cell-tagsText="{ row }">
            <span class="flex flex-wrap gap-1">
              <span
                v-for="t in asArticle(row).tags"
                :key="t"
                class="rounded-full bg-surface-soft border border-line px-2 py-0.5 text-[11px] text-sub"
              >{{ t }}</span>
              <span v-if="asArticle(row).tags.length === 0" class="text-muted">—</span>
            </span>
          </template>
          <template #cell-source="{ row }">
            <UiStatusBadge
              :label="SOURCE_META[asArticle(row).source]?.label ?? asArticle(row).source"
              :tone="SOURCE_META[asArticle(row).source]?.tone ?? 'neutral'"
            />
          </template>
          <template #cell-updatedAt="{ row }">
            <span class="num">{{ fmtDateLong(asArticle(row).updatedAt) }}</span>
          </template>
          <template #cell-active="{ row }">
            <UiStatusBadge :label="asArticle(row).active ? '有効' : '無効'" :tone="asArticle(row).active ? 'ok' : 'neutral'" dot />
          </template>
        </UiDataTable>
      </UiSectionCard>
    </div>

    <template #drawer>
      <UiDrawer :open="drawerOpen" :title="drawerTitle" width="560px" @close="drawerOpen = false">
        <div v-if="mode === 'view' && selected" class="grid gap-3">
          <div>
            <h3 class="text-[15px] font-bold leading-snug">{{ selected.title }}</h3>
            <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
              <UiStatusBadge :label="KNOWLEDGE_DOMAIN_LABELS[selected.domain]" tone="brand" />
              <UiStatusBadge
                :label="SOURCE_META[selected.source]?.label ?? selected.source"
                :tone="SOURCE_META[selected.source]?.tone ?? 'neutral'"
              />
              <UiStatusBadge :label="selected.active ? '有効' : '無効'" :tone="selected.active ? 'ok' : 'neutral'" dot />
              <span class="num">更新: {{ fmtDateLong(selected.updatedAt) }}</span>
            </div>
          </div>
          <div class="rounded-lg bg-surface-soft border border-line px-3 py-2 text-[12px]">
            <span class="font-semibold text-muted">対象:</span>
            {{ targetLabel(selected.domain, selected.targetId) }}
          </div>
          <p class="whitespace-pre-wrap text-[13px] leading-relaxed">{{ selected.body || '（本文なし）' }}</p>
          <div v-if="selected.tags.length > 0" class="flex flex-wrap gap-1">
            <span
              v-for="t in selected.tags"
              :key="t"
              class="rounded-full bg-surface-soft border border-line px-2 py-0.5 text-[11px] text-sub"
            >{{ t }}</span>
          </div>
        </div>
        <UiSchemaForm v-else v-model="form" :fields="formFields" :errors="errors" />

        <template #footer>
          <div v-if="mode === 'view' && selected" class="flex items-center justify-between gap-2">
            <button v-if="selected.active" type="button" class="btn btn-danger btn-sm" @click="archiveSelected">無効化</button>
            <button v-else type="button" class="btn btn-sm" @click="restoreSelected">復元</button>
            <button type="button" class="btn btn-primary" @click="openEdit">編集</button>
          </div>
          <div v-else class="flex items-center justify-end gap-2">
            <button type="button" class="btn" @click="cancelEdit">キャンセル</button>
            <button type="button" class="btn btn-primary" @click="save">保存</button>
          </div>
        </template>
      </UiDrawer>
    </template>
  </MastersMasterShell>
</template>
