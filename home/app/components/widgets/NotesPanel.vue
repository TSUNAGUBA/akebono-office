<script setup lang="ts">
/**
 * ノート共通パネル（ぽいぽいポスト / 議事録。バッチ7c/7e）。
 * テキスト登録（マークダウン対応・プレビュー付き）+ ドキュメント取込（.md/.txt/.pdf/.docx）+
 * サマリー一覧（押下で詳細モーダル = 全文をマークダウン描画）。
 * ぽいぽいポストは管理者が全メンバーのオリジナルを閲覧できる（フィードバック・チーム改善用途。バッチ7e）
 */
import { Eye, FileText, FileUp, Film, Link2, Pencil, RefreshCw, RotateCcw, Send, Trash2, Video, X } from 'lucide-vue-next'
import type { Company, Note, NoteKind, Project, WorkCategory } from '~/types/domain'
import type { MeetFile, MeetFolder } from '~/composables/useMeetLink'
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
const noun = computed(() => (props.kind === 'poipoi' ? 'タネ' : '議事録'))

const projects = computed(() => (tbl('projects').value as Project[]).filter(p => p.active))
const companies = computed(() => (tbl('companies').value as Company[]).filter(c => c.active))
const workCategories = computed(() =>
  [...(tbl('workCategories').value as WorkCategory[])].filter(w => w.active)
    .sort((a, b) => a.displayOrder - b.displayOrder))
const members = tbl('members')

// 一覧のページング（1 ページ 20 件 = 改修依頼 2026-08-18。クライアントページング。
// 取消済み一覧は復元導線 = 少件数想定のため従来どおり全件表示）
const { page: listPage, pageSize: listPageSize, rows: pagedNotes, total: listTotal } = useListView<Note>({ source: notes.list })
const { page: adminPage, pageSize: adminPageSize, rows: pagedAdminNotes, total: adminTotal } = useListView<Note>({ source: notes.adminList })
// デモユーザー切替で一覧の中身が入れ替わるため 1 ページ目へ戻す（件数減のはみ出しは useListView が自動補正）
watch(() => currentUser.value.id, () => { listPage.value = 1; adminPage.value = 1 })

const form = ref({ title: '', body: '', projectId: '', companyId: '', workCategoryId: '' })
const saving = ref(false)

// プロジェクト選択で顧客を補完（プロジェクトマスタの顧客 = Project.companyId が SoT。オペレーター指示 2026-08-03）。
// 顧客の手動変更は妨げない（プロジェクトを選び直した時のみ上書き）。
watch(() => form.value.projectId, (pid) => {
  if (!pid) return
  const proj = projects.value.find(p => p.id === pid)
  if (proj?.companyId) form.value.companyId = proj.companyId
})
// 入力モーダル（バッチ7h: 参照 = 基本ビュー・入力 = ボタン押下でモーダル表示。指示 #10 ④）
const composeOpen = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
// マークダウンプレビュー（入力はプレーンテキストのまま = 記法はそのまま保存され、表示時に描画される）
const previewing = ref(false)

// ---------- Google Meet 連携（議事録の AI メモ/録画リンク。API モード限定 = documents のドライブ取込と同型） ----------
const isApi = useApiMode()
const meet = useMeetLink()
const meetFile = ref<{ id: string; name: string; webLink: string; fileKind: MeetFile['fileKind'] } | null>(null)
const meetFolderId = ref('')     // 現在参照中フォルダ（空 = 既定フォルダ）
const meetFolderName = ref('')
const meetFolders = ref<MeetFolder[]>([])
const meetFiles = ref<MeetFile[]>([])
const meetFolderSearch = ref('')
const meetPickingFolder = ref(false)
const meetBusy = ref(false)
/** Meet 連携セクションを出すか（議事録 + API + OAuth 構成済み） */
const showMeet = computed(() => props.kind === 'minutes' && isApi && !!meet.status.value?.available)
const meetConnected = computed(() => !!meet.status.value?.connected && !!meet.status.value?.driveScope)

