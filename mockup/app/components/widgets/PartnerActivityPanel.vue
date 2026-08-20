<script setup lang="ts">
/**
 * ビジネスパートナー活動パネル（改修依頼 2026-08-18・F-45 → 2026-08-19 第4弾 →
 * 2026-08-20 改修で「案件ヘッダー + 活動ログ」構造へ再編）。
 * 案件（連携テーマ）の一覧。行クリックで**案件詳細ページ（/partner-activity/<id>）へ遷移**し、
 * 詳細では基本情報・AI集約・活動ログを確認できる（旧: 詳細ドロワーは詳細ページへ置換）。
 * - 新規案件の登録はこの一覧に配置（編集は詳細ページ側）。フォームは WidgetsPartnerActivityFormDrawer（共通部品）。
 * - 営業活動パネルと同じ構成（メニューは統合しない・内部処理は共通部品で共通化 = 原則3）。
 * - AI集約サマリー（truncate）+ ステータスバッジを一覧で確認できる（要件4「ステータスと共に」）。
 * - 取消済み案件の復元（原則9.5）。
 */
import { Plus, RefreshCw, RotateCcw } from 'lucide-vue-next'
import { PARTNER_ACTIVITY_STATUSES, PARTNER_ACTIVITY_TYPES } from '../../../../shared/domain/types'
import type { Company, Member, PartnerActivity } from '~/types/domain'
import type { TableColumn } from '~/types/ui'

const pact = usePartnerActivities()
const { tbl } = useMockDb()
const { show } = useToast()

const members = tbl('members')

function memberName(id: string): string {
  return (members.value as Member[]).find(m => m.id === id)?.name ?? id
}
function companyName(id: string | null | undefined): string {
  if (!id) return ''
  return (tbl('companies').value as Company[]).find(c => c.id === id)?.name ?? ''
}
/** パートナー会社の表示名（FK 優先・旧行は自由入力スナップショット partnerName へフォールバック = 下位互換） */
function partnerCompanyLabel(r: PartnerActivity): string {
  return companyName(r.partnerCompanyId) || r.partnerName || '—'
}
function fmtDateKey(d: string | null): string {
  return d ? d.replace(/-/g, '/') : '—'
}

// ---------- 一覧（検索 + フィルタ + ページング。デュアルモード） ----------

const statusFilter = ref('')
const typeFilter = ref('')
const statusOptions = PARTNER_ACTIVITY_STATUSES.map(v => ({ value: v, label: v }))
const typeOptions = PARTNER_ACTIVITY_TYPES.map(v => ({ value: v, label: v }))

const filterPredicate = computed(() => (r: PartnerActivity): boolean => {
  if (statusFilter.value && r.status !== statusFilter.value) return false
  if (typeFilter.value && r.activityType !== typeFilter.value) return false
  return true
})
const filterParams = computed(() => {
  const p: Record<string, string> = { 'f.active': 'true' }
  if (statusFilter.value) p['f.status'] = statusFilter.value
  if (typeFilter.value) p['f.activityType'] = typeFilter.value
  return p
})

const lv = useListView<PartnerActivity>({
  source: computed(() => pact.list()),
  // クライアント検索の対象はサーバー searchCols（パートナー/テーマ/関連企業/背景・目的/取組内容/現在状況/Next Action/メモ）と揃える
  match: (r, q) => [r.partnerName, r.theme, r.relatedCompany, r.summary, r.initiatives, r.currentState, r.nextAction, r.memo]
    .some(v => (v ?? '').toLowerCase().includes(q)),
  fetch: p => apiListPage<PartnerActivity>('partnerActivities', p),
  filterPredicate,
  filterParams,
})

const columns: TableColumn[] = [
  { key: 'partnerLabel', label: 'パートナー会社', primary: true },
  { key: 'theme', label: 'テーマ名', primary: true },
  { key: 'activityType', label: '活動区分', width: '90px' },
  { key: 'status', label: 'ステータス', primary: true, width: '96px' },
  { key: 'aiSummary', label: 'AI集約', sortable: false },
  { key: 'nextAction', label: 'Next Action' },
  { key: 'nextLabel', label: 'Next Action日', width: '110px' },
  { key: 'staffName', label: '担当', width: '90px' },
]

const tableRows = computed(() =>
  lv.rows.value.map(r => ({
    ...r,
    partnerLabel: partnerCompanyLabel(r),
    aiSummary: r.aiDigest?.summary ?? '',
    nextLabel: fmtDateKey(r.nextActionDate),
    staffName: memberName(r.staffMemberId),
  })) as unknown as Record<string, unknown>[])

function asRow(row: Record<string, unknown>): PartnerActivity {
  return row as unknown as PartnerActivity
}

/** 行クリック → 案件詳細ページへ遷移（要件2: ページ遷移で基本情報 + ログ一覧を確認） */
function openDetail(row: Record<string, unknown>): void {
  void navigateTo(`/partner-activity/${String(row.id)}`)
}

// ---------- 新規案件の登録（共通フォームドロワー） ----------

const createOpen = ref(false)

function onSaved(id: string): void {
  createOpen.value = false
  lv.refresh()
  // 登録直後に案件詳細へ誘導（ログを積む導線）
  if (id) void navigateTo(`/partner-activity/${id}`)
}

// ---------- 取消済みの復元（原則9.5） ----------

const restoring = ref(false)
const showArchived = ref(false)
const archived = computed(() => pact.archivedList())

async function onRestore(r: PartnerActivity): Promise<void> {
  if (restoring.value) return
  restoring.value = true
  try {
    const res = await pact.restore(r.id)
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
      <UiSearchInput v-model="lv.query.value" placeholder="パートナー会社・テーマ・アプローチ企業で検索" />
      <UiSelect v-model="statusFilter" :options="statusOptions" empty-label="すべてのステータス" aria-label="ステータスで絞り込み" class="w-auto" />
      <UiSelect v-model="typeFilter" :options="typeOptions" empty-label="すべての活動区分" aria-label="活動区分で絞り込み" class="w-auto" />
      <template #trailing>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="再読み込み" @click="pact.refresh(); lv.refresh()">
          <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button type="button" class="btn btn-primary btn-sm" @click="createOpen = true">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          案件を登録
        </button>
      </template>
    </UiFilterBar>

    <UiSectionCard :title="`ビジネスパートナー活動 案件一覧（${lv.total.value}件）`" description="行をクリックすると案件詳細（基本情報・AI集約・活動ログ）へ移動します" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="該当する案件がありません"
        empty-hint="「案件を登録」からパートナー連携テーマの基本情報を登録できます"
        @row-click="openDetail"
      >
        <template #cell-status="{ row }">
          <UiStatusBadge :label="asRow(row).status" :tone="PARTNER_STATUS_TONES[asRow(row).status] ?? 'neutral'" dot />
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
            <span class="text-[13px] text-muted line-through">{{ partnerCompanyLabel(r) }} / {{ r.theme }}</span>
            <button type="button" class="btn btn-ghost btn-sm ml-auto" :disabled="restoring" :aria-label="`「${r.theme}」を復元する`" @click="onRestore(r)">
              <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
              元に戻す
            </button>
          </li>
        </ul>
      </div>
    </UiSectionCard>

    <WidgetsPartnerActivityFormDrawer :open="createOpen" mode="create" @close="createOpen = false" @saved="onSaved" />
  </div>
</template>
