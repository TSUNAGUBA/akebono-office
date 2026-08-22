<script setup lang="ts">
/**
 * 営業アプローチリスト（/sales-approach。改善要望 2026-08-21・F-53）。
 * 顧客基本情報・顧客属性・顧客コンテキストを基に「アプローチする / している顧客」を 1社1行で管理する。
 * - 一覧（20 件ページング = X-7）+ 検索 / 状態チップ / 担当・優先度フィルタ
 * - 行押下で詳細ドロワー（基本情報・属性・コンテキスト・活動実績のライブ参照 + アプローチ情報）
 * - 登録 / 編集モーダル（会社はコンボボックス = 既存マスタから選択）・取消 / 復元（原則9.5）
 * - 顧客別ダッシュボード（/customer-dashboard?company=）・顧客コンテキストへのドリルダウン導線
 */
import { ExternalLink, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-vue-next'
import { SALES_APPROACH_PRIORITIES, SALES_APPROACH_STATUSES } from '~/types/domain'
import type { Company, CustomerLog, Industry, Member, SalesActivity, SalesApproach } from '~/types/domain'
import { hasContextInfo, isOpenDealPhase } from '../../../../shared/domain/customer-insight'
import { fmtDate, fmtDateLong } from '~/utils/format'
import type { TableColumn } from '~/types/ui'
import {
  SALES_APPROACH_PRIORITY_TONES, SALES_APPROACH_STATUS_TONES, type SalesApproachInput,
} from '~/composables/useSalesApproaches'

const approaches = useSalesApproaches()
const { tbl } = useMockDb()
const { currentUser } = useCurrentUser()
const { show } = useToast()
const confirm = useConfirm()
const cl = useCustomerLogs()
const ctx = useCustomerContext()
cl.ensureLoaded()

// 顧客(会社)のみが対象（kind='customer' = 顧客活動・顧客別ダッシュボードと同一判定。自社は登録不可 = レビュー R1）
const companies = computed(() => (tbl('companies').value as Company[]).filter(c => c.active && c.kind === 'customer'))
const industries = computed(() => tbl('industries').value as Industry[])
const members = computed(() => (tbl('members').value as Member[]).filter(m => m.active !== false))
const salesActivities = computed(() =>
  (tbl('salesActivities').value as SalesActivity[]).filter(a => a.active !== false))

function companyOf(id: string): Company | null {
  return (tbl('companies').value as Company[]).find(c => c.id === id) ?? null
}
function memberName(id: string): string {
  return (tbl('members').value as Member[]).find(m => m.id === id)?.name ?? id
}
function industryName(c: Company | null): string {
  if (!c?.primaryIndustryId) return ''
  return industries.value.find(i => i.id === c.primaryIndustryId)?.name ?? ''
}
/** 会社ごとの最終接点（顧客活動の最大 logDate）。ライブ導出（SoT = customerLogs） */
const lastContactByCompany = computed(() => {
  const map = new Map<string, string>()
  for (const l of cl.allLogs() as CustomerLog[]) {
    if (l.active === false) continue
    const cur = map.get(l.companyId)
    if (!cur || l.logDate > cur) map.set(l.companyId, l.logDate)
  }
  return map
})
/** 会社ごとの進行中案件数（判定 = 共有 isOpenDealPhase）。ライブ導出（SoT = salesActivities） */
const openDealsByCompany = computed(() => {
  const map = new Map<string, number>()
  for (const a of salesActivities.value) {
    if (!isOpenDealPhase(a.phase)) continue
    map.set(a.companyId, (map.get(a.companyId) ?? 0) + 1)
  }
  return map
})

// ---------- フィルタ ----------
const search = ref('')
const statusFilter = ref('')
const assigneeFilter = ref('')
const priorityFilter = ref('')

const statusOptions = [{ value: '', label: 'すべて' }, ...SALES_APPROACH_STATUSES.map(s => ({ value: s, label: s }))]
const priorityOptions = computed(() => [
  { value: '', label: '優先度' }, ...SALES_APPROACH_PRIORITIES.map(p => ({ value: p, label: p })),
])
const assigneeOptions = computed(() => [
  { value: '', label: '担当' }, ...members.value.map(m => ({ value: m.id, label: m.name })),
])

const PRIORITY_RANK: Record<string, number> = { 高: 0, 中: 1, 低: 2 }

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return approaches.list()
    .filter((r) => {
      if (statusFilter.value && r.status !== statusFilter.value) return false
      if (assigneeFilter.value && r.assigneeMemberId !== assigneeFilter.value) return false
      if (priorityFilter.value && r.priority !== priorityFilter.value) return false
      if (!q) return true
      const c = companyOf(r.companyId)
      return [c?.name ?? '', r.nextAction, r.note, memberName(r.assigneeMemberId)]
        .some(s => s.toLowerCase().includes(q))
    })
    // 優先度（高→低）→ 次のアクション日（近い順・未設定は後ろ）→ 作成降順
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
      || (a.nextActionDate ?? '9999-12-31').localeCompare(b.nextActionDate ?? '9999-12-31')
      || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
})

