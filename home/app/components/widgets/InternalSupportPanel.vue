<script setup lang="ts">
/**
 * 社内サポート活動（/internal-support。改善要望 2026-08-22・F-57）。
 * 社内メンバーどうしのフォローアップ（業務支援・技術支援・教育等）を時系列で記録する。
 * - 一覧（20 件ページング = X-7）+ 検索 / 方法チップ / 実施者・対象者フィルタ
 * - 行押下で詳細ドロワー（記録全文 + 編集・取消導線）
 * - 登録 / 編集モーダル（実施者の既定 = ログインユーザー）・取消 / 復元（原則9.5）
 * - 記録は AKEBONO Intelligence の AI 分析（ナレッジカテゴリ「社内サポート」）の材料になる
 */
import { Pencil, Plus, RotateCcw, Trash2 } from 'lucide-vue-next'
import { INTERNAL_SUPPORT_METHODS } from '~/types/domain'
import type { InternalSupport, Member } from '~/types/domain'
import { fmtDate, fmtDateLong } from '~/utils/format'
import type { TableColumn } from '~/types/ui'
import type { InternalSupportInput } from '~/composables/useInternalSupports'

const supports = useInternalSupports()
const { tbl } = useMockDb()
const { currentUser } = useCurrentUser()
const { show } = useToast()
const confirm = useConfirm()

const members = computed(() => (tbl('members').value as Member[]).filter(m => m.active !== false))

function memberName(id: string): string {
  return (tbl('members').value as Member[]).find(m => m.id === id)?.name ?? id
}

// ---------- フィルタ ----------
const search = ref('')
const methodFilter = ref('')
const performerFilter = ref('')
const targetFilter = ref('')

const methodOptions = [{ value: '', label: 'すべて' }, ...INTERNAL_SUPPORT_METHODS.map(m => ({ value: m, label: m }))]
const performerOptions = computed(() => [
  { value: '', label: '実施者' }, ...members.value.map(m => ({ value: m.id, label: m.name })),
])
const targetOptions = computed(() => [
  { value: '', label: '対象者' }, ...members.value.map(m => ({ value: m.id, label: m.name })),
])

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return supports.list().filter((r) => {
    if (methodFilter.value && r.method !== methodFilter.value) return false
    if (performerFilter.value && r.performerMemberId !== performerFilter.value) return false
    if (targetFilter.value && r.targetMemberId !== targetFilter.value) return false
    if (!q) return true
    return [memberName(r.performerMemberId), memberName(r.targetMemberId), r.taskDescription, r.feedback]
      .some(s => s.toLowerCase().includes(q))
  })
})

const { page, pageSize, rows: paged, total } = useListView<InternalSupport>({ source: filtered })
watch([search, methodFilter, performerFilter, targetFilter], () => { page.value = 1 })

const columns: TableColumn[] = [
  { key: 'date', label: '活動日時', primary: true },
  { key: 'performer', label: '実施者' },
  { key: 'target', label: '対象者', primary: true },
  { key: 'task', label: '対象業務内容' },
  { key: 'method', label: '方法' },
  { key: 'feedback', label: 'フィードバック' },
]

/** 一覧セルの抜粋（1 行表示用） */
function excerpt(s: string, max = 40): string {
  const chars = [...s.replace(/\s+/g, ' ').trim()]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('')
}

const tableRows = computed(() => paged.value.map(r => ({
  id: r.id,
  date: r.activityTime ? `${fmtDate(r.activityDate)} ${r.activityTime}` : fmtDate(r.activityDate),
  performer: memberName(r.performerMemberId),
  target: memberName(r.targetMemberId),
  task: excerpt(r.taskDescription),
  method: r.method,
  hasFeedback: !!r.feedback.trim(),
})))

// ---------- 詳細ドロワー ----------
const detailId = ref<string | null>(null)
const detail = computed(() => supports.list().find(r => r.id === detailId.value)
  ?? supports.archivedList().find(r => r.id === detailId.value) ?? null)

function openDetail(rowId: unknown): void {
  detailId.value = String(rowId)
}

// ---------- 登録・編集 ----------
const composeOpen = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const form = ref<InternalSupportInput>(emptyForm())

function emptyForm(): InternalSupportInput {
  return {
    activityDate: todayJst(),
    activityTime: null,
    performerMemberId: currentUser.value.id,
    targetMemberId: '',
    taskDescription: '',
    method: '対面',
    feedback: '',
  }
}

/** 実施者の選択肢（自分を明示 = SupportActivityPanel の担当者選択と同じイディオム） */
const performerFormOptions = computed(() => members.value.map(m => ({
  value: m.id, label: m.id === currentUser.value.id ? `${m.name}（自分）` : m.name,
})))
/** 対象者の選択肢（未選択プレースホルダ付き。実施者と同一メンバーは保存時に検証で弾く） */
const targetFormOptions = computed(() => [
  { value: '', label: '選択してください' },
  ...members.value.map(m => ({ value: m.id, label: m.name })),
])

