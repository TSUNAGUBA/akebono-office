<script setup lang="ts">
/**
 * ノート共通パネル（ぽいぽいメモ / 議事録。バッチ7c）。
 * テキスト登録 + ドキュメント取込（.md/.txt/.pdf/.docx）+ 一覧。
 * プロジェクト・顧客・業務種別は任意の紐付け（未選択のまま登録可）
 */
import { FileUp, Send, Trash2, X } from 'lucide-vue-next'
import type { Company, Note, NoteKind, Project, WorkCategory } from '~/types/domain'
import { fmtDateLong } from '~/utils/format'

const props = defineProps<{
  kind: NoteKind
  /** 一覧に登録者列を出すか（議事録 = true） */
  showAuthor?: boolean
}>()

const notes = useNotes(props.kind)
const { tbl } = useMockDb()
const { show } = useToast()
const confirm = useConfirm()
const { currentUser, isAdmin } = useCurrentUser()

const projects = computed(() => (tbl('projects').value as Project[]).filter(p => p.active))
const companies = computed(() => (tbl('companies').value as Company[]).filter(c => c.active))
const workCategories = computed(() =>
  [...(tbl('workCategories').value as WorkCategory[])].filter(w => w.active)
    .sort((a, b) => a.displayOrder - b.displayOrder))
const members = tbl('members')

const form = ref({ title: '', body: '', projectId: '', companyId: '', workCategoryId: '' })
const saving = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

function meta(): { title: string; projectId: string | null; companyId: string | null; workCategoryId: string | null } {
  return {
    title: form.value.title,
    projectId: form.value.projectId || null,
    companyId: form.value.companyId || null,
    workCategoryId: form.value.workCategoryId || null,
  }
}

async function submit(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const res = await notes.add({ ...meta(), body: form.value.body })
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    show(props.kind === 'poipoi' ? 'メモを登録しました（AI の参照対象になります）' : '議事録を登録しました（AI の参照対象になります）')
    form.value = { ...form.value, title: '', body: '' }
  } finally {
    saving.value = false
  }
}

// ファイルは選択で即アップロードせず、ステージ表示 → 「取り込む」押下で実行する
// （オペレーター指示 2026-07-19 #5。紐付けセレクトの選択も取込時に適用される）
const stagedFile = ref<File | null>(null)

function onFileSelected(ev: Event): void {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (fileInput.value) fileInput.value.value = '' // 同一ファイルの再選択を可能にする
  if (file) stagedFile.value = file
}

function clearStaged(): void {
  stagedFile.value = null
}

async function submitImport(): Promise<void> {
  if (!stagedFile.value || saving.value) return
  saving.value = true
  try {
    const res = await notes.importFile(stagedFile.value, meta())
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    show(`「${stagedFile.value.name}」を取り込みました（AI の参照対象になります。誤操作は一覧から取消できます）`)
    stagedFile.value = null
  } finally {
    saving.value = false
  }
}

/** 取消可能か（poipoi = 本人 / minutes = 登録者 or 管理者） */
function canArchive(n: Note): boolean {
  return n.memberId === currentUser.value.id || (props.kind === 'minutes' && isAdmin.value)
}