async function loadMeetFiles(): Promise<void> {
  const fid = meetFolderId.value || meet.status.value?.defaultFolder?.id || ''
  if (!fid) { meetFiles.value = []; return } // フォルダ未選択（既定なし）= フォルダ選択を促す
  meetBusy.value = true
  try {
    meetFiles.value = await meet.listFiles(fid)
  } catch (e) {
    show(`ファイル一覧の取得に失敗しました（${(e as Error).message}）`, 'crit')
  } finally { meetBusy.value = false }
}
async function searchMeetFolders(): Promise<void> {
  meetBusy.value = true
  try {
    meetFolders.value = await meet.listFolders(meetFolderSearch.value)
  } catch (e) {
    show(`フォルダ一覧の取得に失敗しました（${(e as Error).message}）`, 'crit')
  } finally { meetBusy.value = false }
}
function toggleMeetFolderPicker(): void {
  meetPickingFolder.value = !meetPickingFolder.value
  if (meetPickingFolder.value && meetFolders.value.length === 0) void searchMeetFolders()
}
function selectMeetFolder(f: MeetFolder): void {
  meetFolderId.value = f.id
  meetFolderName.value = f.name
  meetPickingFolder.value = false
  void loadMeetFiles()
}
function pickMeetFile(f: MeetFile): void {
  meetFile.value = { id: f.id, name: f.name, webLink: f.webViewLink, fileKind: f.fileKind }
}
function clearMeetFile(): void { meetFile.value = null }
async function importMeetNotes(): Promise<void> {
  if (!meetFile.value || meetBusy.value) return
  meetBusy.value = true
  try {
    const text = await meet.fetchFileText(meetFile.value.id)
    if (!text) { show('AI メモの本文が空でした', 'warn'); return }
    form.value.body = form.value.body ? `${form.value.body}\n\n${text}` : text
    show('AI メモを本文へ取り込みました（内容を確認して登録してください）', 'ok')
  } catch (e) {
    show(`AI メモの取込に失敗しました（${(e as Error).message}）`, 'crit')
  } finally { meetBusy.value = false }
}
/** 現在のフォルダを既定に設定（管理者のみ） */
async function setMeetDefaultFolder(): Promise<void> {
  const id = meetFolderId.value || meet.status.value?.defaultFolder?.id || ''
  const name = meetFolderName.value || meet.status.value?.defaultFolder?.name || ''
  if (!id) { show('先に保管フォルダを選択してください', 'warn'); return }
  await meet.setDefaultFolder({ id, name })
}

// モーダルを開いたら連携状態を取得し、既定フォルダのファイルを読み込む（議事録 + API のみ）
watch(composeOpen, async (open) => {
  if (!open || props.kind !== 'minutes' || !isApi) return
  meetFile.value = null
  meetPickingFolder.value = false
  meetFolders.value = []
  meetFiles.value = []
  await meet.refreshStatus()
  const def = meet.status.value?.defaultFolder ?? null
  meetFolderId.value = def?.id ?? ''
  meetFolderName.value = def?.name ?? ''
  if (meetConnected.value) await loadMeetFiles()
})

