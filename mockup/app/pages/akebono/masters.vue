<script setup lang="ts">
/**
 * F-30 共通マスタ管理（管理者専用）
 * 9 マスタ（事業セグメント・倉庫・商品カテゴリ・画像セクション・軸テンプレート・
 * 単位・税区分・回収支払条件・委託条件）をタブで切替。CRUD は useAkebonoMasters に集約し、
 * 本ページは薄い表示層に徹する（原則3）。書込は cruds[key].save/archive/restore のみ。
 */
import { Plus } from 'lucide-vue-next'
import {
  AKEBONO_MASTER_COLUMNS, consignmentSummary,
  type AkebonoMasterKey,
} from '~/composables/useAkebonoMasters'
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'
import type { ConsignmentTerm, WarehouseKind } from '~/types/akebono'
import type { FieldDef } from '~/types/ui'
import { fmtPct } from '~/utils/format'

const m = useAkebonoMasters()
const toast = useToast()
const confirm = useConfirm()

// ---------- CRUD の緩い型（動的タブキーで union を跨ぐため） ----------
interface CrudResult { ok: boolean; id?: string; error?: { code: string; message: string } }
type Row = Record<string, unknown>
interface LooseCrud {
  list: { value: Row[] }
  byId: (id: string) => Row | undefined
  save: (e: Row & { id?: string }) => CrudResult
  archive: (id: string) => CrudResult
  restore: (id: string) => CrudResult
}

// ---------- タブ ----------
const activeTab = ref<AkebonoMasterKey>(m.meta[0]!.key)
const tabs = computed(() => m.meta.map(x => ({ key: x.key, label: x.label })))
const currentMeta = computed(() => m.meta.find(x => x.key === activeTab.value)!)
const currentCrud = computed(() => m.cruds[activeTab.value] as unknown as LooseCrud)
const columns = computed(() => AKEBONO_MASTER_COLUMNS[activeTab.value])
const fields = computed<FieldDef[]>(() => m.fieldsFor(activeTab.value))
const rows = computed<Row[]>(() => currentCrud.value.list.value)

const WAREHOUSE_KIND_LABELS: Record<WarehouseKind, string> = {
  own: '自社倉庫',
  store_deposit: '店舗預け',
  external: '外部委託',
}
const PERCENT_KEYS = new Set(['rate', 'marginRate', 'payoutRate'])

// ---------- ドロワー / フォーム ----------
const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<Row | undefined>(() =>
  selectedId.value ? currentCrud.value.byId(selectedId.value) : undefined,
)
const form = ref<Row>({})
const errors = ref<Record<string, string>>({})

const drawerTitle = computed(() =>
  mode.value === 'create'
    ? `${currentMeta.value.label}を追加`
    : mode.value === 'edit'
      ? `${currentMeta.value.label}を編集`
      : `${currentMeta.value.label}詳細`,
)

/** 一覧・見出し用の行ラベル（委託条件は name を持たないため合成） */
function rowLabel(row: Row | undefined): string {
  if (!row) return '—'
  if (activeTab.value === 'consignmentTerms') {
    const role = row.role === 'store' ? '店舗' : '作家'
    return `${m.companyName(row.companyId as string)}（${role}）`
  }
  return (row.name as string) || '—'
}

/** 既定シード（画像セクション）は無効化できない */
const isSeedLocked = computed(() =>
  activeTab.value === 'productImageSections' && selected.value?.isSeed === true,
)

/** 詳細 dl 用の値整形（フォーム定義の options を再利用して名称解決） */
function formatDetail(field: FieldDef, value: unknown): string {
  if (value == null || value === '') return '—'
  if (field.type === 'boolean') return value === true ? 'あり' : 'なし'
  if (field.type === 'multiselect') {
    const arr = Array.isArray(value) ? value : []
    if (arr.length === 0) return '—'
    return arr.map(v => field.options?.find(o => o.value === v)?.label ?? String(v)).join('、')
  }
  if (field.options) return field.options.find(o => o.value === value)?.label ?? String(value)
  if (PERCENT_KEYS.has(field.key)) return fmtPct(Number(value), 0)
  return String(value)
}

const detailRows = computed(() => {
  const s = selected.value
  if (!s) return []
  const list = fields.value.map(f => ({ label: f.label, value: formatDetail(f, s[f.key]) }))
  list.push({ label: '状態', value: s.active === false ? '無効' : '有効' })
  return list
})

// ---------- 操作 ----------
function openDetail(row: Row): void {
  selectedId.value = String(row.id)
  mode.value = 'view'
  drawerOpen.value = true
}

function openCreate(): void {
  selectedId.value = null
  form.value = {}
  errors.value = {}
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  if (!selected.value) return
  form.value = JSON.parse(JSON.stringify(selected.value)) as Row
  errors.value = {}
  mode.value = 'edit'
}

function cancelForm(): void {
  if (mode.value === 'edit' && selectedId.value) mode.value = 'view'
  else drawerOpen.value = false
}

function save(): void {
  const e: Record<string, string> = {}
  for (const f of fields.value) {
    if (!f.required) continue
    const v = form.value[f.key]
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) e[f.key] = `${f.label}は必須です`
  }
  errors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('AKO-GEN-001: 必須項目を入力してください', 'crit')
    return
  }
  const payload = m.coerce(activeTab.value, form.value) as Row & { id?: string }
  if (mode.value === 'edit' && selectedId.value) payload.id = selectedId.value
  const res = currentCrud.value.save(payload)
  if (!res.ok) {
    toast.show(`${res.error?.code}: ${res.error?.message}`, 'crit')
    return
  }
  toast.show(mode.value === 'create' ? `${currentMeta.value.label}を追加しました` : `${currentMeta.value.label}を更新しました`)
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
}

