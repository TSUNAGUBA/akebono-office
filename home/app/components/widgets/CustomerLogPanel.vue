<script setup lang="ts">
/**
 * 顧客活動パネル（旧「顧客ログ」= 改修依頼 2026-08-18 で改称。オペレーター指示 2026-07-30 → 項目拡張 2026-07-31）。
 * 「いつ（開始/終了時刻は任意・15 分単位）・どの顧客（会社/人 = コンボボックス・未登録は新規マスタ登録）と・
 * 誰（自社担当者 = 既定ログインユーザー）が・どんな活動（活動目的 + 活動手段 + 担当者メモ）をしたか」を
 * 記録・一覧・編集・取消/復元する。
 * - 一覧の表示範囲（改修依頼 2026-08-18）: 全メンバーの記録を全員が閲覧できる（旧・許可制の参照権限は撤去）。
 *   編集・取消は従来どおり本人の記録のみ。
 * - 一覧は useListView（1 ページ 20 件・クライアントページング）+ UiPagination（改修依頼 2026-08-18）。
 * - 記録は AI（チャットボット・日報アシスト）の参照対象（本人スコープのまま = 設計判断を維持）。
 * - 操作の取消可能性（原則9.5）: 取消（論理削除）+ 復元 + 本人編集。
 */
import { Pencil, Plus, RefreshCw, RotateCcw, Trash2, User, Users } from 'lucide-vue-next'
import {
  CUSTOMER_LOG_METHOD_PRESETS, CUSTOMER_LOG_TAG_CAP, CUSTOMER_LOG_TAG_PRESETS, CUSTOMER_LOG_TAGS_MAX,
} from '../../../../shared/domain/types'
import type { Company, Contact, CustomerLog, Member } from '~/types/domain'
import { fmtDateLong } from '~/utils/format'

const cl = useCustomerLogs()
const { tbl } = useMockDb()
const { show } = useToast()
const confirm = useConfirm()
const { currentUserId } = useCurrentUser()

const members = tbl('members')
const companies = computed(() => (tbl('companies').value as Company[]).filter(c => c.active && c.kind === 'customer'))
const contacts = computed(() => (tbl('contacts').value as Contact[]).filter(c => c.active))

// 表示時にサーバー分を取り込む（API モード。全メンバーの記録 + 本人の取消済み）
onMounted(() => cl.ensureLoaded())

// ---------- 一覧・フィルタ ----------

const companyFilter = ref('')
const memberFilter = ref('')

function companyName(id: string | null): string {
  return id ? ((tbl('companies').value as Company[]).find(c => c.id === id)?.name ?? id) : ''
}
function contactName(id: string | null): string {
  return id ? ((tbl('contacts').value as Contact[]).find(c => c.id === id)?.name ?? '') : ''
}
function memberName(id: string): string {
  return (members.value as Member[]).find(m => m.id === id)?.name ?? id
}
/** 日時表示（開始/終了は任意。開始〜終了・開始のみ・日付のみの 3 形態）*/
function fmtWhen(l: CustomerLog): string {
  const date = l.logDate.replace(/-/g, '/')
  if (!l.logTime) return date
  return `${date} ${l.logTime}${l.endTime ? `〜${l.endTime}` : ''}`
}
/** 一覧プレビュー（担当者メモ）*/
function previewOf(l: CustomerLog): string {
  return l.body
}
/** 本人の記録か（編集・取消ボタンの表示条件）*/
function isOwn(l: CustomerLog): boolean {
  return l.memberId === currentUserId.value
}

const memberFilterOptions = computed(() =>
  (members.value as Member[]).filter(m => m.active).map(m => ({
    value: m.id,
    label: m.id === currentUserId.value ? `${m.name}（自分）` : m.name,
  })))

const filterPredicate = computed(() => (l: CustomerLog): boolean => {
  if (companyFilter.value && l.companyId !== companyFilter.value) return false
  if (memberFilter.value && l.memberId !== memberFilter.value) return false
  return true
})

