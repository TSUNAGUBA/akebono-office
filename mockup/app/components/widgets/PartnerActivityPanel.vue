<script setup lang="ts">
/**
 * ビジネスパートナー活動パネル（改修依頼 2026-08-18・F-45）。
 * パートナー連携のテーマ（紹介/共創/案件支援等）を記録・一覧・編集・取消/復元する。
 * - チーム共有の記録系: 全員が閲覧・登録・編集できる（訂正履歴は API モードの監査ログ）。
 * - 一覧は useListView（1 ページ 20 件。モック = クライアント / API = サーバーページング）+ UiPagination。
 * - パートナー・関連企業は自由入力（マスタ参照にしない設計判断 = shared/domain/types.ts 参照）。
 * - 関連商談は営業活動への任意リンク（「案件化したら商談へリンク」。詳細から /sales-activity へ遷移可）。
 * - 取消（論理削除）+ 復元（原則9.5）。
 */
import { ExternalLink, Plus, RefreshCw, RotateCcw } from 'lucide-vue-next'
import { PARTNER_ACTIVITY_STATUSES, PARTNER_ACTIVITY_TYPES } from '../../../../shared/domain/types'
import type { Member, PartnerActivity } from '~/types/domain'
import type { TableColumn } from '~/types/ui'

const pact = usePartnerActivities()
const sal = useSalesActivities()
const { tbl } = useMockDb()
const { show } = useToast()
const confirm = useConfirm()
const { currentUserId } = useCurrentUser()

const members = tbl('members')

function memberName(id: string): string {
  return (members.value as Member[]).find(m => m.id === id)?.name ?? id
}
function fmtDateKey(d: string | null): string {
  return d ? d.replace(/-/g, '/') : '—'
}
/** 関連商談の表示名（営業活動の商談名。解決できない id はそのまま表示しない = '—'） */
function salesTitleOf(id: string | null): string {
  const s = sal.byId(id)
  return s ? s.title : ''
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
  // クライアント検索の対象はサーバー searchCols（パートナー/テーマ/関連企業/概要/現在状況/Next Action/メモ）と揃える
  match: (r, q) => [r.partnerName, r.theme, r.relatedCompany, r.summary, r.currentState, r.nextAction, r.memo]
    .some(v => (v ?? '').toLowerCase().includes(q)),
  fetch: p => apiListPage<PartnerActivity>('partnerActivities', p),
  filterPredicate,
  filterParams,
})

const columns: TableColumn[] = [
  { key: 'partnerName', label: 'パートナー', primary: true },
  { key: 'theme', label: 'テーマ名', primary: true },
  { key: 'relatedCompanyLabel', label: '関連企業' },
  { key: 'activityType', label: '活動区分', width: '90px' },
  { key: 'status', label: 'ステータス', primary: true, width: '96px' },
  { key: 'nextAction', label: 'Next Action' },
  { key: 'nextLabel', label: 'Next Action日', width: '110px' },
  { key: 'staffName', label: '担当', width: '90px' },
]

const tableRows = computed(() =>
  lv.rows.value.map(r => ({
    ...r,
    relatedCompanyLabel: r.relatedCompany || '—',
    nextLabel: fmtDateKey(r.nextActionDate),
    staffName: memberName(r.staffMemberId),
  })) as unknown as Record<string, unknown>[])

function asRow(row: Record<string, unknown>): PartnerActivity {
  return row as unknown as PartnerActivity
}

// ---------- 詳細・編集（ドロワー） ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<PartnerActivity | null>(() => {
  if (!selectedId.value) return null
  return pact.list().find(r => r.id === selectedId.value)
    ?? pact.archivedList().find(r => r.id === selectedId.value)
    ?? lv.rows.value.find(r => r.id === selectedId.value)
    ?? null
})
const saving = ref(false)

const drawerTitle = computed(() =>
  mode.value === 'create' ? 'ビジネスパートナー活動を登録' : mode.value === 'edit' ? 'ビジネスパートナー活動を編集' : 'ビジネスパートナー活動の詳細')

const form = ref({
  partnerName: '',
  theme: '',
  relatedCompany: '',
  activityType: '',
  status: '情報収集',
  summary: '',
  currentState: '',
  nextAction: '',
  nextActionDate: '',
  staffMemberId: '',
  relatedMeeting: '',
  relatedSalesActivityId: '',
  memo: '',
})

const staffOptions = computed(() =>
  (members.value as Member[]).filter(m => m.active).map(m => ({
    value: m.id,
    label: m.id === currentUserId.value ? `${m.name}（自分）` : m.name,
  })))
