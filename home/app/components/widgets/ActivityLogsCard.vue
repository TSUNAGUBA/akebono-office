<script setup lang="ts">
/**
 * 活動ログカード（案件詳細ページの下段。改修依頼 2026-08-20）。
 * 営業活動（kind='sales'）とビジネスパートナー活動（kind='partner'）で**同一実装**を共有する（原則3）。
 * - 一覧: useListView（1 ページ 20 件・活動日降順 → 登録降順。モック = クライアント / API = サーバーページング）。
 * - 行クリック → ログ詳細ドロワー（view/edit + 取消/復元 = 原則9.5）。「ログを登録」で新規作成ドロワー。
 * - 保存失敗はドロワーフッター直上のインライン領域（role="alert"）に必ず表示（登録バグ根本対応）。
 *   活動種別（既定値なしの必須項目）は未選択時にフィールド単位のインラインエラーも出す。
 */
import { AlertCircle, Plus, RotateCcw } from 'lucide-vue-next'
import { ACTIVITY_LOG_KINDS } from '../../../../shared/domain/types'
import { useActivityLogs } from '~/composables/useActivityLogs'
import type { ActivityLog, Member } from '~/types/domain'
import type { TableColumn } from '~/types/ui'

const props = defineProps<{
  kind: 'sales' | 'partner'
  activityId: string
}>()

const logs = useActivityLogs(props.kind)
const { tbl } = useMockDb()
const { show } = useToast()
const confirm = useConfirm()
const members = tbl('members')

const kindOptions = ACTIVITY_LOG_KINDS.map(v => ({ value: v, label: v }))

function memberName(log: ActivityLog): string {
  return log.memberName || ((members.value as Member[]).find(m => m.id === log.memberId)?.name ?? log.memberId)
}
function fmtDateKey(d: string | null | undefined): string {
  return d ? d.replace(/-/g, '/') : '—'
}

// ---------- 一覧（検索 + 種別フィルタ + 20件/ページ・活動日降順。デュアルモード） ----------

const kindFilter = ref('')
const filterPredicate = computed(() => (r: ActivityLog): boolean =>
  !kindFilter.value || r.kind === kindFilter.value)
const filterParams = computed(() => {
  const p: Record<string, string> = { 'f.active': 'true' }
  if (kindFilter.value) p['f.kind'] = kindFilter.value
  return p
})

const lv = useListView<ActivityLog>({
  source: computed(() => logs.logsOf(props.activityId)),
  // クライアント検索の対象はサーバー searchCols（件名/内容/Next Action）と揃える
  match: (r, q) => [r.title, r.body, r.nextAction].some(v => (v ?? '').toLowerCase().includes(q)),
  fetch: p => logs.pageFetch(props.activityId)(p),
  filterPredicate,
  filterParams,
})

// 別案件へ遷移してコンポーネントが再利用された場合は 1 ページ目へ戻して取り直す
watch(() => props.activityId, () => {
  lv.page.value = 1
  lv.refresh()
  void reloadArchived()
})

const columns: TableColumn[] = [
  { key: 'loggedLabel', label: '活動日', primary: true, width: '100px' },
  { key: 'kind', label: '種別', primary: true, width: '90px' },
  { key: 'title', label: '件名', primary: true },
  { key: 'nextAction', label: 'Next Action' },
  { key: 'memberLabel', label: '記録者', width: '90px' },
]

const tableRows = computed(() =>
  lv.rows.value.map(r => ({
    ...r,
    loggedLabel: fmtDateKey(r.loggedOn),
    memberLabel: memberName(r),
  })) as unknown as Record<string, unknown>[])

function asRow(row: Record<string, unknown>): ActivityLog {
  return row as unknown as ActivityLog
}

// ---------- 詳細・編集・新規（ドロワー） ----------

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selected = ref<ActivityLog | null>(null)
const saving = ref(false)
/** 保存失敗のインライン表示（role="alert"。トースト任せにしない） */
const formError = ref('')
/** 活動種別のフィールド単位エラー（既定値なしの必須項目） */
const kindError = ref('')

