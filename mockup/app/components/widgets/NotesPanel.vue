<script setup lang="ts">
/**
 * ノート共通パネル（ぽいぽいポスト / 議事録。バッチ7c/7e）。
 * テキスト登録（マークダウン対応・プレビュー付き）+ ドキュメント取込（.md/.txt/.pdf/.docx）+
 * サマリー一覧（押下で詳細モーダル = 全文をマークダウン描画）。
 * ぽいぽいポストは管理者が全メンバーのオリジナルを閲覧できる（フィードバック・チーム改善用途。バッチ7e）
 */
import { Eye, FileUp, Pencil, RotateCcw, Send, Trash2, X } from 'lucide-vue-next'
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

/** 表示名詞（poipoi = ポスト / minutes = 議事録。バッチ7e で「メモ」から改称） */
const noun = computed(() => (props.kind === 'poipoi' ? 'ポスト' : '議事録'))

const projects = computed(() => (tbl('projects').value as Project[]).filter(p => p.active))
const companies = computed(() => (tbl('companies').value as Company[]).filter(c => c.active))
const workCategories = computed(() =>
  [...(tbl('workCategories').value as WorkCategory[])].filter(w => w.active)
    .sort((a, b) => a.displayOrder - b.displayOrder))
const members = tbl('members')

const form = ref({ title: '', body: '', projectId: '', companyId: '', workCategoryId: '' })
const saving = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
// マークダウンプレビュー（入力はプレーンテキストのまま = 記法はそのまま保存され、表示時に描画される）
const previewing = ref(false)

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
    show(`${noun.value}を登録しました（AI の参照対象になります）`)
    form.value = { ...form.value, title: '', body: '' }
    previewing.value = false
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
    form.value = { ...form.value, title: '' } // タイトル欄も取込へ適用済み。次の登録へ引き継がない
  } finally {
    saving.value = false
  }
}

/** 取消可能か（poipoi = 本人 / minutes = 登録者 or 管理者） */
function canArchive(n: Note): boolean {
  return n.memberId === currentUser.value.id || (props.kind === 'minutes' && isAdmin.value)
}

// 取消済みの表示と復元（取消の取消 = 原則 9.5 の対称性。復元権限のある行のみ archived に入る）
const showArchived = ref(false)
const restoring = ref(false)

async function onRestore(n: Note): Promise<void> {
  if (restoring.value) return // 連打ガード（二重実行はサーバー側 no-op だが成功トーストの二重表示を防ぐ）
  restoring.value = true
  try {
    const res = await notes.restore(n.id)
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    show('復元しました（一覧と AI の参照対象に戻ります）')
  } finally {
    restoring.value = false
  }
}

