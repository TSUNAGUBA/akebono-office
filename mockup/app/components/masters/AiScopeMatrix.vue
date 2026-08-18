<script setup lang="ts">
/**
 * AIの参照範囲（改修依頼 2026-08-18: 権限設定の専用タブ）。
 * データ種類（メニュー単位）ごとに「誰（参照者）が誰（登録者）の登録データを AI 経由で参照できるか」を
 * 登録者単位で設定する。行 = 対象（登録者: 全メンバー一括 / ロール / 役職 / 個人）、
 * 列 = 参照者（レイヤ内の対象。権限表と同じ ロール / 役職 / 個人 の切替）。
 * - ルールは PermissionRule のまま（resource = データ種類・field = `ai-scope:<対象>`・スキーマ不変）
 * - セルは 参照可（明示 allow）/ 参照不可（明示 deny）/ 既定（明示ルールなし = 権限表の参照権限に従う）
 *   の三値をクリックで循環する（既定 → 参照可 → 参照不可 → 既定。既定へ戻す = 論理削除 = 取消フロー）
 * - 実際の解決順（shared/domain/permissions.canAiReferenceOwner）: 個人 > 役職 > ロール（参照者レイヤ）、
 *   同一レイヤ内は 個人指定 > 役職指定 > ロール指定 > 全メンバー一括 > レガシー二値（AI 参照範囲）> 既定
 * - 本人（参照者 = 登録者）の登録データは常に参照可（設定ミスで自分のデータが見えなくなる事故を防ぐ）
 */
import { Check, Minus, X } from 'lucide-vue-next'
import type { CodeMasterItem, Member, PermissionRule } from '~/types/domain'
import {
  AI_REFERENCE_DATATYPES, AI_SCOPE_TARGET_ALL_FIELD, AI_SCOPE_TARGET_PREFIX,
} from '../../../../shared/domain/permissions'

const ruleCrud = useMasterCrudAsync('permissionRules', 'pm')
const memberCrud = useMasterCrudAsync('members', 'm')
const { list: codeMasters } = useMasterCrudAsync('codeMaster', 'cm')
const toast = useToast()

const ROLE_LABELS: Record<string, string> = { admin: '管理者', hr: '人事', member: '一般' }
const LAYER_TABS = [
  { key: 'role', label: 'ロール' },
  { key: 'title', label: '役職' },
  { key: 'member', label: '個人' },
]

/** 設定対象のデータ種類（メニュー単位） */
const datatype = ref(AI_REFERENCE_DATATYPES[0]!.key)
const datatypeTabs = AI_REFERENCE_DATATYPES.map(d => ({ key: d.key, label: d.label }))

/** 参照者（列）のレイヤ。権限表と同じ切替 + 個人レイヤは列メンバーを選択式にする */
const viewerLayer = ref('role')
const viewerMemberCols = ref<string[]>([])

const memberOptions = computed(() =>
  (memberCrud.activeList.value as Member[]).map(m => ({ value: m.id, label: m.name })))

const activeTitles = computed(() =>
  (codeMasters.value as CodeMasterItem[]).filter(cm => cm.category === 'title' && cm.active))

const columns = computed<{ id: string; label: string }[]>(() => {
  if (viewerLayer.value === 'role') {
    return Object.entries(ROLE_LABELS).map(([id, label]) => ({ id, label }))
  }
  if (viewerLayer.value === 'title') {
    return activeTitles.value.map(cm => ({ id: cm.label, label: cm.label }))
  }
  return viewerMemberCols.value.map(id => ({
    id,
    label: (memberCrud.byId(id) as Member | undefined)?.name ?? id,
  }))
})

// ---------- 行 = 対象（登録者） ----------

interface TargetRow {
  /** permission_rules.field（ai-scope:* / ai-scope:role:x / ai-scope:title:x / ai-scope:member:x） */
  field: string
  label: string
  /** グループ見出し用 */
  group: '一括' | 'ロール' | '役職' | '個人'
}