const drawerTitle = computed(() =>
  mode.value === 'create' ? '活動ログを登録' : mode.value === 'edit' ? '活動ログを編集' : '活動ログの詳細')

const form = ref({
  loggedOn: '',
  kind: '',
  title: '',
  body: '',
  nextAction: '',
  nextActionDate: '',
  links: [] as string[],
})

watch(() => form.value.kind, (v) => {
  if (v) kindError.value = ''
})

function openDetail(row: Record<string, unknown>): void {
  selected.value = asRow(row)
  mode.value = 'view'
  formError.value = ''
  drawerOpen.value = true
}

function openCreate(): void {
  selected.value = null
  form.value = {
    loggedOn: todayJst(),
    kind: '',
    title: '',
    body: '',
    nextAction: '',
    nextActionDate: '',
    links: [],
  }
  formError.value = ''
  kindError.value = ''
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  const s = selected.value
  if (!s) return
  form.value = {
    loggedOn: s.loggedOn,
    kind: s.kind,
    title: s.title,
    body: s.body,
    nextAction: s.nextAction ?? '',
    nextActionDate: s.nextActionDate ?? '',
    links: [...(s.links ?? [])],
  }
  formError.value = ''
  kindError.value = ''
  mode.value = 'edit'
}

function cancelEdit(): void {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  formError.value = ''
  try {
    const res = await logs.save(props.activityId, mode.value === 'edit' ? (selected.value?.id ?? null) : null, {
      loggedOn: form.value.loggedOn,
      kind: form.value.kind,
      title: form.value.title,
      body: form.value.body,
      nextAction: form.value.nextAction,
      nextActionDate: form.value.nextActionDate || null,
      links: form.value.links,
    })
    if (!res.ok) {
      formError.value = `${res.error.code}: ${res.error.message}`
      if (res.error.message.startsWith('活動種別')) kindError.value = res.error.message
      return
    }
    show(mode.value === 'create' ? '活動ログを登録しました' : '活動ログを更新しました')
    drawerOpen.value = false
    lv.refresh()
    await reloadArchived()
  } finally {
    saving.value = false
  }
}

// ---------- 取消/復元（原則9.5） ----------

const restoring = ref(false)
const showArchived = ref(false)
const archivedLogs = ref<ActivityLog[]>([])

/** 取消済みログの取得（モック = コレクション / API = f.active=false の一覧 GET） */
async function reloadArchived(): Promise<void> {
  archivedLogs.value = await logs.loadArchived(props.activityId)
}
onMounted(() => { void reloadArchived() })