// 一覧のページング（1 ページ 20 件 = 改修依頼 2026-08-18。全件ハイドレーションキャッシュへの
// クライアントページング = masters 系と同じ構成）
const lv = useListView<CustomerLog>({
  source: computed(() => cl.allLogs()),
  match: (l, q) => [l.title, l.body, companyName(l.companyId), contactName(l.contactId),
    memberName(l.staffMemberId), memberName(l.memberId), l.method ?? '', ...(l.tags ?? [])]
    .some(v => (v ?? '').toLowerCase().includes(q)),
  filterPredicate,
})
// フィルタ変更・デモユーザー切替で 1 ページ目へ（filterPredicate 単独はリセット対象外のため明示 watch =
// customers.vue と同型。ユーザー切替は NotesPanel と同じ横展開 = R1 レビュー MINOR-3）
watch([companyFilter, memberFilter, currentUserId], () => { lv.page.value = 1 })

const archived = computed(() => cl.archivedOf(currentUserId.value))

// ---------- 登録・編集モーダル ----------

const composeOpen = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const form = ref({
  logDate: '',
  logTime: '',
  endTime: '',
  companyId: '',
  companyText: '',
  contactId: '',
  contactText: '',
  staffMemberId: '',
  tags: [] as string[],
  method: '',
  title: '',
  body: '',
})

/** 時刻の選択肢（15 分単位。オペレーター指示: 分は 15 分単位から選択）*/
const QUARTER_TIMES = Array.from({ length: 24 * 4 }, (_, i) => {
  const h = String(Math.floor(i / 4)).padStart(2, '0')
  const m = String((i % 4) * 15).padStart(2, '0')
  return `${h}:${m}`
})
/** 旧データの 15 分単位外の値（例 11:15 以外の 14:37 等）も編集時に保持できるよう選択肢へ含める（原則7）*/
function timeOptions(current: string): { value: string; label: string }[] {
  const values = current && !QUARTER_TIMES.includes(current)
    ? [...QUARTER_TIMES, current].sort()
    : QUARTER_TIMES
  return values.map(t => ({ value: t, label: t }))
}

/** 自社担当者の選択肢（在籍中の全メンバー。既定 = ログインユーザー）*/
const staffOptions = computed(() =>
  (members.value as Member[]).filter(m => m.active).map(m => ({
    value: m.id,
    label: m.id === currentUserId.value ? `${m.name}（自分）` : m.name,
  })))

/** 活動目的（プリセット + 入力済みの自由項目をトグル可能に表示）*/
const tagOptions = computed(() => {
  const values = [...CUSTOMER_LOG_TAG_PRESETS] as string[]
  for (const t of form.value.tags) if (!values.includes(t)) values.push(t)
  return values.map(t => ({ value: t, label: t }))
})
/** 活動目的変更の共通ガード（プリセットトグル・自由入力とも上限超過は保存前に警告 = 400 まで気付けない事故を防ぐ）*/
function applyTags(next: string[]): void {
  if (next.length > CUSTOMER_LOG_TAGS_MAX) {
    show(`活動目的は ${CUSTOMER_LOG_TAGS_MAX} 件までです`, 'warn')
    return
  }
  form.value.tags = next
}
const newTag = ref('')
function addTag(): void {
  const t = newTag.value.trim()
  if (!t) return
  // 1 件の文字数上限も保存前に警告（保存時の無警告切り詰めを防ぐ = 2 巡目 NIT-5）
  if ([...t].length > CUSTOMER_LOG_TAG_CAP) {
    show(`活動目的は 1 件 ${CUSTOMER_LOG_TAG_CAP} 文字までです`, 'warn')
    return
  }
  if (!form.value.tags.includes(t)) applyTags([...form.value.tags, t])
  if (form.value.tags.includes(t)) newTag.value = ''
}

/** 活動手段の選択肢（単一選択・任意 = 「未設定」を含む。改修依頼 2026-08-18）*/
const methodOptions = [
  { value: '', label: '未設定' },
  ...CUSTOMER_LOG_METHOD_PRESETS.map(m => ({ value: m, label: m })),
]