const { page, pageSize, rows: paged, total } = useListView<SalesApproach>({ source: filtered })
watch([search, statusFilter, assigneeFilter, priorityFilter], () => { page.value = 1 })

const columns: TableColumn[] = [
  { key: 'company', label: '顧客(会社)', primary: true },
  { key: 'industry', label: '業種' },
  { key: 'status', label: '状態', primary: true },
  { key: 'priority', label: '優先度' },
  { key: 'assignee', label: '担当' },
  { key: 'nextAction', label: '次のアクション' },
  { key: 'lastContact', label: '最終接点', align: 'right' },
  { key: 'context', label: 'コンテキスト' },
]

const tableRows = computed(() => paged.value.map((r) => {
  const c = companyOf(r.companyId)
  return {
    id: r.id,
    company: c?.name ?? r.companyId,
    industry: industryName(c),
    status: r.status,
    priority: r.priority,
    assignee: memberName(r.assigneeMemberId),
    nextAction: r.nextAction,
    nextActionDate: r.nextActionDate,
    lastContact: lastContactByCompany.value.get(r.companyId) ?? null,
    hasContext: hasContextInfo(ctx.contextOf(r.companyId)),
  }
}))

// ---------- 詳細ドロワー ----------
const detailId = ref<string | null>(null)
const detail = computed(() => approaches.list().find(r => r.id === detailId.value)
  ?? approaches.archivedList().find(r => r.id === detailId.value) ?? null)
const detailCompany = computed(() => (detail.value ? companyOf(detail.value.companyId) : null))
const detailContext = computed(() => (detail.value ? ctx.contextOf(detail.value.companyId) : null))
const detailStats = computed(() => {
  const d = detail.value
  if (!d) return null
  const logs = (cl.allLogs() as CustomerLog[]).filter(l => l.companyId === d.companyId && l.active !== false)
  return {
    logCount: logs.length,
    lastContact: lastContactByCompany.value.get(d.companyId) ?? null,
    openDeals: openDealsByCompany.value.get(d.companyId) ?? 0,
  }
})

function openDetail(rowId: unknown): void {
  detailId.value = String(rowId)
}

// ---------- 登録・編集 ----------
const composeOpen = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const form = ref<SalesApproachInput>(emptyForm())
const companyText = ref('')

function emptyForm(): SalesApproachInput {
  return {
    companyId: '',
    status: '候補',
    priority: '中',
    assigneeMemberId: currentUser.value.id,
    nextAction: '',
    nextActionDate: null,
    note: '',
  }
}

const companyOptions = computed(() => companies.value.map(c => ({ value: c.id, label: c.name })))
const memberOptions = computed(() => members.value.map(m => ({ value: m.id, label: m.name })))

function openCreate(): void {
  editingId.value = null
  form.value = emptyForm()
  companyText.value = ''
  composeOpen.value = true
}

function openEdit(r: SalesApproach): void {
  editingId.value = r.id
  form.value = {
    companyId: r.companyId,
    status: r.status,
    priority: r.priority,
    assigneeMemberId: r.assigneeMemberId,
    nextAction: r.nextAction,
    nextActionDate: r.nextActionDate,
    note: r.note,
  }
  companyText.value = companyOf(r.companyId)?.name ?? ''
  composeOpen.value = true
}

