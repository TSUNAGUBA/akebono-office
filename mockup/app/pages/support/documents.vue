<script setup lang="ts">
/**
 * F-09-3 ドキュメント管理: 左フォルダツリー + 右一覧（検索・タグ・アップロード・プレビュードロワー）
 * モバイルはツリーを横並びチップに切替。検索時はツリー選択を無視して全体検索。
 * バッチ7l（本実装）: 実ファイルのアップロード・ダウンロード（署名 URL → base64 縮退）・
 * Google ドライブ取込・アーカイブ済みの復元（原則 9.5）。取込済みは AI（チャットボット等）の参照対象
 */
import { ChevronDown, ChevronRight, CloudDownload, Download, FileText, Folder, FolderPlus, FolderOpen, RotateCcw, Upload } from 'lucide-vue-next'
import type { DocumentNode } from '~/types/domain'
import type { TableColumn } from '~/types/ui'
import { fmtDateLong, fmtDateTime } from '~/utils/format'
import type { DriveFile } from '~/composables/useDocuments'

const { isEnabled } = useAppSettings()
const { itemsOf } = useCodeMaster()
const docs = useDocuments()
const { tbl } = useMockDb()
const members = tbl('members')
const toast = useToast()
const confirm = useConfirm()

// ---------- ツリー状態 ----------
const selectedFolderId = ref<string | null>(null)
const expanded = ref<Set<string>>(new Set(docs.activeFolders.value.map(f => f.id)))