/** 個人（登録者）行に出すメンバー（多すぎるため選択式。列の選択とは独立） */
const targetMemberRows = ref<string[]>([])

const rows = computed<TargetRow[]>(() => [
  { field: AI_SCOPE_TARGET_ALL_FIELD, label: '全メンバー（一括）', group: '一括' as const },
  ...Object.entries(ROLE_LABELS).map(([id, label]) => ({
    field: `${AI_SCOPE_TARGET_PREFIX}role:${id}`, label, group: 'ロール' as const,
  })),
  ...activeTitles.value.map(cm => ({
    field: `${AI_SCOPE_TARGET_PREFIX}title:${cm.label}`, label: cm.label, group: '役職' as const,
  })),
  ...targetMemberRows.value.map(id => ({
    field: `${AI_SCOPE_TARGET_PREFIX}member:${id}`,
    label: (memberCrud.byId(id) as Member | undefined)?.name ?? id,
    group: '個人' as const,
  })),
])

// ---------- セル状態（参照可 / 参照不可 / 既定 の三値） ----------

const activeRules = computed(() => (ruleCrud.list.value as PermissionRule[]).filter(r => r.active))

function matchCell(r: PermissionRule, subjectId: string, field: string): boolean {
  return r.subjectKind === viewerLayer.value && r.subjectId === subjectId
    && r.resource === datatype.value && (r.field ?? null) === field
}

function explicitRules(subjectId: string, field: string): PermissionRule[] {
  return activeRules.value.filter(r => matchCell(r, subjectId, field))
}

type CellState = 'allow' | 'deny' | 'default'

/** 個人レイヤの列 × 個人の行で本人自身のセル（常に参照可 = resolver と同期）か */
function isSelfCell(subjectId: string, row: TargetRow): boolean {
  return viewerLayer.value === 'member' && row.field === `${AI_SCOPE_TARGET_PREFIX}member:${subjectId}`
}

function cellState(subjectId: string, row: TargetRow): CellState {
  if (isSelfCell(subjectId, row)) return 'allow'
  const ms = explicitRules(subjectId, row.field)
  if (ms.length === 0) return 'default'
  return ms.every(r => r.effect === 'allow') ? 'allow' : 'deny' // 同一キー複数は deny 優先
}

const STATE_LABELS: Record<CellState, string> = {
  allow: '参照可（明示設定）',
  deny: '参照不可（明示設定）',
  default: '既定（権限表の参照権限・上位の一括設定に従う）',
}

function stateLabel(subjectId: string, row: TargetRow): string {
  if (isSelfCell(subjectId, row)) return '参照可（本人の登録データは常に参照可）'
  return STATE_LABELS[cellState(subjectId, row)]
}

// ---------- クリック = 既定 → 参照可 → 参照不可 → 既定 の循環 ----------

const busyCells = ref(new Set<string>())

function busyKey(subjectId: string, row: TargetRow): string {
  return `${subjectId}:${datatype.value}:${row.field}`
}