async function onArchive(n: Note): Promise<void> {
  const ok = await confirm.ask(
    props.kind === 'poipoi' ? 'メモの取消' : '議事録の取消',
    `「${n.title}」を取り消しますか？（一覧と AI の参照対象から外れます）`,
    { danger: true, confirmLabel: '取り消す' },
  )
  if (!ok) return
  const res = await notes.archive(n.id)
  if (!res.ok) {
    show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  show('取り消しました', 'warn')
}

function nameOf(list: { id: string; name: string }[], id: string | null): string {
  return id ? (list.find(x => x.id === id)?.name ?? '') : ''
}

function linkLabels(n: Note): string[] {
  return [
    nameOf(projects.value, n.projectId) && `PJ: ${nameOf(projects.value, n.projectId)}`,
    nameOf(companies.value, n.companyId) && `顧客: ${nameOf(companies.value, n.companyId)}`,
    nameOf(workCategories.value, n.workCategoryId) && nameOf(workCategories.value, n.workCategoryId),
  ].filter((x): x is string => Boolean(x))
}

function authorOf(n: Note): string {
  return members.value.find(m => m.id === n.memberId)?.name ?? n.memberId
}
</script>

<template>
  <div class="grid gap-3">
    <UiSectionCard
      :title="kind === 'poipoi' ? 'メモを投げ込む' : '議事録を登録する'"
      :description="kind === 'poipoi'
        ? '思いついたことをそのまま。日報ドラフトの材料になり、AI チャットボット・AI業務アシスタントの参照対象（自分のみ）になります'
        : '会議の記録を蓄積します。全員が参照でき、AI チャットボット・AI業務アシスタントの参照対象になります'"
    >
      <div class="grid gap-2">
        <input
          v-if="kind === 'minutes'"
          v-model="form.title"
          type="text"
          class="input"
          placeholder="タイトル（空欄 = 本文の先頭行）"
          aria-label="タイトル"
        >
        <textarea
          v-model="form.body"
          class="textarea min-h-24"
          :placeholder="kind === 'poipoi' ? '例）A社の見積、明日までに単価見直しが必要そう' : '例）7/19 定例。決定事項: …'"
          :aria-label="kind === 'poipoi' ? 'メモ本文' : '議事録本文'"
        />
        <div class="flex flex-wrap items-center gap-2">
          <UiSelect v-model="form.projectId" :options="projects.map(p => ({ value: p.id, label: p.name }))" empty-label="プロジェクト（任意）" aria-label="プロジェクト" class="w-auto" />
          <UiSelect v-model="form.companyId" :options="companies.map(c => ({ value: c.id, label: c.name }))" empty-label="顧客（任意）" aria-label="顧客" class="w-auto" />
          <UiSelect v-model="form.workCategoryId" :options="workCategories.map(w => ({ value: w.id, label: w.name }))" empty-label="業務種別（任意）" aria-label="業務種別" class="w-auto" />
          <span class="ml-auto flex items-center gap-2">
            <input ref="fileInput" type="file" accept=".md,.txt,.pdf,.docx" class="hidden" @change="onFileSelected">
            <button type="button" class="btn" :disabled="saving" @click="fileInput?.click()">
              <FileUp class="h-4 w-4" aria-hidden="true" />
              ファイル選択
            </button>
            <button type="button" class="btn btn-primary" :disabled="saving" @click="submit">
              <Send class="h-4 w-4" aria-hidden="true" />
              {{ saving ? '登録中…' : '登録' }}
            </button>
          </span>
        </div>
        <!-- 選択済みファイルのステージ表示（即アップロードしない。取込ボタン押下で実行） -->
        <div
          v-if="stagedFile"
          class="flex flex-wrap items-center gap-2 rounded-lg border border-brand bg-brand-soft px-3 py-2 text-[12px]"
        >
          <span class="min-w-0 flex-1 truncate font-medium">{{ stagedFile.name }}</span>
          <span class="num text-muted">{{ Math.ceil(stagedFile.size / 1024) }}KB</span>
          <button type="button" class="btn btn-primary btn-sm" :disabled="saving" @click="submitImport">
            {{ saving ? '取込中…' : 'この内容で取り込む' }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="saving" aria-label="選択を解除" @click="clearStaged">
            <X class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        <p class="text-[11px] text-muted">ファイル取込は .md / .txt / .pdf / .docx（10MB まで。旧 .doc は .docx へ変換してください）。上の紐付けセレクトは取込にも適用されます</p>
      </div>
    </UiSectionCard>

    <UiSectionCard :title="`${kind === 'poipoi' ? 'メモ' : '議事録'}一覧（${notes.list.value.length}件）`" flush>
      <UiEmptyState
        v-if="notes.list.value.length === 0"
        icon="StickyNote"
        :title="kind === 'poipoi' ? 'まだメモがありません' : 'まだ議事録がありません'"
        hint="上のフォームから登録するか、ファイルを取り込んでください"
      />
      <ul v-else class="divide-y divide-line">
        <li v-for="n in notes.list.value" :key="n.id" class="px-4 py-2.5">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <p class="text-[13px] font-bold">{{ n.title }}</p>
            <span v-if="n.source === 'upload'" class="rounded-full bg-surface-soft border border-line px-2 text-[10px] text-sub">取込</span>
            <span class="num ml-auto text-[11px] text-muted">{{ fmtDateLong(n.createdAt) }}</span>
            <button
              v-if="canArchive(n)"
              type="button"
              class="btn btn-ghost btn-sm"
              :aria-label="`「${n.title}」を取り消す`"
              @click="onArchive(n)"
            >
              <Trash2 class="h-3.5 w-3.5 text-crit" aria-hidden="true" />
            </button>
          </div>
          <p class="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed text-sub">
            {{ n.body.length > 200 ? `${n.body.slice(0, 200)}…` : n.body }}
          </p>
          <div v-if="linkLabels(n).length > 0 || showAuthor" class="mt-1 flex flex-wrap gap-1 text-[11px] text-muted">
            <span v-if="showAuthor">{{ authorOf(n) }}</span>
            <span
              v-for="l in linkLabels(n)"
              :key="l"
              class="rounded-full bg-surface-soft border border-line px-2 py-0.5"
            >{{ l }}</span>
          </div>
        </li>
      </ul>
    </UiSectionCard>
  </div>
</template>
