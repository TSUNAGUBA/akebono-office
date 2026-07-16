<script setup lang="ts">
/**
 * F-09-3 ドキュメント管理: 左フォルダツリー + 右一覧（検索・タグ・アップロードモック・プレビュードロワー）
 * モバイルはツリーを横並びチップに切替。検索時はツリー選択を無視して全体検索。
 */
import { ChevronDown, ChevronRight, FileText, Folder, FolderPlus, FolderOpen, Upload } from 'lucide-vue-next'
import type { DocumentNode } from '~/types/domain'
import type { TableColumn } from '~/types/ui'
import { fmtDateLong, fmtDateTime } from '~/utils/format'

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

function saveEdit(): void {
  if (!selectedDoc.value) return
  const r = docs.updateFile(selectedDoc.value.id, {
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
  const ok = await confirm.ask('アーカイブ', `「${selectedDoc.value.name}」をアーカイブ（無効化）します。一覧に表示されなくなります。`, { danger: true, confirmLabel: 'アーカイブ' })
  if (!ok) return
  const r = docs.archive(selectedDoc.value.id)
  if (r.ok) {
    toast.show('アーカイブしました')
    selectedDoc.value = null
  } else {
    toast.show(r.error.message, 'crit')
  }
}

// ---------- アップロード（モック） ----------
const uploadOpen = ref(false)
const uploadForm = reactive({ name: '', parentId: '', tags: [] as string[], summary: '' })
const uploadError = ref('')

function openUpload(): void {
  uploadForm.name = ''
  uploadForm.parentId = selectedFolderId.value ?? (docs.folderRows.value[0]?.folder.id ?? '')
  uploadForm.tags = []
  uploadForm.summary = ''
  uploadError.value = ''
  uploadOpen.value = true
}

function doUpload(): void {
  const r = docs.addFile({
    name: uploadForm.name,
    parentId: uploadForm.parentId || null,
    tags: uploadForm.tags,
    summary: uploadForm.summary,
  })
  if (!r.ok) {
    uploadError.value = r.error.message
    return
  }
  uploadOpen.value = false
  query.value = ''
  selectedFolderId.value = uploadForm.parentId || null
  toast.show('アップロードしました（モック）')
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

function doCreateFolder(): void {
  const r = docs.addFolder(folderForm.name, folderForm.parentId || null)
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
      <UiPageHeader title="ドキュメント管理" description="社内文書のフォルダ・タグ・検索">
        <template #actions>
          <button type="button" class="btn btn-sm" @click="openFolderModal">
            <FolderPlus class="h-3.5 w-3.5" aria-hidden="true" />
            新規フォルダ
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
            empty-hint="アップロード（モック）から追加できます"
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
        </section>
      </div>

      <!-- プレビュードロワー -->
      <UiDrawer :open="selectedDoc !== null" :title="selectedDoc?.name ?? ''" width="520px" @close="selectedDoc = null">
        <template v-if="selectedDoc">
          <!-- 擬似プレビュー -->
          <div class="rounded-lg border border-line bg-surface-soft p-4">
            <div class="mb-2 flex items-center gap-2">
              <FileText class="h-5 w-5 text-brand" aria-hidden="true" />
              <span class="text-[13px] font-bold">{{ selectedDoc.name }}</span>
            </div>
            <p class="text-[13px] leading-relaxed text-sub">{{ selectedDoc.summary || '概要は登録されていません' }}</p>
            <p class="mt-3 text-[10px] text-muted">※ モックのためファイル本体は保持していません（summary の擬似プレビュー）</p>
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
            <button type="button" class="btn btn-primary" @click="saveEdit">保存</button>
          </div>
        </template>
      </UiDrawer>

      <!-- アップロードモーダル -->
      <UiModal :open="uploadOpen" title="アップロード（モック）" @close="uploadOpen = false">
        <div class="grid gap-3">
          <UiFormField label="ファイル名" required :error="uploadError" hint="拡張子を含めて入力（例: 会議資料.pdf）">
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
          <button type="button" class="btn" @click="uploadOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" @click="doUpload">アップロード</button>
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
