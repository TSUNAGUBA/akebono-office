<script setup lang="ts">
/**
 * 顧客ログパネル（オペレーター指示 2026-07-30）。
 * 「いつ・どの顧客（会社/人）と・どんな会話をしたか」を記録・一覧・編集・取消/復元する。
 * - 本人の記録は常に表示。権限（canViewMemberCustomerLog）で許可された他メンバーの記録は readonly 参照。
 * - 記録は AI（チャットボット・日報アシスト）の参照対象（本人スコープ）。
 * - 操作の取消可能性（原則9.5）: 取消（論理削除）+ 復元 + 本人編集。
 */
import { Pencil, Plus, RefreshCw, RotateCcw, Trash2, User } from 'lucide-vue-next'
import type { Company, Contact, CustomerLog, Member } from '~/types/domain'
import { fmtDateLong } from '~/utils/format'

const cl = useCustomerLogs()
const { tbl } = useMockDb()
const { show } = useToast()
const confirm = useConfirm()
const { currentUser, currentUserId } = useCurrentUser()
const { canViewMemberCustomerLog } = usePermissions()

const members = tbl('members')
const companies = computed(() => (tbl('companies').value as Company[]).filter(c => c.active && c.kind === 'customer'))
const contacts = computed(() => (tbl('contacts').value as Contact[]).filter(c => c.active))

// ---------- 対象メンバー（本人 = 常に可 / 他メンバー = 権限で許可された対象者のみ readonly） ----------

const viewMemberId = ref(currentUserId.value)
const targetId = computed(() => {
  const id = viewMemberId.value
  if (id && id !== currentUserId.value && canViewMemberCustomerLog(id)) return id
  return currentUserId.value
})
const isReadonly = computed(() => targetId.value !== currentUserId.value)
const viewableMembers = computed(() =>
  (members.value as Member[]).filter(m => m.active && canViewMemberCustomerLog(m.id)))
const canViewOthers = computed(() => viewableMembers.value.some(m => m.id !== currentUserId.value))
const memberSelectOptions = computed(() =>
  viewableMembers.value.map(m => ({
    value: m.id,
    label: m.id === currentUserId.value ? `${m.name}（自分）` : m.name,
  })))

// 表示時・対象切替時にサーバー分を取り込む（API モード）
onMounted(() => cl.ensureLoaded(targetId.value))
watch(targetId, id => cl.ensureLoaded(id))

// ---------- 一覧・フィルタ ----------

const search = ref('')
const companyFilter = ref('')

function companyName(id: string | null): string {
  return id ? (companies.value.find(c => c.id === id)?.name ?? (tbl('companies').value as Company[]).find(c => c.id === id)?.name ?? id) : ''
}
function contactName(id: string | null): string {
  return id ? (contacts.value.find(c => c.id === id)?.name ?? (tbl('contacts').value as Contact[]).find(c => c.id === id)?.name ?? '') : ''
}
function memberName(id: string): string {
  return (members.value as Member[]).find(m => m.id === id)?.name ?? id
}
/** 日時表示（時刻は任意）*/
function fmtWhen(l: CustomerLog): string {
  return `${l.logDate.replace(/-/g, '/')}${l.logTime ? ` ${l.logTime}` : ''}`
}

const logs = computed(() => {
  const rows = cl.logsOf(targetId.value)
  const q = search.value.trim().toLowerCase()
  return rows.filter((l) => {
    if (companyFilter.value && l.companyId !== companyFilter.value) return false
    if (!q) return true
    return [l.title, l.body, companyName(l.companyId), contactName(l.contactId)]
      .some(v => v.toLowerCase().includes(q))
  })
})
const archived = computed(() => (isReadonly.value ? [] : cl.archivedOf(currentUserId.value)))

// ---------- 登録・編集モーダル ----------

const composeOpen = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const form = ref({ logDate: '', logTime: '', companyId: '', contactId: '', title: '', body: '' })

/** 選択中の会社に属する担当者のみ（会社未選択なら空）*/
const contactOptions = computed(() =>
  form.value.companyId
    ? contacts.value.filter(c => c.companyId === form.value.companyId).map(c => ({ value: c.id, label: c.name }))
    : [])
// 会社を変えたら、その会社に属さない担当者選択は解除する（不整合の防止）
watch(() => form.value.companyId, (cid) => {
  if (form.value.contactId && !contacts.value.some(c => c.id === form.value.contactId && c.companyId === cid)) {
    form.value.contactId = ''
  }
})

