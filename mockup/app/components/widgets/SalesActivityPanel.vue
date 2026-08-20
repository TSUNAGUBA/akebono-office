<script setup lang="ts">
/**
 * 営業活動パネル（改修依頼 2026-08-18・F-44 → 2026-08-20 改修で「案件ヘッダー + 活動ログ」構造へ再編）。
 * 案件（商談）の一覧。行クリックで**案件詳細ページ（/sales-activity/<id>）へ遷移**し、
 * 詳細では基本情報・AI集約・活動ログを確認できる（旧: 詳細ドロワーは詳細ページへ置換）。
 * - 新規案件の登録はこの一覧に配置（編集は詳細ページ側）。フォームは WidgetsSalesActivityFormDrawer（共通部品）。
 * - 一覧は useListView（1 ページ 20 件。モック = クライアント / API = サーバーページング）+ UiPagination。
 * - AI集約サマリー（truncate）+ フェーズバッジを一覧で確認できる（要件4「ステータスと共に」）。
 * - 取消済み案件の復元（原則9.5）。
 */
import { Plus, RefreshCw, RotateCcw } from 'lucide-vue-next'
import { SALES_ACTIVITY_DEAL_TYPES, SALES_ACTIVITY_PHASES } from '../../../../shared/domain/types'
import type { Company, Member, SalesActivity } from '~/types/domain'
import type { TableColumn } from '~/types/ui'
import { fmtYen } from '~/utils/format'

const sal = useSalesActivities()
const { tbl } = useMockDb()
const { show } = useToast()

const members = tbl('members')

function companyName(id: string): string {
  return (tbl('companies').value as Company[]).find(c => c.id === id)?.name ?? id
}
function memberName(id: string): string {
  return (members.value as Member[]).find(m => m.id === id)?.name ?? id
}
function fmtAmount(n: number | null): string {
  return n === null ? '—' : fmtYen(n)
}

// ---------- 一覧（検索 + フィルタ + ページング。デュアルモード） ----------

const phaseFilter = ref('')
const dealTypeFilter = ref('')
const phaseOptions = SALES_ACTIVITY_PHASES.map(v => ({ value: v, label: v }))
const dealTypeOptions = SALES_ACTIVITY_DEAL_TYPES.map(v => ({ value: v, label: v }))

const filterPredicate = computed(() => (r: SalesActivity): boolean => {
  if (phaseFilter.value && r.phase !== phaseFilter.value) return false
  if (dealTypeFilter.value && r.dealType !== dealTypeFilter.value) return false
  return true
})
const filterParams = computed(() => {
  const p: Record<string, string> = { 'f.active': 'true' }
  if (phaseFilter.value) p['f.phase'] = phaseFilter.value
  if (dealTypeFilter.value) p['f.dealType'] = dealTypeFilter.value
  return p
})

const lv = useListView<SalesActivity>({
  source: computed(() => sal.list()),
  // クライアント検索の対象はサーバー searchCols（商談名/顧客名/顧客課題/提案概要/Next Action）と揃える
  match: (r, q) => [r.title, companyName(r.companyId), r.customerIssue, r.proposal, r.nextAction]
    .some(v => (v ?? '').toLowerCase().includes(q)),
  fetch: p => apiListPage<SalesActivity>('salesActivities', p),
  filterPredicate,
  filterParams,
})

const columns: TableColumn[] = [
  { key: 'companyName', label: '顧客', primary: true },
  { key: 'title', label: '商談名', primary: true },
  { key: 'phase', label: 'フェーズ', primary: true, width: '96px' },
  { key: 'aiSummary', label: 'AI集約', sortable: false },
  { key: 'amountLabel', label: '商談金額', align: 'right', width: '110px' },
  { key: 'nextAction', label: 'Next Action' },
  { key: 'staffName', label: '担当', width: '90px' },
]

const tableRows = computed(() =>
  lv.rows.value.map(r => ({
    ...r,
    companyName: companyName(r.companyId),
    aiSummary: r.aiDigest?.summary ?? '',
    amountLabel: fmtAmount(r.amount),
    staffName: memberName(r.staffMemberId),
  })) as unknown as Record<string, unknown>[])