/** 会社コンボボックスの候補（有効な顧客(会社)）*/
const companyOptions = computed(() => companies.value.map(c => ({ value: c.id, label: c.name })))

/** 選択中の会社に属する担当者のみ（既存会社が未選択 = 新規会社入力中は空 = 担当者も新規登録）*/
const contactOptions = computed(() =>
  form.value.companyId
    ? contacts.value.filter(c => c.companyId === form.value.companyId).map(c => ({ value: c.id, label: c.name }))
    : [])

/** 会社の入力があるか（既存選択 or 新規名の自由入力）。担当者欄の活性条件 */
const hasCompanyInput = computed(() => !!form.value.companyId || !!form.value.companyText.trim())

/**
 * フォーム復元中フラグ（レビュー指摘 m-3）: openCreate/openEdit の一括代入で companyId watch が発火し、
 * 無効化済み担当者・API モードの contacts 未ロード時に既存の担当者リンクを黙って消してしまうため、
 * 「ユーザーが会社を変更したとき」だけクリアが働くよう復元中は抑止する
 */
let restoringForm = false
function fillForm(next: typeof form.value): void {
  restoringForm = true
  form.value = next
  void nextTick(() => { restoringForm = false })
}

// 会社を変えたら、その会社に属さない担当者選択は解除する（不整合の防止）。
// 自由入力（新規会社）へ切り替えた場合も既存担当者は所属し得ないため解除する
watch(() => form.value.companyId, (cid) => {
  if (restoringForm) return
  if (form.value.contactId && !contacts.value.some(c => c.id === form.value.contactId && c.companyId === cid)) {
    form.value.contactId = ''
    form.value.contactText = ''
  }
})