async function cycleCell(subjectId: string, row: TargetRow): Promise<void> {
  if (isSelfCell(subjectId, row)) return
  const key = busyKey(subjectId, row)
  if (busyCells.value.has(key)) return
  busyCells.value = new Set([...busyCells.value, key])
  try {
    const ms = explicitRules(subjectId, row.field)
    let res: { ok: true } | { ok: false; error: { code: string; message: string } } = { ok: true }
    if (ms.length === 0) {
      // 既定 → 参照可。同一キーの無効ルールがあれば復元して再利用（履歴の乱立防止）。
      // 順序は「無効のまま effect を書き換え → 復元」= 途中失敗で旧効果が復活しない（フェイルセーフ）
      const inactive = (ruleCrud.list.value as PermissionRule[])
        .find(r => !r.active && matchCell(r, subjectId, row.field))
      if (inactive) {
        if (inactive.effect !== 'allow') res = await ruleCrud.save({ id: inactive.id, effect: 'allow' })
        if (res.ok) res = await ruleCrud.restore(inactive.id)
      } else {
        res = await ruleCrud.save({
          subjectKind: viewerLayer.value as PermissionRule['subjectKind'], subjectId,
          resource: datatype.value, field: row.field, effect: 'allow',
        })
      }
    } else if (ms.every(r => r.effect === 'allow')) {
      // 参照可 → 参照不可。代表 1 件を書き換え、同一キーの残りは論理削除で整理（deny が先に立つ = 安全側）
      res = await ruleCrud.save({ id: ms[0]!.id, effect: 'deny' })
      if (res.ok) {
        for (const m of ms.slice(1)) {
          res = await ruleCrud.archive(m.id)
          if (!res.ok) break
        }
      }
    } else {
      // 参照不可 → 既定（明示ルールを論理削除 = 監査保持・取消フロー）。
      // allow を先に消し deny を最後に消す = 途中失敗しても deny が残る（緩む方向に倒れない）
      const ordered = [...ms.filter(r => r.effect === 'allow'), ...ms.filter(r => r.effect === 'deny')]
      for (const m of ordered) {
        res = await ruleCrud.archive(m.id)
        if (!res.ok) break
      }
    }
    if (!res.ok) toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    // 成功時のトーストは出さない（セルの状態変化が即時フィードバック = 権限表と同じ設計判断）
  } finally {
    const next = new Set(busyCells.value)
    next.delete(key)
    busyCells.value = next
  }
}

function cellClass(subjectId: string, row: TargetRow): string[] {
  const busy = busyCells.value.has(busyKey(subjectId, row))
  const state = cellState(subjectId, row)
  const cls: string[] = []
  if (state === 'allow') cls.push('border-ok/40 bg-ok-soft')
  else if (state === 'deny') cls.push('border-crit/40 bg-crit-soft')
  else cls.push('border-dashed border-line-strong opacity-70 hover:opacity-100')
  if (busy) cls.push('opacity-40')
  if (isSelfCell(subjectId, row)) cls.push('cursor-not-allowed')
  return cls
}

/** グループ見出し（先頭行のみ表示） */
function groupLabel(row: TargetRow, index: number): string | null {
  const prev = rows.value[index - 1]
  return !prev || prev.group !== row.group ? row.group : null
}

const datatypeLabel = computed(() =>
  AI_REFERENCE_DATATYPES.find(d => d.key === datatype.value)?.label ?? datatype.value)
</script>