function asRow(row: Record<string, unknown>): SalesActivity {
  return row as unknown as SalesActivity
}

/** 行クリック → 案件詳細ページへ遷移（要件2: ページ遷移で基本情報 + ログ一覧を確認） */
function openDetail(row: Record<string, unknown>): void {
  void navigateTo(`/sales-activity/${String(row.id)}`)
}

// ---------- 新規案件の登録（共通フォームドロワー） ----------

const createOpen = ref(false)

function onSaved(id: string): void {
  createOpen.value = false
  lv.refresh()
  // 登録直後に案件詳細へ誘導（ログを積む導線）
  if (id) void navigateTo(`/sales-activity/${id}`)
}

// ---------- 取消済みの復元（原則9.5） ----------

const restoring = ref(false)
const showArchived = ref(false)
const archived = computed(() => sal.archivedList())

async function onRestore(r: SalesActivity): Promise<void> {
  if (restoring.value) return
  restoring.value = true
  try {
    const res = await sal.restore(r.id)
    if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
    show('復元しました')
    lv.refresh()
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <div class="grid gap-3">
    <UiFilterBar>
      <UiSearchInput v-model="lv.query.value" placeholder="商談名・顧客名・課題で検索" />
      <UiSelect v-model="phaseFilter" :options="phaseOptions" empty-label="すべてのフェーズ" aria-label="商談フェーズで絞り込み" class="w-auto" />
      <UiSelect v-model="dealTypeFilter" :options="dealTypeOptions" empty-label="すべての種別" aria-label="商談種別で絞り込み" class="w-auto" />
      <template #trailing>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="再読み込み" @click="sal.refresh(); lv.refresh()">
          <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button type="button" class="btn btn-primary btn-sm" @click="createOpen = true">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          案件を登録
        </button>
      </template>
    </UiFilterBar>

    <UiSectionCard :title="`営業活動 案件一覧（${lv.total.value}件）`" description="行をクリックすると案件詳細（基本情報・AI集約・活動ログ）へ移動します" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="該当する案件がありません"
        empty-hint="「案件を登録」から商談の基本情報を登録できます"
        @row-click="openDetail"
      >
        <template #cell-phase="{ row }">
          <UiStatusBadge :label="asRow(row).phase" :tone="SALES_PHASE_TONES[asRow(row).phase] ?? 'neutral'" dot />
        </template>
        <template #cell-aiSummary="{ row }">
          <span v-if="asRow(row).aiDigest" class="line-clamp-2 max-w-[320px] whitespace-normal text-xs text-sub" :title="asRow(row).aiDigest?.summary">
            {{ asRow(row).aiDigest?.summary }}
          </span>
          <span v-else class="text-xs text-muted">—</span>
        </template>
      </UiDataTable>
      <div class="px-4 pb-3">
        <UiPagination v-model:page="lv.page.value" v-model:page-size="lv.pageSize.value" :total="lv.total.value" />
      </div>

      <!-- 取消済み（復元 = 原則9.5） -->
      <div v-if="archived.length > 0" class="border-t border-line px-4 py-2">
        <button type="button" class="btn btn-ghost btn-sm" @click="showArchived = !showArchived">
          {{ showArchived ? '取消済みを隠す' : `取消済みを表示（${archived.length}件）` }}
        </button>
        <ul v-if="showArchived" class="mt-1 divide-y divide-line">
          <li v-for="r in archived" :key="r.id" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
            <span class="text-[13px] text-muted line-through">{{ companyName(r.companyId) }} / {{ r.title }}</span>
            <button type="button" class="btn btn-ghost btn-sm ml-auto" :disabled="restoring" :aria-label="`「${r.title}」を復元する`" @click="onRestore(r)">
              <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
              元に戻す
            </button>
          </li>
        </ul>
      </div>
    </UiSectionCard>

    <WidgetsSalesActivityFormDrawer :open="createOpen" mode="create" @close="createOpen = false" @saved="onSaved" />
  </div>
</template>
