<script setup lang="ts">
/**
 * 祝日マスタ（管理者専用。オペレーター報告 2026-07-18 #4）
 * - SoT: public_holidays（API モード）。内閣府「国民の祝日」CSV の公式取込 + 手動追加・削除
 * - 翌営業日の計算（AI業務アシスタントの計画対象日・日報の明日の予定）と
 *   カレンダー表示（対象日の祝日名バッジ）に反映される
 * - 公式取込は再実行可能（date 一意の upsert = 冪等）。今後の祝日改定もボタン一つで反映できる
 */
import { CloudDownload, FileUp, Plus, Trash2 } from 'lucide-vue-next'
import type { Holiday } from '~/types/domain'
import type { FieldDef, TableColumn } from '~/types/ui'

const crud = useMasterCrudAsync('holidays', 'hd')
const toast = useToast()
const confirm = useConfirm()
const isApi = useApiMode()

// ---------- 一覧（年フィルタ + 名称検索） ----------

const search = ref('')
const yearFilter = ref(String(new Date().getFullYear()))

const years = computed(() => {
  const ys = [...new Set((crud.list.value as Holiday[]).map(h => h.date.slice(0, 4)))].sort()
  return [{ value: '', label: 'すべての年' }, ...ys.map(y => ({ value: y, label: `${y}年` }))]
})

const filtered = computed(() =>
  (crud.list.value as Holiday[])
    .filter((h) => {
      if (yearFilter.value && h.date.slice(0, 4) !== yearFilter.value) return false
      const q = search.value.trim().toLowerCase()
      return !q || h.name.toLowerCase().includes(q)
    })
    .sort((a, b) => a.date.localeCompare(b.date)),
)

const tableRows = computed(() => filtered.value as unknown as Record<string, unknown>[])

const columns: TableColumn[] = [
  { key: 'date', label: '日付', primary: true, width: '130px' },
  { key: 'name', label: '名称', primary: true },
  { key: 'source', label: '登録元', width: '90px' },
  { key: 'ops', label: '操作', width: '70px', primary: true },
]

/** 年フィルタで 0 件でも他年にデータがある場合は案内を変える（空状態の誤解防止） */
const emptyDescription = computed(() =>
  crud.list.value.length > 0 && yearFilter.value
    ? `${yearFilter.value}年の祝日はありません（年フィルタを「すべての年」にすると他の年を確認できます）`
    : '「公式データから更新」で内閣府の祝日データを取り込めます')

function asHoliday(row: Record<string, unknown>): Holiday {
  return row as unknown as Holiday
}

// ---------- 公式取込（内閣府 CSV）+ ファイルアップロード取込 ----------

const importing = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

async function runImport(body: Record<string, unknown>, sourceLabel: string): Promise<void> {
  importing.value = true
  try {
    const res = await apiFetch<{ total: number; upserted: number }>('/v1/holidays/import', { method: 'POST', body })
    await loadApiCollection('holidays', true)
    toast.show(`${sourceLabel}を取り込みました（${res.total} 件中 ${res.upserted} 件を追加・更新）`)
  } catch (e) {
    const er = apiErrorOf(e)
    toast.show(`${er.code}: ${er.message}`, 'crit')
  } finally {
    importing.value = false
  }
}

async function importOfficial(): Promise<void> {
  const ok = await confirm.ask(
    '公式データから更新',
    '内閣府の「国民の祝日」CSV を取得して反映します（既存の祝日は日付単位で上書き・追加のみ。削除はされません）。実行しますか？',
    { confirmLabel: '取り込む' },
  )
  if (!ok) return
  await runImport({}, '公式データ')
}

/** 公式サイト障害時の代替経路: 手元の CSV（Shift_JIS / UTF-8 自動判定）をアップロードして取込 */
async function onCsvFileSelected(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (fileInput.value) fileInput.value.value = '' // 同じファイルの再選択を可能にする
  if (!file) return
  const buf = new Uint8Array(await file.arrayBuffer())
  let base64 = ''
  for (let i = 0; i < buf.length; i += 0x8000) {
    base64 += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  }
  await runImport({ csvBase64: btoa(base64) }, `CSV ファイル（${file.name}）`)
}

// ---------- 手動追加・削除 ----------

const drawerOpen = ref(false)
const form = ref<Record<string, unknown>>({})
const errors = ref<Record<string, string>>({})