async function submit(): Promise<void> {
  if (saving.value) return
  if (!form.value.companyId) { show('顧客(会社)を選択してください', 'warn'); return }
  saving.value = true
  try {
    const res = await approaches.save(editingId.value, form.value)
    if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
    show(editingId.value ? 'アプローチ情報を更新しました' : 'アプローチリストへ登録しました')
    composeOpen.value = false
  } finally { saving.value = false }
}

// ---------- 取消 / 復元（原則9.5） ----------
const showArchived = ref(false)
const restoring = ref(false)

async function onArchive(r: SalesApproach): Promise<void> {
  const name = companyOf(r.companyId)?.name ?? r.companyId
  const ok = await confirm.ask('アプローチの取消', `「${name}」をアプローチリストから取り消しますか？（復元できます）`,
    { danger: true, confirmLabel: '取り消す' })
  if (!ok) return
  const res = await approaches.archive(r.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  detailId.value = null
  show('取り消しました', 'warn')
}

async function onRestore(r: SalesApproach): Promise<void> {
  if (restoring.value) return
  restoring.value = true
  try {
    const res = await approaches.restore(r.id)
    if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
    show('復元しました')
  } finally { restoring.value = false }
}

/** コンテキストの定性情報プレビュー（先頭 120 字） */
function ctxPreview(s: string): string {
  const chars = [...s.replace(/\s+/g, ' ').trim()]
  return chars.length > 120 ? `${chars.slice(0, 120).join('')}…` : chars.join('')
}
</script>

<template>
  <div class="grid gap-3">
    <UiFilterBar>
      <UiSearchInput v-model="search" placeholder="会社名・担当・次のアクション・メモで検索" aria-label="アプローチ検索" />
      <UiChipTabs v-model="statusFilter" :options="statusOptions" aria-label="状態で絞り込み" />
      <template #trailing>
        <UiSelect v-model="priorityFilter" :options="priorityOptions" aria-label="優先度で絞り込み" class="w-auto" />
        <UiSelect v-model="assigneeFilter" :options="assigneeOptions" aria-label="担当で絞り込み" class="w-auto" />
      </template>
    </UiFilterBar>

    <UiSectionCard
      :title="`アプローチリスト（${filtered.length}件）`"
      description="顧客基本情報・属性・顧客コンテキストと合わせてアプローチ状況を管理します。行を押すと詳細を表示します"
      flush
    >
      <template #actions>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          顧客を追加
        </button>
      </template>

      <UiEmptyState
        v-if="filtered.length === 0"
        icon="ListChecks"
        title="アプローチリストはまだ空です"
        hint="「顧客を追加」から、アプローチする顧客(会社)と状態・担当・次のアクションを登録します"
      />
      <template v-else>
        <UiDataTable :columns="columns" :rows="tableRows" row-key="id" clickable @row-click="row => openDetail(row.id)">
          <template #cell-status="{ value }">
            <UiStatusBadge :label="String(value)" :tone="SALES_APPROACH_STATUS_TONES[String(value)] ?? 'neutral'" dot />
          </template>
          <template #cell-priority="{ value }">
            <UiStatusBadge :label="String(value)" :tone="SALES_APPROACH_PRIORITY_TONES[String(value)] ?? 'neutral'" />
          </template>
          <template #cell-nextAction="{ row }">
            <span class="text-[12px]">
              {{ row.nextAction || '—' }}
              <span v-if="row.nextActionDate" class="num text-[11px] text-muted">（{{ fmtDate(String(row.nextActionDate)) }}）</span>
            </span>
          </template>
          <template #cell-lastContact="{ value }">
            <span v-if="value" class="num text-[12px]">{{ fmtDate(String(value)) }}</span>
            <span v-else class="text-[11px] text-muted">接点なし</span>
          </template>
          <template #cell-context="{ row }">
            <UiStatusBadge v-if="row.hasContext" label="整備済み" tone="ok" />
            <UiStatusBadge v-else label="未整備" tone="neutral" />
          </template>
        </UiDataTable>
        <div class="px-4 pb-3">
          <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />
        </div>
      </template>

      <!-- 取消済み（復元導線 = 原則9.5） -->
      <div v-if="approaches.archivedList().length > 0" class="border-t border-line px-4 py-2">
        <button type="button" class="btn btn-ghost btn-sm" @click="showArchived = !showArchived">
          {{ showArchived ? '取消済みを隠す' : `取消済みを表示（${approaches.archivedList().length}件）` }}
        </button>
        <ul v-if="showArchived" class="mt-1 divide-y divide-line">
          <li v-for="r in approaches.archivedList()" :key="r.id" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
            <span class="text-[13px] text-muted line-through">{{ companyOf(r.companyId)?.name ?? r.companyId }}</span>
            <span class="num ml-auto text-[11px] text-muted">{{ fmtDateLong(r.createdAt) }}</span>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="restoring" :aria-label="`「${companyOf(r.companyId)?.name ?? r.companyId}」を復元する`" @click="onRestore(r)">
              <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
              元に戻す
            </button>
          </li>
        </ul>
      </div>
    </UiSectionCard>

    <!-- 詳細ドロワー -->
    <UiDrawer :open="!!detail" :title="detailCompany?.name ?? ''" width="560px" @close="detailId = null">
      <div v-if="detail" class="grid gap-4">
        <div class="flex flex-wrap items-center gap-2">
          <UiStatusBadge :label="detail.status" :tone="SALES_APPROACH_STATUS_TONES[detail.status] ?? 'neutral'" dot />
          <UiStatusBadge :label="`優先度 ${detail.priority}`" :tone="SALES_APPROACH_PRIORITY_TONES[detail.priority] ?? 'neutral'" />
          <UiStatusBadge v-if="detail.active === false" label="取消済み" tone="crit" />
          <span class="ml-auto flex items-center gap-1">
            <button v-if="detail.active !== false" type="button" class="btn btn-ghost btn-sm" @click="openEdit(detail)">
              <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
              編集
            </button>
            <button v-if="detail.active !== false" type="button" class="btn btn-ghost btn-sm" :aria-label="`「${detailCompany?.name}」を取り消す`" @click="onArchive(detail)">
              <Trash2 class="h-3.5 w-3.5 text-crit" aria-hidden="true" />
            </button>
            <button v-else type="button" class="btn btn-ghost btn-sm" :disabled="restoring" @click="onRestore(detail)">
              <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
              元に戻す
            </button>
          </span>
        </div>

        <!-- アプローチ情報 -->
        <div class="grid gap-1 rounded-lg border border-line p-3">
          <p class="label">アプローチ情報</p>
          <p class="text-[12px]"><span class="text-muted">担当:</span> {{ memberName(detail.assigneeMemberId) }}</p>
          <p class="text-[12px]">
            <span class="text-muted">次のアクション:</span>
            {{ detail.nextAction || '—' }}
            <span v-if="detail.nextActionDate" class="num text-muted">（{{ fmtDate(detail.nextActionDate) }}）</span>
          </p>
          <p v-if="detail.note" class="whitespace-pre-wrap text-[12px] text-sub">{{ detail.note }}</p>
        </div>

        <!-- 顧客基本情報・属性（SoT = companies のライブ参照） -->
        <div class="grid gap-1 rounded-lg border border-line p-3">
          <p class="label">顧客基本情報・属性</p>
          <p class="text-[12px]"><span class="text-muted">業種:</span> {{ industryName(detailCompany) || '—' }}</p>
          <p class="text-[12px]"><span class="text-muted">規模:</span> {{ detailCompany?.size || '—' }}</p>
          <p class="text-[12px]"><span class="text-muted">所在地:</span> {{ detailCompany?.location || '—' }}</p>
          <p v-if="detailCompany?.description" class="text-[12px] text-sub">{{ detailCompany.description }}</p>
        </div>

        <!-- 顧客コンテキスト（SoT = customerContexts のライブ参照） -->
        <div class="grid gap-1 rounded-lg border border-line p-3">
          <p class="label">顧客コンテキスト</p>
          <template v-if="detailContext && hasContextInfo(detailContext)">
            <p v-if="detailContext.vision" class="text-[12px]"><span class="text-muted">ビジョン:</span> {{ ctxPreview(detailContext.vision) }}</p>
            <p v-if="detailContext.challenges" class="text-[12px]"><span class="text-muted">経営課題:</span> {{ ctxPreview(detailContext.challenges) }}</p>
            <p v-if="detailContext.businessNotes" class="text-[12px]"><span class="text-muted">事業メモ:</span> {{ ctxPreview(detailContext.businessNotes) }}</p>
          </template>
          <p v-else class="text-[12px] text-muted">定性情報は未整備です（顧客コンテキストで整備できます）</p>
        </div>

        <!-- 活動実績（ライブ導出） -->
        <div v-if="detailStats" class="grid grid-cols-3 gap-2">
          <div class="rounded-lg border border-line p-2 text-center">
            <p class="num text-[16px] font-bold">{{ detailStats.logCount }}</p>
            <p class="text-[10px] text-muted">顧客活動</p>
          </div>
          <div class="rounded-lg border border-line p-2 text-center">
            <p class="num text-[16px] font-bold">{{ detailStats.openDeals }}</p>
            <p class="text-[10px] text-muted">進行中案件</p>
          </div>
          <div class="rounded-lg border border-line p-2 text-center">
            <p class="num text-[13px] font-bold">{{ detailStats.lastContact ? fmtDate(detailStats.lastContact) : '—' }}</p>
            <p class="text-[10px] text-muted">最終接点</p>
          </div>
        </div>

        <!-- ドリルダウン導線 -->
        <div class="flex flex-wrap gap-2">
          <NuxtLink :to="`/customer-dashboard?company=${detail.companyId}`" class="btn btn-sm">
            <ExternalLink class="h-3.5 w-3.5" aria-hidden="true" />
            顧客別ダッシュボード
          </NuxtLink>
          <NuxtLink :to="`/customer-context?company=${detail.companyId}`" class="btn btn-sm">
            <ExternalLink class="h-3.5 w-3.5" aria-hidden="true" />
            顧客コンテキスト
          </NuxtLink>
        </div>
      </div>
    </UiDrawer>

    <!-- 登録・編集モーダル -->
    <UiModal
      :open="composeOpen"
      :title="editingId ? 'アプローチ情報を編集' : 'アプローチする顧客を追加'"
      width="560px"
      @close="composeOpen = false"
    >
      <div class="grid gap-3">
        <UiFormField label="顧客(会社)" required hint="既存の顧客マスタから選択します（1社1行）">
          <UiCombobox
            v-model="form.companyId"
            v-model:text="companyText"
            :options="companyOptions"
            :allow-create="false"
            :disabled="!!editingId"
            placeholder="会社名で検索・選択"
            aria-label="顧客(会社)"
          />
        </UiFormField>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="アプローチ状態" required>
            <UiSelect v-model="form.status" :options="SALES_APPROACH_STATUSES.map(s => ({ value: s, label: s }))" aria-label="アプローチ状態" />
          </UiFormField>
          <UiFormField label="優先度" required>
            <UiSelect v-model="form.priority" :options="SALES_APPROACH_PRIORITIES.map(p => ({ value: p, label: p }))" aria-label="優先度" />
          </UiFormField>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="担当" hint="既定はログインユーザー">
            <UiSelect v-model="form.assigneeMemberId" :options="memberOptions" aria-label="担当" />
          </UiFormField>
          <UiFormField label="次のアクション日">
            <input
              :value="form.nextActionDate ?? ''"
              type="date"
              class="input"
              aria-label="次のアクション日"
              @input="form.nextActionDate = ($event.target as HTMLInputElement).value || null"
            >
          </UiFormField>
        </div>
        <UiFormField label="次のアクション">
          <input v-model="form.nextAction" type="text" class="input" placeholder="例）決裁者との顔合わせを設定" aria-label="次のアクション">
        </UiFormField>
        <UiFormField label="アプローチ方針・メモ">
          <textarea v-model="form.note" class="textarea min-h-20" placeholder="例）既存の SCM 導入実績を起点に、物流領域の課題をヒアリング" aria-label="アプローチ方針・メモ" />
        </UiFormField>
      </div>
      <template #footer>
        <div class="flex items-center justify-end gap-2">
          <button type="button" class="btn" @click="composeOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" :disabled="saving" @click="submit">
            {{ saving ? '保存中…' : editingId ? '更新' : '登録' }}
          </button>
        </div>
      </template>
    </UiModal>
  </div>
</template>