function openCreate(): void {
  editingId.value = null
  fillForm({
    logDate: todayJst(),
    logTime: '',
    endTime: '',
    companyId: '',
    companyText: '',
    contactId: '',
    contactText: '',
    staffMemberId: currentUserId.value, // 既定 = ログインユーザー
    tags: [],
    method: '',
    title: '',
    body: '',
  })
  newTag.value = ''
  composeOpen.value = true
}
function openEdit(l: CustomerLog): void {
  if (!isOwn(l)) return
  editingId.value = l.id
  fillForm({
    logDate: l.logDate,
    logTime: l.logTime ?? '',
    endTime: l.endTime ?? '',
    companyId: l.companyId,
    companyText: companyName(l.companyId),
    contactId: l.contactId ?? '',
    contactText: contactName(l.contactId),
    staffMemberId: l.staffMemberId || currentUserId.value,
    tags: [...(l.tags ?? [])],
    method: l.method ?? '',
    title: l.title,
    body: l.body,
  })
  newTag.value = ''
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
      endTime: form.value.endTime || null,
      companyId: form.value.companyId,
      newCompanyName: form.value.companyId ? '' : form.value.companyText,
      contactId: form.value.contactId || null,
      newContactName: form.value.contactId ? '' : form.value.contactText,
      staffMemberId: form.value.staffMemberId || currentUserId.value,
      tags: form.value.tags,
      method: form.value.method,
      title: form.value.title,
      body: form.value.body,
    }
    const willCreateCompany = !input.companyId && !!input.newCompanyName.trim()
    const willCreateContact = !input.contactId && !!input.newContactName.trim()
    const res = editingId.value ? await cl.update(editingId.value, input) : await cl.add(input)
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    show(editingId.value ? '顧客活動を更新しました' : '顧客活動を登録しました（AI の参照対象になります）')
    if (willCreateCompany || willCreateContact) {
      // 実際に新規登録されたか（既存名への名寄せか）は保存結果で確定するため「未登録なら」の表現にする
      show('未登録の顧客・担当者はマスタへ登録し、記録に反映しました', 'info')
    }
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
    '顧客活動の取消',
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
      :title="`顧客活動一覧（${lv.total.value}件）`"
      description="全メンバーの記録を閲覧できます（編集・取消は自分の記録のみ）。AI の参照対象は自分の記録のみです"
      flush
    >
      <template #actions>
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
            <Plus class="h-3.5 w-3.5" aria-hidden="true" />
            記録する
          </button>
          <button type="button" class="btn btn-ghost btn-sm" aria-label="再読み込み" @click="cl.refresh()">
            <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </template>

      <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <UiSearchInput v-model="lv.query.value" placeholder="会社名・担当者・活動目的・内容で検索" />
        <UiSelect
          v-model="companyFilter"
          :options="companyOptions"
          empty-label="すべての顧客"
          aria-label="顧客で絞り込み"
          class="w-auto"
        />
        <UiSelect
          v-model="memberFilter"
          :options="memberFilterOptions"
          empty-label="すべてのメンバー"
          aria-label="記録者で絞り込み"
          class="w-auto"
        />
      </div>

      <UiEmptyState
        v-if="lv.total.value === 0"
        icon="MessageSquare"
        title="該当する顧客活動がありません"
        hint="「記録する」から顧客とのやり取りを登録できます"
      />
      <template v-else>
        <ul class="divide-y divide-line">
          <li v-for="l in lv.rows.value" :key="l.id" class="flex items-start gap-1 px-4 py-2.5">
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
                <span
                  v-if="l.method"
                  class="rounded-full border border-line-strong bg-surface px-1.5 py-px text-[10px] font-medium text-sub"
                >{{ l.method }}</span>
                <span
                  v-for="t in (l.tags ?? [])"
                  :key="t"
                  class="rounded-full border border-brand bg-brand-soft px-1.5 py-px text-[10px] font-medium text-brand"
                >{{ t }}</span>
                <span class="ml-auto text-[11px] text-muted">記録: {{ memberName(l.memberId) }}</span>
              </span>
              <span v-if="l.title" class="mt-0.5 block text-[12px] font-semibold text-sub">{{ l.title }}</span>
              <span class="mt-0.5 block truncate text-[12px] leading-relaxed text-sub">{{ previewOf(l) }}</span>
            </button>
            <template v-if="isOwn(l)">
              <button type="button" class="btn btn-ghost btn-sm shrink-0" :aria-label="`「${companyName(l.companyId)}」の記録を編集`" @click="openEdit(l)">
                <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button type="button" class="btn btn-ghost btn-sm shrink-0" :aria-label="`「${companyName(l.companyId)}」の記録を取り消す`" @click="onArchive(l)">
                <Trash2 class="h-3.5 w-3.5 text-crit" aria-hidden="true" />
              </button>
            </template>
          </li>
        </ul>
        <div class="px-4 pb-3">
          <UiPagination v-model:page="lv.page.value" v-model:page-size="lv.pageSize.value" :total="lv.total.value" />
        </div>
      </template>

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
      :title="editingId ? '顧客活動を編集' : '顧客活動を記録'"
      width="620px"
      @close="composeOpen = false"
    >
      <div class="grid gap-3">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <UiFormField label="日付" required>
            <input v-model="form.logDate" type="date" class="input" aria-label="日付" required>
          </UiFormField>
          <UiFormField label="開始時間" hint="15 分単位">
            <UiSelect
              v-model="form.logTime"
              :options="timeOptions(form.logTime)"
              empty-label="未設定"
              aria-label="開始時間"
            />
          </UiFormField>
          <UiFormField label="終了時間" hint="開始より後の時刻">
            <UiSelect
              v-model="form.endTime"
              :options="timeOptions(form.endTime)"
              empty-label="未設定"
              aria-label="終了時間"
            />
          </UiFormField>
        </div>
        <UiFormField label="活動目的" hint="商談・取材・イベントなど。自由入力でも追加できます">
          <div class="grid gap-1.5">
            <UiChipSelect :model-value="form.tags" :options="tagOptions" aria-label="活動目的" @update:model-value="applyTags" />
            <div class="flex items-center gap-1.5">
              <input
                v-model="newTag"
                type="text"
                class="input w-40"
                placeholder="活動目的を自由入力"
                aria-label="活動目的を自由入力"
                @keydown.enter.prevent="addTag"
              >
              <button type="button" class="btn btn-sm" :disabled="!newTag.trim()" @click="addTag">
                <Plus class="h-3.5 w-3.5" aria-hidden="true" />
                追加
              </button>
            </div>
          </div>
        </UiFormField>
        <UiFormField label="活動手段" hint="訪問・Web会議・電話など">
          <UiChipTabs v-model="form.method" :options="methodOptions" aria-label="活動手段" />
        </UiFormField>
        <UiFormField label="顧客（会社）" required hint="未登録の会社名を入力すると、保存時にマスタへ新規登録されます">
          <UiCombobox
            v-model="form.companyId"
            v-model:text="form.companyText"
            :options="companyOptions"
            placeholder="会社名で検索・入力"
            aria-label="顧客（会社）"
            create-hint="保存時にマスタへ新規登録されます"
          />
        </UiFormField>
        <UiFormField
          label="担当者（人）"
          :hint="hasCompanyInput
            ? '未登録の担当者名を入力すると、保存時にマスタへ新規登録されます'
            : '先に会社を選択・入力してください'"
        >
          <UiCombobox
            v-model="form.contactId"
            v-model:text="form.contactText"
            :options="contactOptions"
            :disabled="!hasCompanyInput"
            placeholder="担当者名で検索・入力"
            aria-label="担当者（人）"
            create-hint="保存時にマスタへ新規登録されます"
          />
        </UiFormField>
        <UiFormField label="自社の担当者" required hint="既定はログインユーザー">
          <UiSelect
            v-model="form.staffMemberId"
            :options="staffOptions"
            aria-label="自社の担当者"
          />
        </UiFormField>
        <UiFormField label="件名">
          <input v-model="form.title" type="text" class="input" placeholder="例）SCM 追加提案の打診" aria-label="件名">
        </UiFormField>
        <UiFormField label="担当者メモ" required>
          <textarea
            v-model="form.body"
            class="textarea min-h-24"
            placeholder="担当者としての所感・要点・次アクションなど"
            aria-label="担当者メモ"
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
          <span class="flex items-center gap-1">
            <Users class="h-3 w-3" aria-hidden="true" />自社担当: {{ memberName(detailLog.staffMemberId) }}
          </span>
          <span>記録者: {{ memberName(detailLog.memberId) }}</span>
          <span v-if="detailLog.updatedAt && detailLog.updatedAt !== detailLog.createdAt">（{{ fmtDateLong(detailLog.updatedAt) }} 編集）</span>
        </div>
        <div v-if="(detailLog.tags ?? []).length > 0 || detailLog.method" class="flex flex-wrap gap-1">
          <span
            v-for="t in detailLog.tags"
            :key="t"
            class="rounded-full border border-brand bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand"
          >{{ t }}</span>
          <span
            v-if="detailLog.method"
            class="rounded-full border border-line-strong bg-surface px-2 py-0.5 text-[11px] font-medium text-sub"
          >活動手段: {{ detailLog.method }}</span>
        </div>
        <p v-if="detailLog.title" class="text-[14px] font-semibold">{{ detailLog.title }}</p>
        <div v-if="detailLog.body">
          <p class="label">担当者メモ</p>
          <p class="whitespace-pre-wrap text-[13px] leading-relaxed">{{ detailLog.body }}</p>
        </div>
      </div>
      <template v-if="detailLog && isOwn(detailLog)" #footer>
        <div class="flex items-center justify-between gap-2">
          <button type="button" class="btn btn-danger btn-sm" @click="onArchive(detailLog)">取り消す</button>
          <button type="button" class="btn btn-primary" @click="openEdit(detailLog)">編集</button>
        </div>
      </template>
    </UiModal>
  </div>
</template>