async function archiveSelected(): Promise<void> {
  const s = selected.value
  if (!s) return
  const ok = await confirm.ask(
    '無効化',
    `「${rowLabel(s)}」を無効化しますか？（論理削除。あとから復元できます）`,
    { danger: true, confirmLabel: '無効化' },
  )
  if (!ok) return
  const res = currentCrud.value.archive(String(s.id))
  if (res.ok) toast.show('無効化しました', 'warn')
  else toast.show(`${res.error?.code}: ${res.error?.message}`, 'crit')
}

function restoreSelected(): void {
  const s = selected.value
  if (!s) return
  const res = currentCrud.value.restore(String(s.id))
  if (res.ok) toast.show('復元しました')
  else toast.show(`${res.error?.code}: ${res.error?.message}`, 'crit')
}

// タブ切替時は選択・フォームをリセット
watch(activeTab, () => {
  drawerOpen.value = false
  mode.value = 'view'
  selectedId.value = null
  form.value = {}
  errors.value = {}
})

// 型ヘルパー（テンプレートのセル描画用）
function asTerm(row: Row): ConsignmentTerm {
  return row as unknown as ConsignmentTerm
}
</script>

<template>
  <MastersMasterShell
    title="共通マスタ管理"
    description="Akebono 業務アプリ群の共通マスタ（セグメント・倉庫・税区分・委託条件 等）を一元管理します。編集は管理者のみ。"
  >
    <template #actions>
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        追加
      </button>
    </template>

    <UiTabBar v-model="activeTab" :tabs="tabs" />

    <UiSectionCard :title="`${currentMeta.label}（${rows.length}件）`" :description="currentMeta.description" flush>
      <UiDataTable
        :columns="columns"
        :rows="rows"
        clickable
        :empty-title="`${currentMeta.label}がまだありません`"
        empty-hint="右上の「追加」から登録できます"
        @row-click="openDetail"
      >
        <template #cell-name="{ row }">
          <span class="font-medium">{{ (row.name as string) || '—' }}</span>
        </template>
        <template #cell-industryType="{ value }">
          {{ INDUSTRY_TYPE_LABELS[value as keyof typeof INDUSTRY_TYPE_LABELS] ?? '—' }}
        </template>
        <template #cell-kind="{ value }">
          {{ WAREHOUSE_KIND_LABELS[value as WarehouseKind] ?? '—' }}
        </template>
        <template #cell-rate="{ value }">
          <span class="num">{{ value == null ? '—' : fmtPct(Number(value), 0) }}</span>
        </template>
        <template #cell-companyId="{ value }">
          {{ m.companyName(value as string) }}
        </template>
        <template #cell-role="{ value }">
          {{ value === 'store' ? '店舗' : '作家' }}
        </template>
        <template #cell-detail="{ row }">
          {{ consignmentSummary(asTerm(row)) }}
        </template>
        <template #cell-axes="{ row }">
          {{ (row.axis1Label as string) || '—' }} × {{ (row.axis2Label as string) || '—' }}
        </template>
        <template #cell-parentId="{ value }">
          {{ value ? m.categoryName(value as string) : '（トップレベル）' }}
        </template>
        <template #cell-isThumbnailPriority="{ value }">
          <UiStatusBadge v-if="value === true" label="優先" tone="brand" />
          <span v-else class="text-muted">—</span>
        </template>
        <template #cell-active="{ value }">
          <UiStatusBadge :label="value === false ? '無効' : '有効'" :tone="value === false ? 'neutral' : 'ok'" dot />
        </template>
      </UiDataTable>
    </UiSectionCard>

    <template #drawer>
      <UiDrawer :open="drawerOpen" :title="drawerTitle" @close="drawerOpen = false">
        <dl v-if="mode === 'view' && selected" class="grid gap-2 text-[13px]">
          <div class="pb-1 text-[15px] font-bold">{{ rowLabel(selected) }}</div>
          <div
            v-for="r in detailRows"
            :key="r.label"
            class="grid grid-cols-[130px_1fr] gap-2 border-b border-line pb-2 last:border-0"
          >
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">{{ r.label }}</dt>
            <dd>{{ r.value }}</dd>
          </div>
        </dl>
        <UiSchemaForm v-else v-model="form" :fields="fields" :errors="errors" />

        <template #footer>
          <div v-if="mode === 'view' && selected" class="flex items-center justify-between gap-2">
            <div>
              <button
                v-if="selected.active !== false && !isSeedLocked"
                type="button"
                class="btn btn-danger btn-sm"
                @click="archiveSelected"
              >
                無効化
              </button>
              <button
                v-else-if="selected.active === false"
                type="button"
                class="btn btn-sm"
                @click="restoreSelected"
              >
                復元
              </button>
              <span v-else-if="isSeedLocked" class="text-[11px] text-muted">既定セクション（無効化不可・名称変更のみ可）</span>
            </div>
            <button type="button" class="btn btn-primary" @click="openEdit">編集</button>
          </div>
          <div v-else class="flex items-center justify-end gap-2">
            <button type="button" class="btn" @click="cancelForm">キャンセル</button>
            <button type="button" class="btn btn-primary" @click="save">保存</button>
          </div>
        </template>
      </UiDrawer>
    </template>
  </MastersMasterShell>
</template>