function toggleExpand(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/** 開閉状態を反映した表示行（親が閉じている行は隠す） */
const visibleFolderRows = computed(() =>
  docs.folderRows.value.filter((row) => {
    let pid = row.folder.parentId
    let guard = 0
    while (pid && guard < 10) {
      if (!expanded.value.has(pid)) return false
      pid = docs.byId(pid)?.parentId ?? null
      guard++
    }
    return true
  }),
)

/** select 用のフォルダ選択肢（深さインデント付き） */
const folderOptions = computed(() =>
  docs.folderRows.value.map(r => ({
    value: r.folder.id,
    label: `${'　'.repeat(r.depth)}${r.folder.name}`,
  })),
)

// ---------- 検索・フィルタ ----------
const query = ref('')
const tagFilter = ref<string[]>([])
const tagOptions = computed(() => itemsOf('documentTag'))
const searching = computed(() => query.value.trim() !== '')

const fileRows = computed<DocumentNode[]>(() => {
  if (searching.value) return docs.searchFiles(query.value, tagFilter.value)
  const base = docs.filesIn(selectedFolderId.value)
  if (tagFilter.value.length === 0) return base
  return base.filter(f => tagFilter.value.some(t => f.tags.includes(t)))
})

function memberName(id: string): string {
  return members.value.find(m => m.id === id)?.name ?? id
}

const columns: TableColumn[] = [
  { key: 'name', label: '名前', primary: true },
  { key: 'tags', label: 'タグ', width: '140px', primary: true },
  { key: 'updatedBy', label: '更新者', width: '110px' },
  { key: 'updatedAt', label: '更新日', width: '110px', primary: true },
  { key: 'size', label: 'サイズ', width: '80px', align: 'right' },
]

const tableRows = computed(() =>
  fileRows.value.map(f => ({
    id: f.id,
    name: f.name,
    tags: f.tags.join(' '),
    updatedBy: memberName(f.updatedBy),
    updatedAt: fmtDateLong(f.updatedAt),
    size: f.size ?? '—',
  })),
)

// ---------- プレビュードロワー ----------
const selectedDoc = ref<DocumentNode | null>(null)
const editForm = reactive({ name: '', tags: [] as string[], summary: '' })
const editError = ref('')

function openPreview(row: Record<string, unknown>): void {
  const doc = docs.byId(String(row.id))
  if (!doc) return
  selectedDoc.value = doc
  editForm.name = doc.name
  editForm.tags = [...doc.tags]
  editForm.summary = doc.summary
  editError.value = ''
}

async function saveEdit(): Promise<void> {
  if (!selectedDoc.value) return
  const r = await docs.updateFile(selectedDoc.value.id, {
    name: editForm.name,
    tags: editForm.tags,
    summary: editForm.summary,
  })
  if (!r.ok) {
    editError.value = r.error.message
    return
  }
  editError.value = ''
  selectedDoc.value = docs.byId(selectedDoc.value.id) ?? null
  toast.show('保存しました')
}

async function archiveDoc(): Promise<void> {
  if (!selectedDoc.value) return
  const ok = await confirm.ask('アーカイブ', `「${selectedDoc.value.name}」をアーカイブ（無効化）します。一覧に表示されなくなります（「アーカイブ済み」からいつでも復元できます）。`, { danger: true, confirmLabel: 'アーカイブ' })
  if (!ok) return
  const r = await docs.archive(selectedDoc.value.id)
  if (r.ok) {
    toast.show('アーカイブしました（復元可能）')
    selectedDoc.value = null
  } else {
    toast.show(r.error.message, 'crit')
  }
}

// ---------- ダウンロード（API モード。署名 URL → base64 縮退） ----------
const downloading = ref(false)

async function doDownload(): Promise<void> {
  if (!selectedDoc.value || downloading.value) return
  downloading.value = true
  try {
    const r = await docs.downloadFile(selectedDoc.value.id)
    if (!r.ok) toast.show(r.error.message, 'crit')
  } finally {
    downloading.value = false
  }
}

// ---------- アーカイブ済みの復元（原則 9.5） ----------
const showArchived = ref(false)

async function restoreDoc(id: string): Promise<void> {
  const r = await docs.restore(id)
  if (r.ok) toast.show('復元しました')
  else toast.show(r.error.message, 'crit')
}

// ---------- アップロード（API = 実ファイル / モック = メタのみ） ----------
const uploadOpen = ref(false)
const uploadForm = reactive({ name: '', parentId: '', tags: [] as string[], summary: '' })
const uploadError = ref('')
const uploadFile = ref<File | null>(null)
const uploading = ref(false)

function openUpload(): void {
  uploadForm.name = ''
  uploadForm.parentId = selectedFolderId.value ?? (docs.folderRows.value[0]?.folder.id ?? '')
  uploadForm.tags = []
  uploadForm.summary = ''
  uploadError.value = ''
  uploadFile.value = null
  uploadOpen.value = true
}

function onFilePick(e: Event): void {
  uploadFile.value = (e.target as HTMLInputElement).files?.[0] ?? null
}

async function doUpload(): Promise<void> {
  if (uploading.value) return
  uploading.value = true
  try {
    let r: { ok: boolean; error?: { message: string }; extracted?: boolean }
    if (docs.isApi) {
      if (!uploadFile.value) {
        uploadError.value = 'ファイルを選択してください'
        return
      }
      r = await docs.uploadFile({
        file: uploadFile.value,
        parentId: uploadForm.parentId || null,
        tags: uploadForm.tags,
        summary: uploadForm.summary,
      })
    } else {
      r = docs.addFile({
        name: uploadForm.name,
        parentId: uploadForm.parentId || null,
        tags: uploadForm.tags,
        summary: uploadForm.summary,
      })
    }
    if (!r.ok) {
      uploadError.value = r.error?.message ?? 'アップロードに失敗しました'
      return
    }
    uploadOpen.value = false
    query.value = ''
    selectedFolderId.value = uploadForm.parentId || null
    toast.show(docs.isApi
      ? (r.extracted ? 'アップロードしました（テキスト抽出済み = AI 検索対象）' : 'アップロードしました（テキスト抽出なし = 保管・ダウンロードのみ）')
      : 'アップロードしました（モック）')
  } finally {
    uploading.value = false
  }
}

// ---------- Google ドライブ取込（API モード） ----------
const driveOpen = ref(false)
const driveState = ref<{ available: boolean; connected: boolean; driveScope: boolean } | null>(null)
const driveQuery = ref('')
const driveResults = ref<DriveFile[]>([])
const driveSelected = ref<Set<string>>(new Set())
const driveBusy = ref(false)
const driveTargetFolder = ref('')
const driveError = ref('')

async function openDrive(): Promise<void> {
  driveOpen.value = true
  driveQuery.value = ''
  driveResults.value = []
  driveSelected.value = new Set()
  driveTargetFolder.value = selectedFolderId.value ?? ''
  driveError.value = ''
  driveState.value = null
  driveState.value = await docs.driveStatus()
  if (driveState.value.connected && driveState.value.driveScope) await doDriveSearch()
}

async function doDriveSearch(): Promise<void> {
  driveBusy.value = true
  driveError.value = ''
  try {
    const r = await docs.driveSearch(driveQuery.value)
    if (!r.ok) {
      driveError.value = r.error.message
      return
    }
    driveResults.value = r.files ?? []
  } finally {
    driveBusy.value = false
  }
}

function toggleDriveFile(id: string): void {
  const next = new Set(driveSelected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  driveSelected.value = next
}

async function doDriveImport(): Promise<void> {
  if (driveSelected.value.size === 0 || driveBusy.value) return
  driveBusy.value = true
  driveError.value = ''
  try {
    const r = await docs.driveImport([...driveSelected.value], driveTargetFolder.value || null)
    if (!r.ok) {
      driveError.value = r.error.message
      return
    }
    if (r.imported.length > 0) {
      toast.show(`${r.imported.length} 件を取込みました${r.failed.length > 0 ? `（${r.failed.length} 件は失敗）` : ''}`)
    }
    if (r.failed.length > 0) {
      driveError.value = r.failed.map(f => `${f.name}: ${f.reason}`).join(' / ')
      // 失敗分を選択に残し、成功分だけ選択解除する（再試行しやすく）
      const failedIds = new Set(r.failed.map(f => f.fileId))
      driveSelected.value = new Set([...driveSelected.value].filter(id => failedIds.has(id)))
      return
    }
    driveOpen.value = false
  } finally {
    driveBusy.value = false
  }
}

/** ドライブのサイズ表示 */
function driveSize(f: DriveFile): string {
  if (f.sizeBytes === null) return '—'
  const kb = f.sizeBytes / 1024
  return kb >= 1000 ? `${(kb / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(kb))}KB`
}

// ---------- 新規フォルダ ----------
const folderModalOpen = ref(false)
const folderForm = reactive({ name: '', parentId: '' })
const folderError = ref('')

function openFolderModal(): void {
  folderForm.name = ''
  folderForm.parentId = selectedFolderId.value ?? ''
  folderError.value = ''
  folderModalOpen.value = true
}

async function doCreateFolder(): Promise<void> {
  const r = await docs.addFolder(folderForm.name, folderForm.parentId || null)
  if (!r.ok) {
    folderError.value = r.error.message
    return
  }
  folderModalOpen.value = false
  if (folderForm.parentId) {
    const next = new Set(expanded.value)
    next.add(folderForm.parentId)
    expanded.value = next
  }
  if (r.id) selectedFolderId.value = r.id
  toast.show('フォルダを作成しました')
}
</script>

<template>
  <div>
    <UiEmptyState
      v-if="!isEnabled('documents')"
      icon="FolderOpen"
      title="ドキュメント管理は無効化されています"
      hint="設定 > 機能トグル で有効にできます"
    >
      <template #action>
        <NuxtLink to="/support" class="btn btn-sm">業務支援ツールへ戻る</NuxtLink>
      </template>
    </UiEmptyState>

    <template v-else>
      <UiPageHeader title="ドキュメント管理" description="社内文書のフォルダ・タグ・検索。取込済みファイルはチャットボット等の AI 参照対象になります">
        <template #actions>
          <button type="button" class="btn btn-sm" @click="openFolderModal">
            <FolderPlus class="h-3.5 w-3.5" aria-hidden="true" />
            新規フォルダ
          </button>
          <button v-if="docs.isApi" type="button" class="btn btn-sm" @click="openDrive">
            <CloudDownload class="h-3.5 w-3.5" aria-hidden="true" />
            ドライブから取込
          </button>
          <button type="button" class="btn btn-primary btn-sm" @click="openUpload">
            <Upload class="h-3.5 w-3.5" aria-hidden="true" />
            アップロード
          </button>
        </template>
      </UiPageHeader>

      <!-- モバイル: フォルダを横並びチップ化 -->
      <div class="mb-2 flex gap-1.5 overflow-x-auto pb-1 scroll-slim md:hidden" role="group" aria-label="フォルダ選択">
        <button
          type="button"
          class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
          :class="selectedFolderId === null ? 'border-brand bg-brand-soft text-brand' : 'border-line-strong bg-surface text-sub'"
          @click="selectedFolderId = null"
        >
          すべて
        </button>
        <button
          v-for="row in docs.folderRows.value"
          :key="row.folder.id"
          type="button"
          class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
          :class="selectedFolderId === row.folder.id ? 'border-brand bg-brand-soft text-brand' : 'border-line-strong bg-surface text-sub'"
          @click="selectedFolderId = row.folder.id"
        >
          {{ row.depth > 0 ? '└ ' : '' }}{{ row.folder.name }}
          <span class="num text-[10px] text-muted">{{ row.fileCount }}</span>
        </button>
      </div>

      <div class="grid gap-3 md:grid-cols-[230px_1fr]">
        <!-- PC: フォルダツリー -->
        <aside class="card hidden self-start p-2 md:block" aria-label="フォルダツリー">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium transition-colors"
            :class="selectedFolderId === null ? 'bg-brand-soft text-brand' : 'text-sub hover:bg-surface-soft'"
            @click="selectedFolderId = null"
          >
            <FolderOpen class="h-4 w-4 shrink-0" aria-hidden="true" />
            <span class="flex-1">すべて</span>
            <span class="num text-[11px] text-muted">{{ docs.activeFiles.value.length }}</span>
          </button>
          <div
            v-for="row in visibleFolderRows"
            :key="row.folder.id"
            class="flex items-center"
            :style="{ paddingLeft: `${row.depth * 14}px` }"
          >
            <button
              v-if="row.hasChildren"
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sub transition-colors hover:bg-surface-soft"
              :aria-label="expanded.has(row.folder.id) ? `${row.folder.name} を閉じる` : `${row.folder.name} を開く`"
              :aria-expanded="expanded.has(row.folder.id)"
              @click.stop="toggleExpand(row.folder.id)"
            >
              <ChevronDown v-if="expanded.has(row.folder.id)" class="h-3.5 w-3.5" aria-hidden="true" />
              <ChevronRight v-else class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <span v-else class="w-6 shrink-0" aria-hidden="true" />
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium transition-colors"
              :class="selectedFolderId === row.folder.id ? 'bg-brand-soft text-brand' : 'text-sub hover:bg-surface-soft'"
              @click="selectedFolderId = row.folder.id"
            >
              <Folder class="h-4 w-4 shrink-0" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{{ row.folder.name }}</span>
              <span class="num text-[11px] text-muted">{{ row.fileCount }}</span>
            </button>
          </div>
        </aside>

        <!-- ファイル一覧 -->
        <section>
          <UiFilterBar>
            <UiSearchInput v-model="query" placeholder="名前・タグ・概要で検索" />
            <UiChipSelect v-model="tagFilter" :options="tagOptions" aria-label="タグで絞り込み" />
            <template #trailing>
              <span class="num text-[11px] text-muted">{{ fileRows.length }} 件</span>
            </template>
          </UiFilterBar>
          <p v-if="searching" class="mb-1.5 text-[11px] text-muted">検索中は全フォルダを対象に表示しています</p>
          <p v-else-if="selectedFolderId" class="mb-1.5 text-[11px] text-muted">{{ docs.folderPath(selectedFolderId) }}</p>

          <UiDataTable
            :columns="columns"
            :rows="tableRows"
            clickable
            empty-title="ファイルがありません"
            :empty-hint="docs.isApi ? 'アップロード・ドライブから取込 で追加できます' : 'アップロード（モック）から追加できます'"
            @row-click="openPreview"
          >
            <template #cell-name="{ row }">
              <span class="flex items-center gap-1.5">
                <FileText class="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                <span class="font-medium">{{ row.name }}</span>
              </span>
            </template>
            <template #cell-tags="{ row }">
              <span class="flex flex-wrap justify-end gap-1 md:justify-start">
                <UiStatusBadge
                  v-for="t in String(row.tags).split(' ').filter(Boolean)"
                  :key="t"
                  :label="t"
                  tone="neutral"
                />
              </span>
            </template>
          </UiDataTable>

          <!-- アーカイブ済み（取消フロー = 原則 9.5。復元できることを常に見える場所に置く） -->
          <div v-if="docs.archivedFiles.value.length > 0" class="mt-3">
            <button type="button" class="btn btn-ghost btn-sm" @click="showArchived = !showArchived">
              <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
              アーカイブ済み（{{ docs.archivedFiles.value.length }}）{{ showArchived ? 'を隠す' : 'を表示' }}
            </button>
            <ul v-if="showArchived" class="mt-1.5 grid gap-1">
              <li
                v-for="f in docs.archivedFiles.value"
                :key="f.id"
                class="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-soft px-3 py-1.5 text-[13px]"
              >
                <span class="min-w-0 flex-1 truncate text-sub">{{ f.name }}</span>
                <button type="button" class="btn btn-sm" @click="restoreDoc(f.id)">復元</button>
              </li>
            </ul>
          </div>
        </section>
      </div>

      <!-- プレビュードロワー -->
      <UiDrawer :open="selectedDoc !== null" :title="selectedDoc?.name ?? ''" width="520px" @close="selectedDoc = null">
        <template v-if="selectedDoc">
          <!-- プレビュー（概要 + 属性バッジ） -->
          <div class="rounded-lg border border-line bg-surface-soft p-4">
            <div class="mb-2 flex flex-wrap items-center gap-2">
              <FileText class="h-5 w-5 shrink-0 text-brand" aria-hidden="true" />
              <span class="min-w-0 text-[13px] font-bold">{{ selectedDoc.name }}</span>
              <UiStatusBadge v-if="selectedDoc.source === 'drive'" label="Drive 取込" tone="info" />
              <UiStatusBadge v-if="selectedDoc.hasText" label="AI 検索対象" tone="ok" />
            </div>
            <p class="text-[13px] leading-relaxed text-sub">{{ selectedDoc.summary || '概要は登録されていません' }}</p>
            <p v-if="!docs.isApi" class="mt-3 text-[10px] text-muted">※ モックのためファイル本体は保持していません（summary の擬似プレビュー）</p>
            <p v-else-if="selectedDoc.hasText" class="mt-3 text-[10px] text-muted">テキスト抽出済み: チャットボット等の AI が内容を参照し、必要に応じてこのファイルの URL を案内します</p>
          </div>

          <!-- メタ情報 -->
          <dl class="mt-3 grid grid-cols-[92px_1fr] gap-y-1.5 text-[13px]">
            <dt class="text-muted">フォルダ</dt>
            <dd>{{ docs.folderPath(selectedDoc.parentId) }}</dd>
            <dt class="text-muted">更新者</dt>
            <dd>{{ memberName(selectedDoc.updatedBy) }}</dd>
            <dt class="text-muted">更新日時</dt>
            <dd class="num">{{ fmtDateTime(selectedDoc.updatedAt) }}</dd>
            <dt class="text-muted">サイズ</dt>
            <dd class="num">{{ selectedDoc.size ?? '—' }}</dd>
            <template v-if="selectedDoc.driveWebLink">
              <dt class="text-muted">取込元</dt>
              <dd><a :href="selectedDoc.driveWebLink" target="_blank" rel="noopener" class="text-brand underline">Google ドライブで開く</a></dd>
            </template>
          </dl>

          <!-- 編集 -->
          <div class="mt-4 grid gap-3 border-t border-line pt-3">
            <UiFormField label="名称変更" required :error="editError">
              <input v-model="editForm.name" type="text" class="input" aria-label="ファイル名">
            </UiFormField>
            <UiFormField label="タグ">
              <UiChipSelect v-model="editForm.tags" :options="tagOptions" aria-label="タグ編集" />
            </UiFormField>
            <UiFormField label="概要">
              <textarea v-model="editForm.summary" class="textarea" rows="3" />
            </UiFormField>
          </div>
        </template>
        <template #footer>
          <div class="flex items-center justify-between gap-2">
            <button type="button" class="btn btn-danger btn-sm" @click="archiveDoc">アーカイブ</button>
            <div class="flex items-center gap-2">
              <button
                v-if="docs.isApi && selectedDoc?.downloadable"
                type="button"
                class="btn"
                :disabled="downloading"
                @click="doDownload"
              >
                <Download class="h-3.5 w-3.5" aria-hidden="true" />
                {{ downloading ? '準備中…' : 'ダウンロード' }}
              </button>
              <button type="button" class="btn btn-primary" @click="saveEdit">保存</button>
            </div>
          </div>
        </template>
      </UiDrawer>

      <!-- アップロードモーダル -->
      <UiModal :open="uploadOpen" :title="docs.isApi ? 'ファイルのアップロード' : 'アップロード（モック）'" @close="uploadOpen = false">
        <div class="grid gap-3">
          <UiFormField
            v-if="docs.isApi"
            label="ファイル"
            required
            :error="uploadError"
            hint="10MB まで。.md / .txt / .pdf / .docx / .pptx / .csv はテキスト抽出され AI の検索・参照対象になります（他形式は保管・ダウンロードのみ）"
          >
            <input type="file" class="input" aria-label="アップロードするファイル" @change="onFilePick">
          </UiFormField>
          <UiFormField v-else label="ファイル名" required :error="uploadError" hint="拡張子を含めて入力（例: 会議資料.pdf）">
            <input v-model="uploadForm.name" type="text" class="input" placeholder="例: 会議資料.pdf">
          </UiFormField>
          <UiFormField label="フォルダ" required>
            <select v-model="uploadForm.parentId" class="select" aria-label="フォルダ">
              <option v-for="o in folderOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </UiFormField>
          <UiFormField label="タグ">
            <UiChipSelect v-model="uploadForm.tags" :options="tagOptions" aria-label="タグ" />
          </UiFormField>
          <UiFormField label="概要" hint="検索対象になります">
            <textarea v-model="uploadForm.summary" class="textarea" rows="3" />
          </UiFormField>
        </div>
        <template #footer>
          <button type="button" class="btn" :disabled="uploading" @click="uploadOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" :disabled="uploading" @click="doUpload">
            {{ uploading ? 'アップロード中…' : 'アップロード' }}
          </button>
        </template>
      </UiModal>

      <!-- Google ドライブ取込モーダル（API モード） -->
      <UiModal :open="driveOpen" title="Google ドライブから取込" width="640px" @close="driveOpen = false">
        <div v-if="driveState === null" class="py-6 text-center text-[13px] text-muted">連携状態を確認しています…</div>
        <div v-else-if="!driveState.available" class="py-4 text-[13px] text-sub">
          Google 連携が未設定の環境です（管理者にお問い合わせください）
        </div>
        <div v-else-if="!driveState.connected || !driveState.driveScope" class="grid gap-2 py-2 text-[13px] text-sub">
          <p>
            Google ドライブ連携が未接続です。
            <NuxtLink to="/ai-assistant" class="text-brand underline">AI アシスタントのカレンダー連携</NuxtLink>
            から Google に{{ driveState.connected ? '再接続' : '接続' }}してください（ドライブ読取の許可が追加されます）
          </p>
        </div>
        <div v-else class="grid gap-2">
          <div class="flex gap-2">
            <UiSearchInput v-model="driveQuery" placeholder="ドライブ内をファイル名で検索" class="flex-1" @keydown.enter="doDriveSearch" />
            <button type="button" class="btn btn-sm" :disabled="driveBusy" @click="doDriveSearch">検索</button>
          </div>
          <p v-if="driveError" class="text-[12px] text-crit">{{ driveError }}</p>
          <div class="max-h-64 overflow-auto rounded-lg border border-line">
            <p v-if="driveBusy && driveResults.length === 0" class="p-3 text-[12px] text-muted">読み込み中…</p>
            <p v-else-if="driveResults.length === 0" class="p-3 text-[12px] text-muted">該当するファイルがありません</p>
            <label
              v-for="f in driveResults"
              :key="f.id"
              class="flex cursor-pointer items-center gap-2 border-b border-line px-3 py-2 text-[13px] last:border-b-0 hover:bg-surface-soft"
            >
              <input
                type="checkbox"
                class="checkbox"
                :checked="driveSelected.has(f.id)"
                :disabled="!f.exportable"
                @change="toggleDriveFile(f.id)"
              >
              <span class="min-w-0 flex-1 truncate" :class="f.exportable ? '' : 'text-muted'">{{ f.name }}</span>
              <span class="num shrink-0 text-[11px] text-muted">{{ driveSize(f) }}</span>
              <span v-if="!f.exportable" class="shrink-0 text-[10px] text-muted">非対応形式</span>
            </label>
          </div>
          <UiFormField label="取込先フォルダ">
            <select v-model="driveTargetFolder" class="select" aria-label="取込先フォルダ">
              <option value="">（ルート直下）</option>
              <option v-for="o in folderOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </UiFormField>
          <p class="text-[11px] text-muted">
            選択したファイルをコピーして保管します（1 回 10 件・各 10MB まで。Google ドキュメント/スプレッドシート/スライドは
            docx / csv / pptx に変換）。取込後はテキスト抽出され AI の検索・参照対象になります
          </p>
        </div>
        <template #footer>
          <button type="button" class="btn" :disabled="driveBusy" @click="driveOpen = false">閉じる</button>
          <button
            v-if="driveState?.connected && driveState?.driveScope"
            type="button"
            class="btn btn-primary"
            :disabled="driveBusy || driveSelected.size === 0"
            @click="doDriveImport"
          >
            {{ driveBusy ? '取込中…' : `取込む（${driveSelected.size}）` }}
          </button>
        </template>
      </UiModal>

      <!-- 新規フォルダモーダル -->
      <UiModal :open="folderModalOpen" title="新規フォルダ" @close="folderModalOpen = false">
        <div class="grid gap-3">
          <UiFormField label="フォルダ名" required :error="folderError">
            <input v-model="folderForm.name" type="text" class="input" placeholder="例: 契約書">
          </UiFormField>
          <UiFormField label="親フォルダ">
            <select v-model="folderForm.parentId" class="select" aria-label="親フォルダ">
              <option value="">（ルート直下）</option>
              <option v-for="o in folderOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </UiFormField>
        </div>
        <template #footer>
          <button type="button" class="btn" @click="folderModalOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" @click="doCreateFolder">作成</button>
        </template>
      </UiModal>
    </template>
  </div>
</template>