const formFields: FieldDef[] = [
  { key: 'date', label: '日付', type: 'date', required: true },
  { key: 'name', label: '名称', type: 'text', required: true, placeholder: '例）創立記念日' },
]

function openCreate(): void {
  form.value = { date: '', name: '' }
  errors.value = {}
  drawerOpen.value = true
}

async function save(): Promise<void> {
  const e: Record<string, string> = {}
  if (!String(form.value.date ?? '')) e.date = '日付を入力してください'
  if (!String(form.value.name ?? '').trim()) e.name = '名称を入力してください'
  // 日付の一意はサーバー側 UNIQUE が SoT（409）。モックモードでも同じ制約を再現する
  if ((crud.list.value as Holiday[]).some(h => h.date === String(form.value.date))) {
    e.date = 'この日付は既に登録されています'
  }
  errors.value = e
  if (Object.keys(e).length > 0) return
  const res = await crud.save({
    date: String(form.value.date),
    name: String(form.value.name).trim(),
    source: 'manual',
  } as Partial<Holiday>)
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show('祝日を追加しました（翌営業日の計算に反映されます）')
  drawerOpen.value = false
}

async function removeHoliday(h: Holiday): Promise<void> {
  const ok = await confirm.ask(
    '祝日の削除',
    `「${h.date} ${h.name}」を削除しますか？（翌営業日の計算から除外されます）`,
    { danger: true, confirmLabel: '削除' },
  )
  if (!ok) return
  const res = await crud.remove(h.id)
  if (res.ok) toast.show('削除しました', 'warn')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}
</script>

<template>
  <MastersMasterShell
    title="祝日マスタ"
    description="翌営業日の計算（AI業務アシスタント・日報）とカレンダー表示に反映されます。営業曜日・祝日の扱いは勤怠ルール（/attendance の設定タブ）で勤務体系ごとに制御できます"
  >
    <template #actions>
      <button
        v-if="isApi"
        type="button"
        class="btn"
        :disabled="importing"
        @click="importOfficial"
      >
        <CloudDownload class="h-4 w-4" aria-hidden="true" />
        {{ importing ? '取込中…' : '公式データから更新' }}
      </button>
      <button
        v-if="isApi"
        type="button"
        class="btn"
        :disabled="importing"
        title="公式サイトに接続できない場合の代替: 手元の祝日 CSV（日付,名称）を取り込みます"
        @click="fileInput?.click()"
      >
        <FileUp class="h-4 w-4" aria-hidden="true" />
        CSV から取込
      </button>
      <input ref="fileInput" type="file" accept=".csv,text/csv" class="hidden" @change="onCsvFileSelected" >
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        手動追加
      </button>
    </template>

    <template #filter>
      <UiSearchInput v-model="search" placeholder="名称で検索" />
      <UiSelect v-model="yearFilter" :options="years" aria-label="年フィルタ" />
    </template>

    <UiSectionCard :title="`祝日一覧（${filtered.length}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        empty-title="祝日が登録されていません"
        :empty-description="emptyDescription"
      >
        <template #cell-date="{ row }">
          <span class="num font-medium">{{ asHoliday(row).date }}</span>
        </template>
        <template #cell-source="{ row }">
          <UiStatusBadge
            :label="asHoliday(row).source === 'official' ? '公式' : '手動'"
            :tone="asHoliday(row).source === 'official' ? 'ok' : 'neutral'"
          />
        </template>
        <template #cell-ops="{ row }">
          <button
            type="button"
            class="btn btn-sm"
            :aria-label="`${asHoliday(row).date} を削除`"
            @click.stop="removeHoliday(asHoliday(row))"
          >
            <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </template>
      </UiDataTable>
    </UiSectionCard>

    <template #drawer>
      <UiDrawer :open="drawerOpen" title="祝日を手動追加" @close="drawerOpen = false">
        <UiSchemaForm v-model="form" :fields="formFields" :errors="errors" />
        <template #footer>
          <div class="flex items-center justify-end gap-2">
            <button type="button" class="btn" @click="drawerOpen = false">キャンセル</button>
            <button type="button" class="btn btn-primary" @click="save">保存</button>
          </div>
        </template>
      </UiDrawer>
    </template>
  </MastersMasterShell>
</template>