async function onArchive(r: ActivityLog): Promise<void> {
  const ok = await confirm.ask(
    '活動ログの取消',
    `「${r.title}」を取り消しますか？（一覧から外れます。あとから復元できます）`,
    { danger: true, confirmLabel: '取り消す' },
  )
  if (!ok) return
  const res = await logs.archive(props.activityId, r.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  drawerOpen.value = false
  show('取り消しました', 'warn')
  lv.refresh()
  await reloadArchived()
}

async function onRestore(r: ActivityLog): Promise<void> {
  if (restoring.value) return
  restoring.value = true
  try {
    const res = await logs.restore(props.activityId, r.id)
    if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
    show('復元しました')
    lv.refresh()
    await reloadArchived()
  } finally {
    restoring.value = false
  }
}

const detailRows = computed(() => {
  const s = selected.value
  if (!s) return []
  return [
    { label: '活動日', value: fmtDateKey(s.loggedOn) },
    { label: '活動種別', value: s.kind },
    { label: '件名', value: s.title },
    { label: '内容', value: s.body || '—' },
    { label: 'Next Action', value: s.nextAction || '—' },
    { label: 'Next Action日', value: fmtDateKey(s.nextActionDate) },
    { label: '参考リンク', value: (s.links ?? []).join('\n') || '—' },
    { label: '記録者', value: memberName(s) },
  ]
})
</script>

<template>
  <UiSectionCard :title="`活動ログ（${lv.total.value}件）`" description="活動日の降順・20件/ページ" flush>
    <template #actions>
      <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
        <Plus class="h-3.5 w-3.5" aria-hidden="true" />
        ログを登録
      </button>
    </template>

    <div class="flex flex-wrap items-center gap-2 px-4 pt-3">
      <UiSearchInput v-model="lv.query.value" placeholder="件名・内容で検索" />
      <UiSelect v-model="kindFilter" :options="kindOptions" empty-label="すべての種別" aria-label="活動種別で絞り込み" class="w-auto" />
    </div>

    <UiDataTable
      :columns="columns"
      :rows="tableRows"
      clickable
      empty-title="活動ログがありません"
      empty-hint="「ログを登録」からこの案件の活動を記録できます"
      @row-click="openDetail"
    >
      <template #cell-kind="{ row }">
        <UiStatusBadge :label="asRow(row).kind" tone="info" />
      </template>
    </UiDataTable>
    <div class="px-4 pb-3">
      <UiPagination v-model:page="lv.page.value" v-model:page-size="lv.pageSize.value" :total="lv.total.value" />
    </div>

    <!-- 取消済み（復元 = 原則9.5） -->
    <div v-if="archivedLogs.length > 0" class="border-t border-line px-4 py-2">
      <button type="button" class="btn btn-ghost btn-sm" @click="showArchived = !showArchived">
        {{ showArchived ? '取消済みを隠す' : `取消済みを表示（${archivedLogs.length}件）` }}
      </button>
      <ul v-if="showArchived" class="mt-1 divide-y divide-line">
        <li v-for="r in archivedLogs" :key="r.id" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
          <span class="text-[13px] text-muted line-through">{{ fmtDateKey(r.loggedOn) }} / {{ r.title }}</span>
          <button type="button" class="btn btn-ghost btn-sm ml-auto" :disabled="restoring" :aria-label="`「${r.title}」を復元する`" @click="onRestore(r)">
            <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
            元に戻す
          </button>
        </li>
      </ul>
    </div>

    <UiDrawer :open="drawerOpen" :title="drawerTitle" width="520px" @close="drawerOpen = false">
      <dl v-if="mode === 'view' && selected" class="grid gap-2 text-[13px]">
        <div
          v-for="r in detailRows"
          :key="r.label"
          class="grid grid-cols-[110px_1fr] gap-2 border-b border-line pb-2 last:border-0"
        >
          <dt class="pt-0.5 text-[11px] font-semibold text-muted">{{ r.label }}</dt>
          <dd class="whitespace-pre-wrap">{{ r.value }}</dd>
        </div>
      </dl>

      <div v-else class="grid gap-3">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="活動日" required>
            <input v-model="form.loggedOn" type="date" class="input" aria-label="活動日">
          </UiFormField>
          <UiFormField label="活動種別" required :error="kindError">
            <UiSelect v-model="form.kind" :options="kindOptions" empty-label="選択してください" aria-label="活動種別" />
          </UiFormField>
        </div>
        <UiFormField label="件名" required>
          <input v-model="form.title" type="text" class="input" placeholder="例）初回訪問・要件ヒアリング" aria-label="件名">
        </UiFormField>
        <UiFormField label="内容">
          <textarea v-model="form.body" class="textarea min-h-24" placeholder="活動の内容・先方の反応・決まったことなど" aria-label="内容" />
        </UiFormField>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="Next Action">
            <input v-model="form.nextAction" type="text" class="input" placeholder="例）見積書の提出" aria-label="Next Action">
          </UiFormField>
          <UiFormField label="Next Action日">
            <input v-model="form.nextActionDate" type="date" class="input" aria-label="Next Action日">
          </UiFormField>
        </div>
        <!-- 参考リンク（改善要望と同じ部品を再利用 = 原則3） -->
        <ImprovementsLinkEditor v-model:links="form.links" />

        <!-- 保存失敗のインライン表示（フッター直上・必ず表示 = トースト任せにしない） -->
        <p v-if="formError" role="alert" class="flex items-start gap-1.5 rounded-lg border border-crit bg-crit-soft px-3 py-2 text-[13px] font-medium text-crit">
          <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {{ formError }}
        </p>
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
  </UiSectionCard>
</template>