function meta(): {
  title: string; projectId: string | null; companyId: string | null; workCategoryId: string | null
  meetFileId: string | null; meetFileName: string | null; meetWebLink: string | null
} {
  return {
    title: form.value.title,
    projectId: form.value.projectId || null,
    companyId: form.value.companyId || null,
    workCategoryId: form.value.workCategoryId || null,
    meetFileId: meetFile.value?.id ?? null,
    meetFileName: meetFile.value?.name ?? null,
    meetWebLink: meetFile.value?.webLink ?? null,
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
    meetFile.value = null
    previewing.value = false
    composeOpen.value = false
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
    composeOpen.value = false
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

// 通知ディープリンク: ?open=<ノートid> で詳細モーダルを直接開く（改善のタネ通知から対象ポストへ即到達 =
// 改修依頼 2026-08-18。取り込み・URL 除去は共通の useRouteDeepLink = 原則3）。
// 自分のノート → 管理者閲覧一覧の順で探し、API モードは取得完了後に見つかった時点で一度だけ開く。
// 参照権限が無い（一覧に現れない）場合は開かず一覧表示のまま（非ブロッキング）
const openDeepLink = useRouteDeepLink('open')
watchEffect(() => {
  if (!openDeepLink.pending.value) return
  const own = notes.list.value.find(n => n.id === openDeepLink.pending.value)
  const fromAdmin = own ? undefined : notes.adminList.value.find(n => n.id === openDeepLink.pending.value)
  const target = own ?? fromAdmin
  if (!target) return
  openDeepLink.consume()
  openDetail(target, !!fromAdmin)
})
// デモユーザー切替時は滞留した対象 id を破棄する（参照権限が無く開けなかった対象が、切替後
// 〔管理者化等〕に操作なしでモーダルを開いてしまう滞留を作らない = inbox の非管理者破棄と同趣旨）
watch(() => currentUser.value.id, () => openDeepLink.consume())
// 見つからないまま（取消済み・権限外等）の対象 id は一定時間で破棄する（レビュー R15）。
// 破棄しないと、後の再読込で対象が再出現した瞬間（例: 投稿者が復元）に操作なしでモーダルが開いてしまう。
// API の非同期初期ロードには十分な猶予を取る
const DEEP_LINK_WAIT_MS = 15_000
watch(() => openDeepLink.pending.value, (v) => {
  if (!v) return
  setTimeout(() => {
    if (openDeepLink.pending.value === v) openDeepLink.consume()
  }, DEEP_LINK_WAIT_MS)
}, { immediate: true })

/** 一覧のサマリー（冒頭 160 字。全文は詳細モーダルで。コードポイント単位 = 絵文字等を境界で壊さない） */
function summaryOf(n: Note): string {
  const chars = [...n.body.replace(/\s+/g, ' ').trim()]
  return chars.length > 160 ? `${chars.slice(0, 160).join('')}…` : chars.join('')
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
    <!-- 一覧 = 基本ビュー（バッチ7h: 入力はヘッダーのボタン → モーダル。指示 #10 ④） -->
    <UiSectionCard
      :title="`${noun}一覧（${notes.list.value.length}件）`"
      :description="`登録日時・${kind === 'minutes' ? '投稿者・' : ''}冒頭を一覧表示。押下で全文を表示します`"
      flush
    >
      <template #actions>
        <button type="button" class="btn btn-primary btn-sm" @click="composeOpen = true">
          <Send class="h-3.5 w-3.5" aria-hidden="true" />
          {{ kind === 'poipoi' ? 'タネを投げ込む' : '議事録を登録する' }}
        </button>
      </template>
      <UiEmptyState
        v-if="notes.list.value.length === 0"
        icon="StickyNote"
        :title="`まだ${noun}がありません`"
        :hint="`「${kind === 'poipoi' ? 'タネを投げ込む' : '議事録を登録する'}」からテキスト登録またはファイル取込ができます`"
      />
      <ul v-else class="divide-y divide-line">
        <li v-for="n in pagedNotes" :key="n.id" class="flex items-start gap-1 px-4 py-2.5">
          <button
            type="button"
            class="min-w-0 flex-1 rounded-md text-left transition-colors hover:bg-brand-soft"
            :aria-label="`「${n.title}」の詳細を表示`"
            @click="openDetail(n, !!showAuthor)"
          >
            <span class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span class="text-[13px] font-bold">{{ n.title }}</span>
              <span v-if="n.source === 'upload'" class="rounded-full bg-surface-soft border border-line px-2 text-[10px] text-sub">取込</span>
              <span v-if="n.meetFileId" class="inline-flex items-center gap-0.5 rounded-full bg-surface-soft border border-line px-2 text-[10px] text-sub"><Video class="h-3 w-3" aria-hidden="true" />Meet</span>
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
      <UiPagination v-model:page="listPage" v-model:page-size="listPageSize" :total="listTotal" />
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

    <!-- 入力モーダル（テキスト登録 + ファイル取込。バッチ7h で一覧上部の同居フォームから移設） -->
    <UiModal
      :open="composeOpen"
      :title="kind === 'poipoi' ? 'タネを投げ込む' : '議事録を登録する'"
      width="680px"
      @close="composeOpen = false"
    >
      <div class="grid gap-2">
        <p class="text-[12px] text-muted">
          {{ kind === 'poipoi'
            ? '思いついたこと・気づき・改善アイデアをそのまま。日報ドラフトの材料になり、AI の参照対象になります。管理者はフィードバック・チーム改善のためオリジナルを閲覧できます'
            : '会議の記録を蓄積します。全員が参照でき、AI チャットボット・AI業務アシスタントの参照対象になります' }}
        </p>
        <!-- プロジェクト/顧客/業務種別（フォーム上部 = オペレーター指示 2026-08-03。プロジェクト選択で顧客を補完） -->
        <div class="flex flex-wrap items-center gap-2">
          <UiSelect v-model="form.projectId" :options="projects.map(p => ({ value: p.id, label: p.name }))" empty-label="プロジェクト" aria-label="プロジェクト" class="w-auto" />
          <UiSelect v-model="form.companyId" :options="companies.map(c => ({ value: c.id, label: c.name }))" empty-label="顧客" aria-label="顧客" class="w-auto" />
          <UiSelect v-model="form.workCategoryId" :options="workCategories.map(w => ({ value: w.id, label: w.name }))" empty-label="業務種別" aria-label="業務種別" class="w-auto" />
        </div>

        <!-- Google Meet 連携（議事録・API モードのみ。Drive の AI メモ/録画を選んで議事録へリンク） -->
        <div v-if="showMeet" class="grid gap-2 rounded-lg border border-line bg-page p-2.5">
          <div class="flex items-center gap-1.5 text-[12px] font-semibold text-muted">
            <Video class="h-3.5 w-3.5" aria-hidden="true" />
            Google Meet 連携（AI メモ・録画）
          </div>
          <!-- 未接続: カレンダー連携へ誘導（drive.readonly を含む = documents のドライブ取込と同型） -->
          <p v-if="!meetConnected" class="text-[12px] text-sub">
            Google ドライブ連携が未接続です。
            <NuxtLink to="/ai-assistant" class="text-brand underline">AI アシスタントのカレンダー連携</NuxtLink>
            から Google に接続してください（ドライブ読取の許可が追加され、Meet の AI メモ・録画を選べます）。
          </p>
          <template v-else>
            <!-- 選択済みファイル -->
            <div v-if="meetFile" class="flex flex-wrap items-center gap-2 rounded border border-brand bg-brand-soft px-2.5 py-1.5 text-[12px]">
              <Link2 class="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate font-medium">{{ meetFile.name }}</span>
              <button v-if="meetFile.fileKind === 'notes'" type="button" class="btn btn-ghost btn-sm" :disabled="meetBusy" @click="importMeetNotes">AI メモを本文へ取込</button>
              <button type="button" class="btn btn-ghost btn-sm" aria-label="リンクを解除" @click="clearMeetFile">
                <X class="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>

            <!-- 保管フォルダ（既定を初期表示・違う場合のみ選び直す） -->
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
              <span class="text-muted">保管フォルダ:</span>
              <span class="font-medium">{{ meetFolderName || meet.status.value?.defaultFolder?.name || '（未選択）' }}</span>
              <span v-if="!meetFolderId && meet.status.value?.defaultFolder" class="rounded-full bg-surface-soft border border-line px-1.5 text-[10px] text-muted">既定</span>
              <button type="button" class="btn btn-ghost btn-sm" @click="toggleMeetFolderPicker">別のフォルダを選ぶ</button>
              <button
                v-if="meet.isAdmin.value && (meetFolderId || meet.status.value?.defaultFolder)"
                type="button" class="btn btn-ghost btn-sm" @click="setMeetDefaultFolder"
              >このフォルダを既定に</button>
            </div>

            <!-- フォルダ選択 -->
            <div v-if="meetPickingFolder" class="grid gap-1.5">
              <div class="flex gap-2">
                <input v-model="meetFolderSearch" class="input flex-1" type="text" placeholder="フォルダ名で検索（空で最近更新順）" aria-label="フォルダ検索" @keyup.enter="searchMeetFolders">
                <button type="button" class="btn btn-sm" :disabled="meetBusy" @click="searchMeetFolders">検索</button>
              </div>
              <div v-if="meetFolders.length > 0" class="max-h-32 overflow-y-auto rounded border border-line">
                <button v-for="f in meetFolders" :key="f.id" type="button" class="block w-full border-b border-line px-2.5 py-1.5 text-left text-[12px] last:border-b-0 hover:bg-surface" @click="selectMeetFolder(f)">
                  {{ f.name }}
                </button>
              </div>
            </div>

            <!-- ファイル一覧（Meet の AI メモ = ドキュメント / 録画 = 動画） -->
            <p v-if="meetBusy" class="text-[12px] text-muted">読み込み中…</p>
            <div v-else-if="meetFiles.length > 0" class="max-h-40 overflow-y-auto rounded border border-line">
              <button
                v-for="f in meetFiles" :key="f.id" type="button"
                class="flex w-full items-center gap-2 border-b border-line px-2.5 py-1.5 text-left text-[12px] last:border-b-0 hover:bg-surface"
                :class="{ 'bg-brand-soft': f.id === meetFile?.id }"
                @click="pickMeetFile(f)"
              >
                <component :is="f.fileKind === 'recording' ? Film : f.fileKind === 'notes' ? FileText : Link2" class="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate">{{ f.name }}</span>
              </button>
            </div>
            <p v-else class="text-[12px] text-muted">このフォルダに Meet のファイルが見つかりません（別のフォルダを選んでください）。</p>
          </template>
        </div>

        <input
          v-if="kind === 'minutes'"
          v-model="form.title"
          type="text"
          class="input"
          placeholder="タイトル（空欄 = 本文の先頭行）"
          aria-label="タイトル"
        >
        <!-- 本文（マークダウン対応。プレビューはトグルで切替 = 入力そのものはプレーンな textarea。
             テキスト登録では必須 = useNotes.add が空を拒否するため必須マーカーを明示（改修依頼 2026-08-20 第2バッチ） -->
        <UiFormField label="本文" required>
          <div v-if="previewing" class="rounded-lg border border-line bg-surface p-3 min-h-24">
            <UiMarkdown v-if="form.body.trim()" :source="form.body" />
            <p v-else class="text-[12px] text-muted">（本文が空です。「編集に戻る」から入力してください）</p>
          </div>
          <textarea
            v-else
            v-model="form.body"
            class="textarea min-h-24"
            :placeholder="kind === 'poipoi' ? '例）A社の見積、明日までに単価見直しが必要そう' : '例）7/19 定例。決定事項: …'"
            :aria-label="kind === 'poipoi' ? 'タネ本文' : '議事録本文'"
          />
        </UiFormField>
        <div class="flex flex-wrap items-center justify-end gap-2">
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
    </UiModal>

    <!-- 管理者の全ポスト閲覧（ぽいぽいポストのみ。フィードバック・チーム改善用途 = バッチ7e）。
         0 件でもセクションを出す = 再読み込みボタンで新着を確認できる導線を常設 -->
    <UiSectionCard
      v-if="kind === 'poipoi' && isAdmin"
      :title="`メンバーのタネ（管理者・${notes.adminList.value.length}件）`"
      description="チーム改善のフィードバックとしてオリジナルを閲覧できます（自分のタネは上の一覧に表示。AI の参照対象は投稿者本人のみ・取消も本人のみ）"
      flush
    >
      <template #actions>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="メンバーのタネを再読み込み" @click="notes.refresh()">
          <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
          再読み込み
        </button>
      </template>
      <p v-if="notes.adminList.value.length === 0" class="px-4 py-3 text-[12px] text-muted">
        メンバーのタネはまだありません（自分のタネは上の一覧に表示されます）
      </p>
      <ul v-else class="divide-y divide-line">
        <li v-for="n in pagedAdminNotes" :key="n.id">
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
      <UiPagination v-model:page="adminPage" v-model:page-size="adminPageSize" :total="adminTotal" />
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
        <a
          v-if="detailNote.meetFileId"
          :href="detailNote.meetWebLink || undefined"
          :target="detailNote.meetWebLink ? '_blank' : undefined"
          rel="noopener"
          class="inline-flex w-fit items-center gap-1.5 text-[12px]"
          :class="detailNote.meetWebLink ? 'text-brand hover:underline' : 'text-sub'"
        >
          <Video class="h-3.5 w-3.5" aria-hidden="true" />
          Google Meet: {{ detailNote.meetFileName || 'リンク' }}
        </a>
        <UiMarkdown :source="detailNote.body" />
      </div>
    </UiModal>
  </div>
</template>
