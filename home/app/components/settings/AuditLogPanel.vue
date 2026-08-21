<script setup lang="ts">
/**
 * 監査ログパネル（設定 > 監査ログタブ。改修 2026-08-21）。
 * 表示・フィルタの語彙（action / entity → ラベル・操作対象ページ）の SoT = shared/domain/audit-log（原則6）。
 *
 * デュアルモード:
 * - モック = tbl('auditLogs') を整形した computed（クライアントページング + filterPredicate）。
 *   モックの記録は useMasterCrud 経由のマスタ・設定操作が中心（entity はコレクション名 = camelCase のため
 *   normalizeAuditEntity で読替えて同じカタログ・同じフィルタが効く）
 * - API = GET /v1/configs/audit-logs のサーバーページング（apiFetchList + filterParams）。
 *   f.page はサーバー側で shared カタログの entity 集合へ展開される（両モードで同一 SoT を参照）
 * 読み取り専用（操作列なし）。監査ログは追記のみの記録系のため取消フローは持たない（原則9.5 対象外）
 */
import { RotateCcw } from 'lucide-vue-next'
import {
  AUDIT_ACTION_META, AUDIT_ENTITY_META, AUDIT_PAGE_OTHER, type AuditLogRow,
  auditActionLabel, auditEntityMeta, auditPageName, auditPageOptions, normalizeAuditEntity,
} from '../../../../shared/domain/audit-log'
import type { Member } from '~/types/domain'
import type { TableColumn } from '~/types/ui'
import { fmtDateTimeSec } from '~/utils/format'

const apiMode = useApiMode()
const { tbl } = useMockDb()
const members = tbl('members')

/** actorId → メンバー名（未知 id は生値のまま = ジョブ実行者 'system' 等も表示が壊れない） */
function memberName(id: string): string {
  return (members.value as Member[]).find(m => m.id === id)?.name ?? id
}

// ---------- フィルタ（操作日時 / ユーザー / ページ / データ / 内容） ----------

const atFrom = ref('')
const atTo = ref('')
const actorFilter = ref('')
const actorText = ref('')
const pageFilter = ref('')
const pageText = ref('')
const entityFilter = ref('')
const entityText = ref('')
const actionFilter = ref('')
const actionText = ref('')

// 退職者（inactive）の操作履歴も残るため、選択肢は全メンバー（active で絞らない = 監査の完全性）
const actorOptions = computed(() => (members.value as Member[]).map(m => ({ value: m.id, label: m.name })))
const pageOptions = auditPageOptions()
const entityOptions = Object.entries(AUDIT_ENTITY_META).map(([value, meta]) => ({ value, label: meta.label }))
const actionOptions = Object.entries(AUDIT_ACTION_META).map(([value, meta]) => ({ value, label: meta.label }))

const activeCount = computed(() =>
  [atFrom, atTo, actorFilter, pageFilter, entityFilter, actionFilter].filter(r => r.value !== '').length)

function clearFilters(): void {
  atFrom.value = ''
  atTo.value = ''
  actorFilter.value = ''
  actorText.value = ''
  pageFilter.value = ''
  pageText.value = ''
  entityFilter.value = ''
  entityText.value = ''
  actionFilter.value = ''
  actionText.value = ''
}

/** モック（クライアント）側の絞り込み述語。entity はカタログのキー（snake_case）へ正規化して比較する */
const filterPredicate = computed(() => (r: AuditLogRow): boolean => {
  if (actorFilter.value && r.actorId !== actorFilter.value) return false
  if (actionFilter.value && r.action !== actionFilter.value) return false
  if (entityFilter.value && normalizeAuditEntity(r.entity) !== entityFilter.value) return false
  if (pageFilter.value) {
    const page = auditEntityMeta(r.entity).page || AUDIT_PAGE_OTHER
    if (page !== pageFilter.value) return false
  }
  // at は JST ウォールクロックの ISO 文字列 = 先頭 10 桁がそのまま JST 日付キー（TZ 変換しない）
  const d = String(r.at).slice(0, 10)
  if (atFrom.value && d < atFrom.value) return false
  if (atTo.value && d > atTo.value) return false
  return true
})

/** API（サーバー）側のフィルタパラメータ（f.* の命名は api 側 GET /audit-logs と対） */
const filterParams = computed(() => {
  const p: Record<string, string> = {}
  if (actorFilter.value) p['f.actor'] = actorFilter.value
  if (actionFilter.value) p['f.action'] = actionFilter.value
  if (entityFilter.value) p['f.entity'] = entityFilter.value
  if (pageFilter.value) p['f.page'] = pageFilter.value
  if (atFrom.value) p['f.at.from'] = atFrom.value
  if (atTo.value) p['f.at.to'] = atTo.value
  return p
})

// ---------- 一覧（デュアルモード: mock = source / API = サーバーページング） ----------

// モックのみ tbl('auditLogs') を参照する（API モードで評価すると limit 200 の全件ハイドレーションを
// 誘発するため、computed の遅延評価 = サーバーモードでは未評価に依らず明示ガードする）
const source = computed<AuditLogRow[]>(() => {
  if (apiMode) return []
  const logs = tbl('auditLogs').value as AuditLogRow[]
  return [...logs].sort((a, b) => String(b.at).localeCompare(String(a.at)))
})