function openCreate(): void {
  editingId.value = null
  form.value = emptyForm()
  composeOpen.value = true
}

function openEdit(r: InternalSupport): void {
  editingId.value = r.id
  form.value = {
    activityDate: r.activityDate,
    activityTime: r.activityTime,
    performerMemberId: r.performerMemberId,
    targetMemberId: r.targetMemberId,
    taskDescription: r.taskDescription,
    method: r.method,
    feedback: r.feedback,
  }
  composeOpen.value = true
}

async function submit(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const res = await supports.save(editingId.value, form.value)
    if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
    show(editingId.value ? '社内サポート活動を更新しました' : '社内サポート活動を記録しました')
    composeOpen.value = false
  } finally { saving.value = false }
}

// ---------- 取消 / 復元（原則9.5） ----------
const showArchived = ref(false)
const restoring = ref(false)

async function onArchive(r: InternalSupport): Promise<void> {
  const label = `${fmtDate(r.activityDate)} ${memberName(r.targetMemberId)}さんへのフォローアップ`
  const ok = await confirm.ask('記録の取消', `「${label}」を取り消しますか？（復元できます）`,
    { danger: true, confirmLabel: '取り消す' })
  if (!ok) return
  const res = await supports.archive(r.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  detailId.value = null
  show('取り消しました', 'warn')
}

async function onRestore(r: InternalSupport): Promise<void> {
  if (restoring.value) return
  restoring.value = true
  try {
    const res = await supports.restore(r.id)
    if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
    show('復元しました')
  } finally { restoring.value = false }
}
</script>

<template>
  <div class="grid gap-3">
    <UiFilterBar>
      <UiSearchInput v-model="search" placeholder="実施者・対象者・業務内容・フィードバックで検索" aria-label="社内サポート活動の検索" />
      <UiChipTabs v-model="methodFilter" :options="methodOptions" aria-label="フォローアップ方法で絞り込み" />
      <template #trailing>
        <UiSelect v-model="performerFilter" :options="performerOptions" aria-label="実施者で絞り込み" class="w-auto" />
        <UiSelect v-model="targetFilter" :options="targetOptions" aria-label="対象者で絞り込み" class="w-auto" />
      </template>
    </UiFilterBar>

    <UiSectionCard
      :title="`フォローアップ記録（${filtered.length}件）`"
      description="誰が・誰に・どの業務で・どんなフォローアップをしたかを記録します。行を押すと詳細を表示します"
      flush
    >
      <template #actions>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          活動を記録
        </button>
      </template>

      <UiEmptyState
        v-if="filtered.length === 0"
        icon="HeartHandshake"
        title="社内サポート活動はまだ記録されていません"
        hint="「活動を記録」から、メンバーへのフォローアップ（業務支援・技術支援・教育など）を記録します"
      />
      <template v-else>
        <UiDataTable :columns="columns" :rows="tableRows" row-key="id" clickable @row-click="row => openDetail(row.id)">
          <template #cell-method="{ value }">
            <UiStatusBadge :label="String(value)" tone="info" />
          </template>
          <template #cell-feedback="{ row }">
            <UiStatusBadge v-if="row.hasFeedback" label="記録あり" tone="ok" />
            <span v-else class="text-[11px] text-muted">未記録</span>
          </template>
        </UiDataTable>
        <div class="px-4 pb-3">
          <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />
        </div>
      </template>

      <!-- 取消済み（復元導線 = 原則9.5） -->
      <div v-if="supports.archivedList().length > 0" class="border-t border-line px-4 py-2">
        <button type="button" class="btn btn-ghost btn-sm" @click="showArchived = !showArchived">
          {{ showArchived ? '取消済みを隠す' : `取消済みを表示（${supports.archivedList().length}件）` }}
        </button>
        <ul v-if="showArchived" class="mt-1 divide-y divide-line">
          <li v-for="r in supports.archivedList()" :key="r.id" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
            <span class="text-[13px] text-muted line-through">
              {{ fmtDate(r.activityDate) }} {{ memberName(r.targetMemberId) }}さんへのフォローアップ
            </span>
            <span class="num ml-auto text-[11px] text-muted">{{ fmtDateLong(r.createdAt) }}</span>
            <button
              type="button" class="btn btn-ghost btn-sm" :disabled="restoring"
              :aria-label="`「${fmtDate(r.activityDate)} ${memberName(r.targetMemberId)}さんへのフォローアップ」を復元する`"
              @click="onRestore(r)"
            >
              <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
              元に戻す
            </button>
          </li>
        </ul>
      </div>
    </UiSectionCard>

    <!-- 詳細ドロワー -->
    <UiDrawer
      :open="!!detail"
      :title="detail ? `${memberName(detail.targetMemberId)}さんへのフォローアップ` : ''"
      width="560px"
      @close="detailId = null"
    >
      <div v-if="detail" class="grid gap-4">
        <div class="flex flex-wrap items-center gap-2">
          <UiStatusBadge :label="detail.method" tone="info" />
          <UiStatusBadge v-if="detail.active === false" label="取消済み" tone="crit" />
          <span class="ml-auto flex items-center gap-1">
            <button v-if="detail.active !== false" type="button" class="btn btn-ghost btn-sm" @click="openEdit(detail)">
              <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
              編集
            </button>
            <button
              v-if="detail.active !== false" type="button" class="btn btn-ghost btn-sm"
              :aria-label="`「${memberName(detail.targetMemberId)}さんへのフォローアップ」を取り消す`" @click="onArchive(detail)"
            >
              <Trash2 class="h-3.5 w-3.5 text-crit" aria-hidden="true" />
            </button>
            <button v-else type="button" class="btn btn-ghost btn-sm" :disabled="restoring" @click="onRestore(detail)">
              <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
              元に戻す
            </button>
          </span>
        </div>

        <div class="grid gap-1 rounded-lg border border-line p-3">
          <p class="label">活動情報</p>
          <p class="text-[12px]">
            <span class="text-muted">活動日時:</span>
            <span class="num"> {{ fmtDate(detail.activityDate) }}{{ detail.activityTime ? ` ${detail.activityTime}` : '' }}</span>
          </p>
          <p class="text-[12px]"><span class="text-muted">フォローアップ実施者:</span> {{ memberName(detail.performerMemberId) }}</p>
          <p class="text-[12px]"><span class="text-muted">フォローアップ対象者:</span> {{ memberName(detail.targetMemberId) }}</p>
          <p class="text-[12px]"><span class="text-muted">方法:</span> {{ detail.method }}</p>
        </div>

        <div class="grid gap-1 rounded-lg border border-line p-3">
          <p class="label">対象業務内容</p>
          <p class="whitespace-pre-wrap text-[12px]">{{ detail.taskDescription }}</p>
        </div>

        <div class="grid gap-1 rounded-lg border border-line p-3">
          <p class="label">活動結果・効果のフィードバック</p>
          <p v-if="detail.feedback" class="whitespace-pre-wrap text-[12px]">{{ detail.feedback }}</p>
          <p v-else class="text-[12px] text-muted">未記録です（編集からフォローアップの結果・効果を追記できます）</p>
        </div>

        <p class="text-[11px] text-muted">
          登録: {{ memberName(detail.memberId) }} ・ {{ fmtDateLong(detail.createdAt) }}。
          この記録は AKEBONO Intelligence の AI 分析（社内サポート）の材料になります
        </p>
      </div>
    </UiDrawer>

    <!-- 登録・編集モーダル -->
    <UiModal
      :open="composeOpen"
      :title="editingId ? '社内サポート活動を編集' : '社内サポート活動を記録'"
      width="560px"
      @close="composeOpen = false"
    >
      <div class="grid gap-3">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="活動日" required>
            <input v-model="form.activityDate" type="date" class="input" aria-label="活動日">
          </UiFormField>
          <UiFormField label="活動時刻">
            <input
              :value="form.activityTime ?? ''"
              type="time"
              class="input"
              aria-label="活動時刻"
              @input="form.activityTime = ($event.target as HTMLInputElement).value || null"
            >
          </UiFormField>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="フォローアップ実施者" required hint="既定はログインユーザー">
            <UiSelect v-model="form.performerMemberId" :options="performerFormOptions" aria-label="フォローアップ実施者" />
          </UiFormField>
          <UiFormField label="フォローアップ対象者" required>
            <UiSelect v-model="form.targetMemberId" :options="targetFormOptions" aria-label="フォローアップ対象者" />
          </UiFormField>
        </div>
        <UiFormField label="フォローアップ方法" required>
          <UiSelect v-model="form.method" :options="INTERNAL_SUPPORT_METHODS.map(m => ({ value: m, label: m }))" aria-label="フォローアップ方法" />
        </UiFormField>
        <UiFormField label="対象業務内容" required>
          <textarea v-model="form.taskDescription" class="textarea min-h-20" placeholder="例）月次請求処理の締め作業。仕訳の確認手順に不安があったため同席してフォロー" aria-label="対象業務内容" />
        </UiFormField>
        <UiFormField label="活動結果・効果のフィードバック" hint="後から編集で追記できます">
          <textarea v-model="form.feedback" class="textarea min-h-20" placeholder="例）確認手順をチェックリスト化。翌月からは一人で完了できる見込み" aria-label="活動結果・効果のフィードバック" />
        </UiFormField>
      </div>
      <template #footer>
        <div class="flex items-center justify-end gap-2">
          <button type="button" class="btn" @click="composeOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" :disabled="saving" @click="submit">
            {{ saving ? '保存中…' : editingId ? '更新' : '記録する' }}
          </button>
        </div>
      </template>
    </UiModal>
  </div>
</template>
