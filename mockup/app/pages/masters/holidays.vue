<script setup lang="ts">
/**
 * 祝日マスタ（管理者専用。オペレーター報告 2026-07-18 #4）
 * - SoT: public_holidays（API モード）。内閣府「国民の祝日」CSV の公式取込 + 手動追加・削除
 * - 翌営業日の計算（AI業務アシスタントの計画対象日・日報の明日の予定）と
 *   カレンダー表示（対象日の祝日名バッジ）に反映される
 * - 公式取込は再実行可能（date 一意の upsert = 冪等）。今後の祝日改定もボタン一つで反映できる
 */
import { CloudDownload, Plus } from 'lucide-vue-next'
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
]

function asHoliday(row: Record<string, unknown>): Holiday {
  return row as unknown as Holiday
}

// ---------- 公式取込（内閣府 CSV） ----------

const importing = ref(false)

async function importOfficial(): Promise<void> {
  const ok = await confirm.ask(
    '公式データから更新',
    '内閣府の「国民の祝日」CSV を取得して反映します（既存の祝日は日付単位で上書き・追加のみ。削除はされません）。実行しますか？',
    { confirmLabel: '取り込む' },
  )
  if (!ok) return
  importing.value = true
  try {
    const res = await apiFetch<{ total: number; upserted: number }>('/v1/holidays/import', { method: 'POST', body: {} })
    await loadApiCollection('holidays', true)
    toast.show(`公式データを取り込みました（${res.total} 件中 ${res.upserted} 件を追加・更新）`)
  } catch (e) {
    const er = apiErrorOf(e)
    toast.show(`${er.code}: ${er.message}`, 'crit')
  } finally {
    importing.value = false
  }
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

async function removeRow(row: Record<string, unknown>): Promise<void> {
  const h = asHoliday(row)
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
        clickable
        empty-title="祝日が登録されていません"
        empty-description="「公式データから更新」で内閣府の祝日データを取り込めます"
        @row-click="removeRow"
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