/** 関連商談の選択肢（有効な営業活動。編集中の既存リンクが取消済みでも保持できるよう追加する） */
const salesOptions = computed(() => {
  const options = sal.list().map(s => ({ value: s.id, label: `${s.title}` }))
  const linked = form.value.relatedSalesActivityId
  if (linked && !options.some(o => o.value === linked)) {
    const s = sal.byId(linked)
    if (s) options.push({ value: s.id, label: `${s.title}（取消済み）` })
  }
  return options
})

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  mode.value = 'view'
  drawerOpen.value = true
}

function openCreate(): void {
  selectedId.value = null
  form.value = {
    partnerName: '',
    theme: '',
    relatedCompany: '',
    activityType: '',
    status: '情報収集',
    summary: '',
    currentState: '',
    nextAction: '',
    nextActionDate: '',
    staffMemberId: currentUserId.value,
    relatedMeeting: '',
    relatedSalesActivityId: '',
    memo: '',
  }
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  const s = selected.value
  if (!s) return
  form.value = {
    partnerName: s.partnerName,
    theme: s.theme,
    relatedCompany: s.relatedCompany,
    activityType: s.activityType,
    status: s.status,
    summary: s.summary,
    currentState: s.currentState,
    nextAction: s.nextAction,
    nextActionDate: s.nextActionDate ?? '',
    staffMemberId: s.staffMemberId,
    relatedMeeting: s.relatedMeeting,
    relatedSalesActivityId: s.relatedSalesActivityId ?? '',
    memo: s.memo,
  }
  mode.value = 'edit'
}

function cancelEdit(): void {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const res = await pact.save(mode.value === 'edit' ? selectedId.value : null, {
      partnerName: form.value.partnerName,
      theme: form.value.theme,
      relatedCompany: form.value.relatedCompany,
      activityType: form.value.activityType,
      status: form.value.status,
      summary: form.value.summary,
      currentState: form.value.currentState,
      nextAction: form.value.nextAction,
      nextActionDate: form.value.nextActionDate || null,
      staffMemberId: form.value.staffMemberId || currentUserId.value,
      relatedMeeting: form.value.relatedMeeting,
      relatedSalesActivityId: form.value.relatedSalesActivityId || null,
      memo: form.value.memo,
    })
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    show(mode.value === 'create' ? 'ビジネスパートナー活動を登録しました' : 'ビジネスパートナー活動を更新しました')
    if (res.id) selectedId.value = res.id
    mode.value = 'view'
    lv.refresh()
  } finally {
    saving.value = false
  }
}

// ---------- 取消/復元（原則9.5） ----------

const restoring = ref(false)
const showArchived = ref(false)
const archived = computed(() => pact.archivedList())