<template>
  <UiSectionCard
    title="AIの参照範囲"
    description="データ種類（メニュー単位）ごとに、誰（参照者）が誰（登録者）の登録データを AI（チャットボット・AI業務アシスタント）経由で参照できるかを設定します。セルは 参照可 / 参照不可 / 既定 をクリックで循環します（既定 = 権限表の参照権限に従う。明示設定が既定より優先）。参照者側の解決順は 個人 > 役職 > ロール、対象（登録者）側は 個人 > 役職 > ロール > 全メンバー一括 の順です"
    flush
  >
    <div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
      <UiTabBar v-model="datatype" :tabs="datatypeTabs" aria-label="データ種類" />
    </div>
    <div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
      <span class="text-[11px] font-semibold text-muted">参照者（列）</span>
      <UiTabBar v-model="viewerLayer" :tabs="LAYER_TABS" aria-label="参照者のレイヤ" />
      <div v-if="viewerLayer === 'member'" class="min-w-64 flex-1">
        <UiMultiCombobox
          v-model="viewerMemberCols"
          :options="memberOptions"
          placeholder="列に表示する参照者（メンバー）を選択"
          aria-label="列に表示する参照者"
        />
      </div>
      <div class="min-w-64 flex-1">
        <UiMultiCombobox
          v-model="targetMemberRows"
          :options="memberOptions"
          placeholder="行に追加する対象（登録者・個人）を選択"
          aria-label="行に追加する対象メンバー"
        />
      </div>
      <div class="flex w-full items-center gap-3 text-[11px] text-muted">
        <span class="inline-flex items-center gap-1"><Check class="h-3 w-3 text-ok" aria-hidden="true" />参照可</span>
        <span class="inline-flex items-center gap-1"><X class="h-3 w-3 text-crit" aria-hidden="true" />参照不可</span>
        <span class="inline-flex items-center gap-1"><Minus class="h-3 w-3" aria-hidden="true" />既定（権限表の参照権限に従う）</span>
      </div>
    </div>

    <p v-if="columns.length === 0" class="px-4 py-6 text-center text-[13px] text-muted">
      {{ viewerLayer === 'member' ? '列に表示する参照者（メンバー）を選択してください' : '対象がありません（役職マスタを確認してください）' }}
    </p>

    <div v-else class="scroll-slim max-h-[calc(100dvh-var(--header-h)-14rem)] min-h-64 overflow-auto">
      <table class="w-full min-w-[560px] border-collapse text-[13px]" style="isolation: isolate">
        <thead>
          <tr class="border-b border-line">
            <th class="sticky left-0 top-0 z-30 bg-surface-soft px-4 py-2 text-left text-[11px] font-semibold text-muted">
              対象（登録者）
            </th>
            <th
              v-for="col in columns"
              :key="col.id"
              class="sticky top-0 z-20 bg-surface-soft px-2 py-2 text-center text-[11px] font-semibold text-muted"
            >
              {{ col.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <template v-for="(row, i) in rows" :key="row.field">
            <tr v-if="groupLabel(row, i)" class="border-b border-line bg-surface-soft">
              <td class="sticky left-0 z-10 bg-surface-soft px-4 py-1 text-[11px] font-semibold text-muted" :colspan="1 + columns.length">
                対象: {{ groupLabel(row, i) }}
              </td>
            </tr>
            <tr class="border-b border-line last:border-b-0">
              <td
                class="sticky left-0 z-10 bg-surface py-1 pl-6 pr-3"
                :title="`物理キー: ${datatype} / ${row.field}`"
              >
                {{ row.label }}
              </td>
              <td v-for="col in columns" :key="col.id" class="px-2 py-1 text-center">
                <button
                  type="button"
                  class="inline-flex h-7 w-10 items-center justify-center rounded-md border transition-colors"
                  :class="cellClass(col.id, row)"
                  :disabled="isSelfCell(col.id, row)"
                  :aria-busy="busyCells.has(busyKey(col.id, row))"
                  :aria-label="`${col.label} × ${datatypeLabel} × ${row.label}: ${stateLabel(col.id, row)}。クリックで切替`"
                  :title="stateLabel(col.id, row)"
                  @click="cycleCell(col.id, row)"
                >
                  <Check v-if="cellState(col.id, row) === 'allow'" class="h-4 w-4 text-ok" aria-hidden="true" />
                  <X v-else-if="cellState(col.id, row) === 'deny'" class="h-4 w-4 text-crit" aria-hidden="true" />
                  <Minus v-else class="h-4 w-4 text-muted" aria-hidden="true" />
                  <span v-if="isSelfCell(col.id, row)" class="ml-0.5 text-[10px] text-muted">※</span>
                </button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <p class="border-t border-line px-4 py-2 text-[11px] text-muted">
      ※ 本人（参照者 = 登録者）の登録データは常に参照可のため操作できません。既定値はデータ種類ごとに異なります:
      改善のタネ = 全員参照可 / 勤怠 = 本人のみ / タスク計画 = 権限表「AI業務アシスタントの参照対象」（許可制）/
      日報・週報 = 権限表「日報・週報の参照対象」（既定 参照可）。旧「AI 参照範囲」（すべて / 自分のみ の一括二値）は
      権限表のタブで引き続き設定でき、本タブの登録者単位の設定が優先されます。機能自体の利用拒否（ページの deny）が最優先です
    </p>
  </UiSectionCard>
</template>