function openCreate(): void {
  editingId.value = null
  form.value = { logDate: todayJst(), logTime: '', companyId: '', contactId: '', title: '', body: '' }
  composeOpen.value = true
}
function openEdit(l: CustomerLog): void {
  editingId.value = l.id
  form.value = {
    logDate: l.logDate,
    logTime: l.logTime ?? '',
    companyId: l.companyId,
    contactId: l.contactId ?? '',
    title: l.title,
    body: l.body,
  }
  detailLog.value = null
  composeOpen.value = true
}

async function submit(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const input = {
      logDate: form.value.logDate,
      logTime: form.value.logTime || null,
      companyId: form.value.companyId,
      contactId: form.value.contactId || null,
      title: form.value.title,
      body: form.value.body,
    }
    const res = editingId.value ? await cl.update(editingId.value, input) : await cl.add(input)
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    show(editingId.value ? '顧客ログを更新しました' : '顧客ログを登録しました（AI の参照対象になります）')
    composeOpen.value = false
  } finally {
    saving.value = false
  }
}

// ---------- 詳細・取消/復元 ----------

const detailLog = ref<CustomerLog | null>(null)
const restoring = ref(false)

async function onArchive(l: CustomerLog): Promise<void> {
  const ok = await confirm.ask(
    '顧客ログの取消',
    `${fmtWhen(l)}「${companyName(l.companyId)}」の記録を取り消しますか？（一覧と AI の参照対象から外れます。あとから復元できます）`,
    { danger: true, confirmLabel: '取り消す' },
  )
  if (!ok) return
  const res = await cl.archive(l.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  detailLog.value = null
  show('取り消しました', 'warn')
}

async function onRestore(l: CustomerLog): Promise<void> {
  if (restoring.value) return
  restoring.value = true
  try {
    const res = await cl.restore(l.id)
    if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
    show('復元しました（一覧と AI の参照対象に戻ります）')
  } finally {
    restoring.value = false
  }
}

const showArchived = ref(false)
</script>

<template>
  <div class="grid gap-3">
    <UiSectionCard
      :title="`顧客ログ一覧（${logs.length}件）`"
      :description="isReadonly
        ? `${memberName(targetId)} さんの記録を参照しています（閲覧のみ）`
        : 'いつ・どの顧客と・どんな会話をしたかの記録。AI の参照対象（自分の記録のみ）になります'"
      flush
    >
      <template #actions>
        <div class="flex flex-wrap items-center gap-2">
          <UiSelect
            v-if="canViewOthers"
            v-model="viewMemberId"
            :options="memberSelectOptions"
            aria-label="参照するメンバー"
            class="w-auto"
          />
          <button v-if="!isReadonly" type="button" class="btn btn-primary btn-sm" @click="openCreate">
            <Plus class="h-3.5 w-3.5" aria-hidden="true" />
            記録する
          </button>
          <button type="button" class="btn btn-ghost btn-sm" aria-label="再読み込み" @click="cl.refresh(targetId)">
            <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </template>

      <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <UiSearchInput v-model="search" placeholder="会社名・担当者・内容で検索" />
        <UiSelect
          v-model="companyFilter"
          :options="companies.map(c => ({ value: c.id, label: c.name }))"
          empty-label="すべての顧客"
          aria-label="顧客で絞り込み"
          class="w-auto"
        />
      </div>

      <UiEmptyState
        v-if="logs.length === 0"
        icon="MessageSquare"
        title="該当する顧客ログがありません"
        :hint="isReadonly ? '検索条件を見直してください' : '「記録する」から顧客とのやり取りを登録できます'"
      />
      <ul v-else class="divide-y divide-line">
        <li v-for="l in logs" :key="l.id" class="flex items-start gap-1 px-4 py-2.5">
          <button
            type="button"
            class="min-w-0 flex-1 rounded-md text-left transition-colors hover:bg-brand-soft"
            :aria-label="`${companyName(l.companyId)} の記録の詳細を表示`"
            @click="detailLog = l"
          >
            <span class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span class="num text-[11px] text-muted">{{ fmtWhen(l) }}</span>
              <span class="text-[13px] font-bold">{{ companyName(l.companyId) }}</span>
              <span v-if="contactName(l.contactId)" class="text-[12px] text-sub">{{ contactName(l.contactId) }}</span>
            </span>
            <span v-if="l.title" class="mt-0.5 block text-[12px] font-semibold text-sub">{{ l.title }}</span>
            <span class="mt-0.5 block truncate text-[12px] leading-relaxed text-sub">{{ l.body }}</span>
          </button>
          <template v-if="!isReadonly">
            <button type="button" class="btn btn-ghost btn-sm shrink-0" :aria-label="`「${companyName(l.companyId)}」の記録を編集`" @click="openEdit(l)">
              <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button type="button" class="btn btn-ghost btn-sm shrink-0" :aria-label="`「${companyName(l.companyId)}」の記録を取り消す`" @click="onArchive(l)">
              <Trash2 class="h-3.5 w-3.5 text-crit" aria-hidden="true" />
            </button>
          </template>
        </li>
      </ul>

      <!-- 取消済み（本人のみ）。誤って取り消した場合の立ち戻り導線（原則9.5） -->
      <div v-if="archived.length > 0" class="border-t border-line px-4 py-2">
        <button type="button" class="btn btn-ghost btn-sm" @click="showArchived = !showArchived">
          {{ showArchived ? '取消済みを隠す' : `取消済みを表示（${archived.length}件）` }}
        </button>
        <ul v-if="showArchived" class="mt-1 divide-y divide-line">
          <li v-for="l in archived" :key="l.id" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
            <span class="num text-[11px] text-muted">{{ fmtWhen(l) }}</span>
            <span class="text-[13px] text-muted line-through">{{ companyName(l.companyId) }}</span>
            <button type="button" class="btn btn-ghost btn-sm ml-auto" :disabled="restoring" :aria-label="`「${companyName(l.companyId)}」の記録を復元する`" @click="onRestore(l)">
              <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
              元に戻す
            </button>
          </li>
        </ul>
      </div>
    </UiSectionCard>

    <!-- 登録・編集モーダル -->
    <UiModal
      :open="composeOpen"
      :title="editingId ? '顧客ログを編集' : '顧客ログを記録'"
      width="620px"
      @close="composeOpen = false"
    >
      <div class="grid gap-3">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="日付" required>
            <input v-model="form.logDate" type="date" class="input" aria-label="日付" required>
          </UiFormField>
          <UiFormField label="時刻（任意）" hint="空欄可">
            <input v-model="form.logTime" type="time" class="input" aria-label="時刻">
          </UiFormField>
        </div>
        <UiFormField label="顧客（会社）" required>
          <UiSelect
            v-model="form.companyId"
            :options="companies.map(c => ({ value: c.id, label: c.name }))"
            empty-label="会社を選択"
            aria-label="顧客（会社）"
          />
        </UiFormField>
        <UiFormField label="担当者（人・任意）" :hint="form.companyId ? '会社に登録された担当者から選べます' : '先に会社を選択してください'">
          <UiSelect
            v-model="form.contactId"
            :options="contactOptions"
            :empty-label="form.companyId ? '担当者を選択（任意）' : '（会社未選択）'"
            aria-label="担当者（人）"
          />
        </UiFormField>
        <UiFormField label="件名（任意）">
          <input v-model="form.title" type="text" class="input" placeholder="例）SCM 追加提案の打診" aria-label="件名">
        </UiFormField>
        <UiFormField label="会話内容" required>
          <textarea
            v-model="form.body"
            class="textarea min-h-32"
            placeholder="どんな会話をしたか（要点・決定事項・次アクションなど）"
            aria-label="会話内容"
          />
        </UiFormField>
      </div>
      <template #footer>
        <div class="flex items-center justify-end gap-2">
          <button type="button" class="btn" @click="composeOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" :disabled="saving" @click="submit">
            {{ saving ? '保存中…' : editingId ? '更新' : '記録' }}
          </button>
        </div>
      </template>
    </UiModal>

    <!-- 詳細モーダル -->
    <UiModal :open="!!detailLog" :title="detailLog ? companyName(detailLog.companyId) : ''" @close="detailLog = null">
      <div v-if="detailLog" class="grid gap-3">
        <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span class="num">{{ fmtWhen(detailLog) }}</span>
          <span v-if="contactName(detailLog.contactId)" class="flex items-center gap-1">
            <User class="h-3 w-3" aria-hidden="true" />{{ contactName(detailLog.contactId) }}
          </span>
          <span>記録者: {{ memberName(detailLog.memberId) }}</span>
          <span v-if="detailLog.updatedAt && detailLog.updatedAt !== detailLog.createdAt">（{{ fmtDateLong(detailLog.updatedAt) }} 編集）</span>
        </div>
        <p v-if="detailLog.title" class="text-[14px] font-semibold">{{ detailLog.title }}</p>
        <p class="whitespace-pre-wrap text-[13px] leading-relaxed">{{ detailLog.body }}</p>
      </div>
      <template v-if="detailLog && !isReadonly" #footer>
        <div class="flex items-center justify-between gap-2">
          <button type="button" class="btn btn-danger btn-sm" @click="onArchive(detailLog)">取り消す</button>
          <button type="button" class="btn btn-primary" @click="openEdit(detailLog)">編集</button>
        </div>
      </template>
    </UiModal>
  </div>
</template>