async function onArchive(r: PartnerActivity): Promise<void> {
  const ok = await confirm.ask(
    'ビジネスパートナー活動の取消',
    `「${r.theme}」を取り消しますか？（一覧から外れます。あとから復元できます）`,
    { danger: true, confirmLabel: '取り消す' },
  )
  if (!ok) return
  const res = await pact.archive(r.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  drawerOpen.value = false
  show('取り消しました', 'warn')
  lv.refresh()
}

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

const detailRows = computed(() => {
  const s = selected.value
  if (!s) return []
  return [
    { label: 'パートナー', value: s.partnerName },
    { label: 'テーマ名', value: s.theme },
    { label: '関連企業', value: s.relatedCompany || '—' },
    { label: '活動区分', value: s.activityType },
    { label: 'ステータス', value: s.status },
    { label: '概要', value: s.summary || '—' },
    { label: '現在状況', value: s.currentState || '—' },
    { label: 'Next Action', value: s.nextAction || '—' },
    { label: 'Next Action日', value: fmtDateKey(s.nextActionDate) },
    { label: '自社担当者', value: memberName(s.staffMemberId) },
    { label: '関連MTG', value: s.relatedMeeting || '—' },
    { label: 'メモ', value: s.memo || '—' },
    { label: '記録者', value: memberName(s.memberId) },
  ]
})
</script>

<template>
  <div class="grid gap-3">
    <UiFilterBar>
      <UiSearchInput v-model="lv.query.value" placeholder="パートナー・テーマ・関連企業で検索" />
      <UiSelect v-model="statusFilter" :options="statusOptions" empty-label="すべてのステータス" aria-label="ステータスで絞り込み" class="w-auto" />
      <UiSelect v-model="typeFilter" :options="typeOptions" empty-label="すべての活動区分" aria-label="活動区分で絞り込み" class="w-auto" />
      <template #trailing>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="再読み込み" @click="pact.refresh(); lv.refresh()">
          <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          登録する
        </button>
      </template>
    </UiFilterBar>

    <UiSectionCard :title="`ビジネスパートナー活動一覧（${lv.total.value}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="該当するビジネスパートナー活動がありません"
        empty-hint="「登録する」からパートナーとの活動を記録できます"
        @row-click="openDetail"
      >
        <template #cell-status="{ row }">
          <UiStatusBadge :label="asRow(row).status" :tone="PARTNER_STATUS_TONES[asRow(row).status] ?? 'neutral'" dot />
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
            <span class="text-[13px] text-muted line-through">{{ r.partnerName }} / {{ r.theme }}</span>
            <button type="button" class="btn btn-ghost btn-sm ml-auto" :disabled="restoring" :aria-label="`「${r.theme}」を復元する`" @click="onRestore(r)">
              <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
              元に戻す
            </button>
          </li>
        </ul>
      </div>
    </UiSectionCard>

    <UiDrawer :open="drawerOpen" :title="drawerTitle" width="560px" @close="drawerOpen = false">
      <template v-if="mode === 'view' && selected">
        <dl class="grid gap-2 text-[13px]">
          <div
            v-for="r in detailRows"
            :key="r.label"
            class="grid grid-cols-[130px_1fr] gap-2 border-b border-line pb-2 last:border-0"
          >
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">{{ r.label }}</dt>
            <dd class="whitespace-pre-wrap">{{ r.value }}</dd>
          </div>
          <div class="grid grid-cols-[130px_1fr] gap-2">
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">関連商談</dt>
            <dd>
              <NuxtLink
                v-if="selected.relatedSalesActivityId && salesTitleOf(selected.relatedSalesActivityId)"
                to="/sales-activity"
                class="link inline-flex items-center gap-1"
              >
                {{ salesTitleOf(selected.relatedSalesActivityId) }}
                <ExternalLink class="h-3 w-3" aria-hidden="true" />
              </NuxtLink>
              <span v-else>—</span>
            </dd>
          </div>
        </dl>
      </template>

      <div v-else class="grid gap-3">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="パートナー" required hint="人・会社の名前（自由入力）">
            <input v-model="form.partnerName" type="text" class="input" placeholder="例）川上さん" aria-label="パートナー">
          </UiFormField>
          <UiFormField label="関連企業（任意）">
            <input v-model="form.relatedCompany" type="text" class="input" placeholder="例）フローラ" aria-label="関連企業">
          </UiFormField>
        </div>
        <UiFormField label="テーマ名" required>
          <input v-model="form.theme" type="text" class="input" placeholder="例）フローラ社との協業検討" aria-label="テーマ名">
        </UiFormField>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <UiFormField label="活動区分" required>
            <UiSelect v-model="form.activityType" :options="typeOptions" empty-label="選択してください" aria-label="活動区分" />
          </UiFormField>
          <UiFormField label="ステータス" required>
            <UiSelect v-model="form.status" :options="statusOptions" aria-label="ステータス" />
          </UiFormField>
          <UiFormField label="自社担当者" required hint="既定はログインユーザー">
            <UiSelect v-model="form.staffMemberId" :options="staffOptions" aria-label="自社担当者" />
          </UiFormField>
        </div>
        <UiFormField label="概要（任意）">
          <textarea v-model="form.summary" class="textarea min-h-16" placeholder="活動テーマの概要" aria-label="概要" />
        </UiFormField>
        <UiFormField label="現在状況（任意）">
          <textarea v-model="form.currentState" class="textarea min-h-16" placeholder="例）先方担当者と初回協議済み" aria-label="現在状況" />
        </UiFormField>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="Next Action（任意）">
            <input v-model="form.nextAction" type="text" class="input" placeholder="例）3者MTG" aria-label="Next Action">
          </UiFormField>
          <UiFormField label="Next Action日（任意）">
            <input v-model="form.nextActionDate" type="date" class="input" aria-label="Next Action日">
          </UiFormField>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="関連MTG（任意）">
            <input v-model="form.relatedMeeting" type="text" class="input" placeholder="例）9/7 フローラMTG" aria-label="関連MTG">
          </UiFormField>
          <UiFormField label="関連商談（任意）" hint="案件化したら営業活動へリンク">
            <UiSelect v-model="form.relatedSalesActivityId" :options="salesOptions" empty-label="（未リンク）" aria-label="関連商談" />
          </UiFormField>
        </div>
        <UiFormField label="メモ（任意）">
          <textarea v-model="form.memo" class="textarea min-h-16" placeholder="その他のメモ" aria-label="メモ" />
        </UiFormField>
      </div>

      <template #footer>
        <div v-if="mode === 'view' && selected" class="flex items-center justify-between gap-2">
          <button type="button" class="btn btn-danger btn-sm" @click="onArchive(selected)">取り消す</button>
          <button type="button" class="btn btn-primary" @click="openEdit">編集</button>
        </div>
        <div v-else class="flex items-center justify-end gap-2">
          <button type="button" class="btn" @click="cancelEdit">キャンセル</button>
          <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : mode === 'create' ? '登録' : '更新' }}
          </button>
        </div>
      </template>
    </UiDrawer>
  </div>
</template>