async function onArchive(n: Note): Promise<void> {
  const ok = await confirm.ask(
    `${noun.value}の取消`,
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

// 詳細モーダル（一覧はサマリー/冒頭のみ表示し、押下で全文をマークダウン描画。バッチ7e）
const detailNote = ref<Note | null>(null)
const detailWithAuthor = ref(false)

function openDetail(n: Note, withAuthor: boolean): void {
  detailNote.value = n
  detailWithAuthor.value = withAuthor
}

/** 一覧のサマリー（冒頭 160 字。全文は詳細モーダルで） */
function summaryOf(n: Note): string {
  const flat = n.body.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
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
      :title="kind === 'poipoi' ? 'ポストを投げ込む' : '議事録を登録する'"
      :description="kind === 'poipoi'
        ? '思いついたこと・気づき・改善アイデアをそのまま。日報ドラフトの材料になり、AI の参照対象（自分のみ）になります。管理者はフィードバック・チーム改善のためオリジナルを閲覧できます'
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
        <!-- 本文（マークダウン対応。プレビューはトグルで切替 = 入力そのものはプレーンな textarea） -->
        <div v-if="previewing" class="rounded-lg border border-line bg-surface p-3 min-h-24">
          <UiMarkdown v-if="form.body.trim()" :source="form.body" />
          <p v-else class="text-[12px] text-muted">（本文が空です。「編集に戻る」から入力してください）</p>
        </div>
        <textarea
          v-else
          v-model="form.body"
          class="textarea min-h-24"
          :placeholder="kind === 'poipoi' ? '例）A社の見積、明日までに単価見直しが必要そう' : '例）7/19 定例。決定事項: …'"
          :aria-label="kind === 'poipoi' ? 'ポスト本文' : '議事録本文'"
        />
        <div class="flex flex-wrap items-center gap-2">
          <UiSelect v-model="form.projectId" :options="projects.map(p => ({ value: p.id, label: p.name }))" empty-label="プロジェクト（任意）" aria-label="プロジェクト" class="w-auto" />
          <UiSelect v-model="form.companyId" :options="companies.map(c => ({ value: c.id, label: c.name }))" empty-label="顧客（任意）" aria-label="顧客" class="w-auto" />
          <UiSelect v-model="form.workCategoryId" :options="workCategories.map(w => ({ value: w.id, label: w.name }))" empty-label="業務種別（任意）" aria-label="業務種別" class="w-auto" />
          <span class="ml-auto flex items-center gap-2">
            <button type="button" class="btn btn-sm" :aria-pressed="previewing" @click="previewing = !previewing">
              <component :is="previewing ? Pencil : Eye" class="h-3.5 w-3.5" aria-hidden="true" />
              {{ previewing ? '編集に戻る' : 'プレビュー' }}
            </button>
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
        <p class="text-[11px] text-muted">本文はマークダウン記法（見出し・箇条書き・強調・リンク等）に対応。ファイル取込は .md / .txt / .pdf / .docx（10MB まで。旧 .doc は .docx へ変換してください）。上の紐付けセレクト{{ kind === 'minutes' ? 'とタイトル欄' : '' }}は取込にも適用されます</p>
      </div>
    </UiSectionCard>

    <UiSectionCard
      :title="`${noun}一覧（${notes.list.value.length}件）`"
      :description="`登録日時・${kind === 'minutes' ? '投稿者・' : ''}冒頭を一覧表示。押下で全文を表示します`"
      flush
    >
      <UiEmptyState
        v-if="notes.list.value.length === 0"
        icon="StickyNote"
        :title="`まだ${noun}がありません`"
        hint="上のフォームから登録するか、ファイルを取り込んでください"
      />
      <ul v-else class="divide-y divide-line">
        <li v-for="n in notes.list.value" :key="n.id" class="flex items-start gap-1 px-4 py-2.5">
          <button
            type="button"
            class="min-w-0 flex-1 rounded-md text-left transition-colors hover:bg-brand-soft"
            :aria-label="`「${n.title}」の詳細を表示`"
            @click="openDetail(n, !!showAuthor)"
          >
            <span class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span class="text-[13px] font-bold">{{ n.title }}</span>
              <span v-if="n.source === 'upload'" class="rounded-full bg-surface-soft border border-line px-2 text-[10px] text-sub">取込</span>
              <span class="num ml-auto text-[11px] text-muted">{{ fmtDateLong(n.createdAt) }}</span>
            </span>
            <span class="mt-0.5 block text-[12px] leading-relaxed text-sub">{{ summaryOf(n) }}</span>
            <span v-if="linkLabels(n).length > 0 || showAuthor" class="mt-1 flex flex-wrap gap-1 text-[11px] text-muted">
              <span v-if="showAuthor">{{ authorOf(n) }}</span>
              <span
                v-for="l in linkLabels(n)"
                :key="l"
                class="rounded-full bg-surface-soft border border-line px-2 py-0.5"
              >{{ l }}</span>
            </span>
          </button>
          <button
            v-if="canArchive(n)"
            type="button"
            class="btn btn-ghost btn-sm shrink-0"
            :aria-label="`「${n.title}」を取り消す`"
            @click="onArchive(n)"
          >
            <Trash2 class="h-3.5 w-3.5 text-crit" aria-hidden="true" />
          </button>
        </li>
      </ul>
      <!-- 取消済み（復元権限のある行のみ）。誤って取り消した場合の立ち戻り導線 -->
      <div v-if="notes.archived.value.length > 0" class="border-t border-line px-4 py-2">
        <button type="button" class="btn btn-ghost btn-sm" @click="showArchived = !showArchived">
          {{ showArchived ? '取消済みを隠す' : `取消済みを表示（${notes.archived.value.length}件）` }}
        </button>
        <ul v-if="showArchived" class="mt-1 divide-y divide-line">
          <li v-for="n in notes.archived.value" :key="n.id" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
            <p class="text-[13px] text-muted line-through">{{ n.title }}</p>
            <span class="num ml-auto text-[11px] text-muted">{{ fmtDateLong(n.createdAt) }}</span>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="restoring" :aria-label="`「${n.title}」を復元する`" @click="onRestore(n)">
              <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
              元に戻す
            </button>
          </li>
        </ul>
      </div>
    </UiSectionCard>

    <!-- 管理者の全ポスト閲覧（ぽいぽいポストのみ。フィードバック・チーム改善用途 = バッチ7e） -->
    <UiSectionCard
      v-if="kind === 'poipoi' && isAdmin && notes.adminList.value.length > 0"
      :title="`全メンバーのポスト（管理者・${notes.adminList.value.length}件）`"
      description="チーム改善のフィードバックとしてオリジナルを閲覧できます（AI の参照対象は投稿者本人のみのまま。取消は本人のみ）"
      flush
    >
      <ul class="divide-y divide-line">
        <li v-for="n in notes.adminList.value" :key="n.id">
          <button
            type="button"
            class="w-full px-4 py-2.5 text-left transition-colors hover:bg-brand-soft"
            :aria-label="`${authorOf(n)} の「${n.title}」の詳細を表示`"
            @click="openDetail(n, true)"
          >
            <span class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span class="text-[12px] font-semibold text-sub">{{ authorOf(n) }}</span>
              <span class="text-[13px] font-bold">{{ n.title }}</span>
              <span class="num ml-auto text-[11px] text-muted">{{ fmtDateLong(n.createdAt) }}</span>
            </span>
            <span class="mt-0.5 block text-[12px] leading-relaxed text-sub">{{ summaryOf(n) }}</span>
          </button>
        </li>
      </ul>
    </UiSectionCard>

    <!-- 詳細モーダル（全文をマークダウン描画） -->
    <UiModal :open="!!detailNote" :title="detailNote?.title ?? ''" @close="detailNote = null">
      <div v-if="detailNote" class="grid gap-3">
        <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span v-if="detailWithAuthor" class="font-semibold text-sub">{{ authorOf(detailNote) }}</span>
          <span class="num">{{ fmtDateLong(detailNote.createdAt) }}</span>
          <span v-if="detailNote.source === 'upload'" class="rounded-full bg-surface-soft border border-line px-2 text-[10px] text-sub">取込</span>
          <span
            v-for="l in linkLabels(detailNote)"
            :key="l"
            class="rounded-full bg-surface-soft border border-line px-2 py-0.5"
          >{{ l }}</span>
        </div>
        <UiMarkdown :source="detailNote.body" />
      </div>
    </UiModal>
  </div>
</template>