const lv = useListView<AuditLogRow>({
  source,
  fetch: p => apiFetchList<AuditLogRow>('/v1/configs/audit-logs', p),
  filterPredicate,
  filterParams,
})

const columns: TableColumn[] = [
  { key: 'at', label: '操作日時', width: '150px', primary: true },
  { key: 'actor', label: '操作ユーザー', width: '120px', primary: true },
  { key: 'page', label: '操作対象ページ', width: '150px', primary: true },
  { key: 'target', label: '操作対象データ', primary: true },
  { key: 'action', label: '操作内容', primary: true },
]

const tableRows = computed(() =>
  lv.rows.value.map((r) => {
    const meta = auditEntityMeta(r.entity)
    return {
      id: String(r.id),
      at: fmtDateTimeSec(String(r.at)),
      actor: memberName(r.actorId),
      page: auditPageName(meta.page),
      target: meta.label,
      entityId: r.entityId,
      action: auditActionLabel(r.action),
      detail: r.detail,
    }
  }))
</script>

<template>
  <UiSectionCard title="監査ログ" description="操作履歴（読み取り専用）" flush>
    <!-- フィルタ（グリッドで折返し = 375px でも 1 列縦積みで崩れない） -->
    <div class="border-b border-line px-3 py-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <span class="text-[11px] font-bold text-muted">
          絞り込み<span v-if="activeCount > 0" class="ml-1 text-brand">（{{ activeCount }}件適用中）</span>
        </span>
        <button type="button" class="btn btn-sm" :disabled="activeCount === 0" @click="clearFilters">
          <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" /> クリア
        </button>
      </div>
      <div class="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        <div class="grid min-w-0 gap-1">
          <label class="text-[11px] font-semibold text-muted">操作日時</label>
          <div class="flex items-center gap-1">
            <input v-model="atFrom" type="date" class="input min-w-0 flex-1" aria-label="操作日時（開始）">
            <span class="shrink-0 text-[11px] text-muted">〜</span>
            <input v-model="atTo" type="date" class="input min-w-0 flex-1" aria-label="操作日時（終了）">
          </div>
        </div>
        <div class="grid min-w-0 gap-1">
          <label class="text-[11px] font-semibold text-muted">操作ユーザー</label>
          <UiCombobox
            v-model="actorFilter"
            v-model:text="actorText"
            :options="actorOptions"
            :allow-create="false"
            placeholder="メンバー名で絞り込み"
            aria-label="操作ユーザーで絞り込み"
          />
        </div>
        <div class="grid min-w-0 gap-1">
          <label class="text-[11px] font-semibold text-muted">操作対象ページ</label>
          <!-- ラベルが「名称（パス）」で識別情報を含むため showValue=false（重複表示の抑止） -->
          <UiCombobox
            v-model="pageFilter"
            v-model:text="pageText"
            :options="pageOptions"
            :allow-create="false"
            :show-value="false"
            placeholder="ページ名で絞り込み"
            aria-label="操作対象ページで絞り込み"
          />
        </div>
        <div class="grid min-w-0 gap-1">
          <label class="text-[11px] font-semibold text-muted">操作対象データ</label>
          <UiCombobox
            v-model="entityFilter"
            v-model:text="entityText"
            :options="entityOptions"
            :allow-create="false"
            placeholder="データ名で絞り込み"
            aria-label="操作対象データで絞り込み"
          />
        </div>
        <div class="grid min-w-0 gap-1">
          <label class="text-[11px] font-semibold text-muted">操作内容</label>
          <UiCombobox
            v-model="actionFilter"
            v-model:text="actionText"
            :options="actionOptions"
            :allow-create="false"
            placeholder="操作内容で絞り込み"
            aria-label="操作内容で絞り込み"
          />
        </div>
      </div>
    </div>

    <UiDataTable
      :columns="columns"
      :rows="tableRows"
      empty-title="操作履歴はまだありません"
      :empty-hint="activeCount > 0 ? '絞り込み条件に一致する操作履歴がありません' : 'マスタや設定を変更すると記録されます'"
    >
      <template #cell-target="{ row }">
        <span class="block">{{ row.target }}</span>
        <span class="num block text-[11px] text-muted">{{ row.entityId }}</span>
      </template>
      <template #cell-action="{ row }">
        <span class="block">{{ row.action }}</span>
        <span v-if="row.detail" class="block text-[11px] text-muted">{{ row.detail }}</span>
      </template>
    </UiDataTable>

    <div class="px-3 pb-3">
      <UiPagination v-model:page="lv.page.value" v-model:page-size="lv.pageSize.value" :total="lv.total.value" />
      <p class="mt-2 text-[11px] text-muted">
        {{ apiMode
          ? 'すべてのデータ変更操作が記録されます（追記のみ・編集不可）'
          : 'モックモードではマスタ・設定の操作を中心に記録されます（API モードでは全データ変更操作が記録されます）' }}
      </p>
    </div>
  </UiSectionCard>
</template>
