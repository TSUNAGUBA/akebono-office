<script setup lang="ts">
/**
 * 権限表モード（F-16-1・オペレーター指示 2026-07-19 #2）。
 * 行 = 機能 + マスタ表示項目（論理名）、列 = レイヤ内の対象（ロール / 役職 / 個人）。
 * セルはそのレイヤに設定された明示ルールを表示し、クリックで 未設定 → 拒否 → 許可 → 未設定 を循環する。
 * - データはルール一覧モードと同じ PermissionRule（1 項目 1 ルール・スキーマ不変 = 両モード相互運用）
 * - 拒否化は同一キーの無効ルールがあれば復元して再利用（冪等・履歴の乱立防止）。解除は論理削除（監査保持）
 * - 未設定 = 既定の許可。最終的な可否はレイヤ解決（個人 > 役職 > ロール）で決まる点はヒントで明示
 */
import { Check, X } from 'lucide-vue-next'
import type { CodeMasterItem, Member, PermissionRule } from '~/types/domain'
import { FEATURE_PERMISSION_KEYS } from '../../../../shared/domain/permissions'
import { FIELD_CATALOG, FIELD_RESOURCES } from '~/utils/permission-catalog'

const ruleCrud = useMasterCrudAsync('permissionRules', 'pm')
const memberCrud = useMasterCrudAsync('members', 'm')
const { list: codeMasters } = useMasterCrudAsync('codeMaster', 'cm')
const toast = useToast()

const LAYER_TABS = [
  { key: 'role', label: 'ロール' },
  { key: 'title', label: '役職' },
  { key: 'member', label: '個人' },
]
const ROLE_LABELS: Record<string, string> = { admin: '管理者', hr: '人事', member: '一般' }

// UiTabBar（string v-model）との親和性のため string で保持し、保存時に絞る
const matrixLayer = ref('role')
/** 個人レイヤで列に出すメンバー（多すぎるため選択式。UiMultiCombobox を再利用） */
const memberCols = ref<string[]>([])

const memberOptions = computed(() =>
  (memberCrud.activeList.value as Member[]).map(m => ({ value: m.id, label: m.name })))

const columns = computed<{ id: string; label: string }[]>(() => {
  if (matrixLayer.value === 'role') {
    return Object.entries(ROLE_LABELS).map(([id, label]) => ({ id, label }))
  }
  if (matrixLayer.value === 'title') {
    return (codeMasters.value as CodeMasterItem[])
      .filter(cm => cm.category === 'title' && cm.active)
      .map(cm => ({ id: cm.label, label: cm.label }))
  }
  return memberCols.value.map(id => ({
    id,
    label: (memberCrud.byId(id) as Member | undefined)?.name ?? id,
  }))
})

interface MatrixRow {
  resource: string
  field: string | null
  label: string
}

const sections = computed<{ key: string; label: string; rows: MatrixRow[] }[]>(() => [
  {
    key: 'features',
    label: '機能（利用可否）',
    rows: FEATURE_PERMISSION_KEYS.map(f => ({ resource: f.key, field: null, label: f.label })),
  },
  ...FIELD_RESOURCES.map(r => ({
    key: r.key,
    label: `マスタ項目: ${r.label}`,
    rows: (FIELD_CATALOG[r.key] ?? []).map(f => ({ resource: r.key, field: f.value, label: f.label })),
  })),
])

// ---------- セル状態と循環 ----------

const activeRules = computed(() => (ruleCrud.list.value as PermissionRule[]).filter(r => r.active))

function matchKey(r: PermissionRule, subjectId: string, row: MatrixRow): boolean {
  return r.subjectKind === matrixLayer.value && r.subjectId === subjectId
    && r.resource === row.resource && (r.field ?? null) === row.field
}

/** セルに表示する明示ルール（同一キーに複数ある場合はレイヤ内解決と同じ deny 優先で代表させる） */
function cellRule(subjectId: string, row: MatrixRow): PermissionRule | undefined {
  const ms = activeRules.value.filter(r => matchKey(r, subjectId, row))
  return ms.find(r => r.effect === 'deny') ?? ms[0]
}

/** 連打の競合防止（同一セルの処理中は無視） */
const busyCells = ref(new Set<string>())

async function cycleCell(subjectId: string, row: MatrixRow): Promise<void> {
  const key = `${subjectId}:${row.resource}:${row.field ?? ''}`
  if (busyCells.value.has(key)) return
  busyCells.value = new Set([...busyCells.value, key])
  try {
    const matches = activeRules.value.filter(r => matchKey(r, subjectId, row))
    const rule = matches.find(r => r.effect === 'deny') ?? matches[0]
    let res: { ok: true } | { ok: false; error: { code: string; message: string } } = { ok: true }
    if (!rule) {
      // 未設定 → 拒否。同一キーの無効ルールがあれば復元して再利用（履歴の乱立防止）。
      // 順序は「無効のまま effect を deny へ書き換え → 復元」: 途中失敗しても有効な allow が
      // 復活しない = 拒否操作の失敗が権限を広げる方向に倒れない（フェイルセーフ。レビュー R-1）
      const inactive = (ruleCrud.list.value as PermissionRule[]).find(r => !r.active && matchKey(r, subjectId, row))
      if (inactive) {
        if (inactive.effect !== 'deny') res = await ruleCrud.save({ id: inactive.id, effect: 'deny' })
        if (res.ok) res = await ruleCrud.restore(inactive.id)
      } else {
        res = await ruleCrud.save({
          subjectKind: matrixLayer.value as PermissionRule['subjectKind'], subjectId,
          resource: row.resource, field: row.field, effect: 'deny',
        })
      }
    } else if (rule.effect === 'deny') {
      // 拒否 → 許可。同一キーに有効な allow が既にある（旧データの deny+allow 併存）場合は
      // patch すると完全重複 allow が生まれるため、deny の論理削除で許可状態にする（レビュー M-2）
      const otherAllow = matches.some(r => r.id !== rule.id && r.effect === 'allow')
      res = otherAllow ? await ruleCrud.archive(rule.id) : await ruleCrud.save({ id: rule.id, effect: 'allow' })
    } else {
      // 許可 → 未設定（論理削除 = 監査保持。既定の許可へ戻る）。同一キーの有効ルールを全件
      // 論理削除する（旧データで複数併存していても 1 クリックで未設定へ収束 = 空振りしない）
      for (const m of matches) {
        res = await ruleCrud.archive(m.id)
        if (!res.ok) break
      }
    }
    if (!res.ok) toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    // 成功時のトーストは出さない（セルの状態変化が即時フィードバック。連続編集の邪魔をしない設計判断）
  } finally {
    const next = new Set(busyCells.value)
    next.delete(key)
    busyCells.value = next
  }
}

function cellState(subjectId: string, row: MatrixRow): 'deny' | 'allow' | 'unset' {
  const rule = cellRule(subjectId, row)
  return rule ? rule.effect : 'unset'
}

const STATE_LABELS: Record<string, string> = { deny: '拒否', allow: '許可', unset: '未設定（既定 = 許可）' }

/**
 * admin のマスタ・設定 deny はロックアウト防止で無視される（shared/domain/permissions.ts の
 * canUseFeature と同期。保護は利用者属性ベース = ロール列の admin と、role が admin の個人列が対象。
 * 役職レイヤは対象者が静的に決まらないため脚注での言及に留める）
 */
function isLockoutProtected(subjectId: string, row: MatrixRow): boolean {
  if (!(row.resource === 'masters' || row.resource === 'settings') || row.field !== null) return false
  if (matrixLayer.value === 'role') return subjectId === 'admin'
  if (matrixLayer.value === 'member') {
    return (memberCrud.byId(subjectId) as Member | undefined)?.role === 'admin'
  }
  return false
}
</script>

<template>
  <UiSectionCard
    title="権限表"
    description="セルをクリックすると 未設定 → 拒否 → 許可 → 未設定 の順に切り替わります（未設定 = 既定の許可）。表示されるのはこのレイヤに設定された明示ルールで、最終的な可否は 個人 > 役職 > ロール の順で解決されます"
    flush
  >
    <div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
      <UiTabBar v-model="matrixLayer" :tabs="LAYER_TABS" />
      <div v-if="matrixLayer === 'member'" class="min-w-64 flex-1">
        <UiMultiCombobox
          v-model="memberCols"
          :options="memberOptions"
          placeholder="列に表示するメンバーを選択"
          aria-label="列に表示するメンバー"
        />
      </div>
      <div class="ml-auto flex items-center gap-3 text-[11px] text-muted">
        <span class="inline-flex items-center gap-1"><X class="h-3 w-3 text-crit" aria-hidden="true" />拒否</span>
        <span class="inline-flex items-center gap-1"><Check class="h-3 w-3 text-ok" aria-hidden="true" />許可</span>
        <span>・未設定</span>
      </div>
    </div>

    <p v-if="columns.length === 0" class="px-4 py-6 text-center text-[13px] text-muted">
      {{ matrixLayer === 'member' ? '列に表示するメンバーを選択してください' : '対象がありません（役職マスタを確認してください）' }}
    </p>

    <div v-else class="overflow-x-auto">
      <table class="w-full min-w-[560px] border-collapse text-[13px]">
        <thead>
          <tr class="border-b border-line">
            <th class="sticky left-0 z-10 bg-surface px-4 py-2 text-left text-[11px] font-semibold text-muted">リソース / 項目</th>
            <th v-for="col in columns" :key="col.id" class="px-2 py-2 text-center text-[11px] font-semibold text-muted">
              {{ col.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <template v-for="section in sections" :key="section.key">
            <tr class="border-b border-line bg-surface-soft">
              <td :colspan="columns.length + 1" class="px-4 py-1.5 text-[11px] font-bold text-sub">
                <!-- colspan セルは全幅のため sticky の可動域がない。内側要素を sticky にして横スクロールでも見出しを画面内に留める -->
                <span class="sticky left-4 inline-block">{{ section.label }}</span>
              </td>
            </tr>
            <tr v-for="row in section.rows" :key="`${row.resource}:${row.field ?? ''}`" class="border-b border-line last:border-b-0">
              <td class="sticky left-0 z-10 bg-surface px-4 py-1 pl-6" :title="row.field ? `物理キー: ${row.field}` : row.resource">
                {{ row.label }}
              </td>
              <td v-for="col in columns" :key="col.id" class="px-2 py-1 text-center">
                <button
                  type="button"
                  class="inline-flex h-7 w-10 items-center justify-center rounded-md border transition-colors"
                  :class="{
                    'border-crit/40 bg-crit-soft': cellState(col.id, row) === 'deny',
                    'border-ok/40 bg-ok-soft': cellState(col.id, row) === 'allow',
                    'border-transparent hover:border-line-strong': cellState(col.id, row) === 'unset',
                    'opacity-50': busyCells.has(`${col.id}:${row.resource}:${row.field ?? ''}`),
                  }"
                  :aria-busy="busyCells.has(`${col.id}:${row.resource}:${row.field ?? ''}`)"
                  :aria-label="`${col.label} × ${section.label}/${row.label}: ${STATE_LABELS[cellState(col.id, row)]}。クリックで切替`"
                  :title="isLockoutProtected(col.id, row) ? 'ロックアウト防止のため管理者への拒否は無効です' : undefined"
                  @click="cycleCell(col.id, row)"
                >
                  <X v-if="cellState(col.id, row) === 'deny'" class="h-4 w-4 text-crit" aria-hidden="true" />
                  <Check v-else-if="cellState(col.id, row) === 'allow'" class="h-4 w-4 text-ok" aria-hidden="true" />
                  <span v-else class="text-muted">・</span>
                  <span v-if="isLockoutProtected(col.id, row) && cellState(col.id, row) === 'deny'" class="ml-0.5 text-[10px] text-muted">※</span>
                </button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <p class="border-t border-line px-4 py-2 text-[11px] text-muted">
      ※ 管理者（ロール列の管理者・権限ロールが管理者の個人。役職経由で該当する場合も同様）の「マスタメンテナンス」「設定」への拒否はロックアウト防止のため判定時に無視されます。個々のルールの無効化・復元の履歴はルール一覧モードで確認できます
    </p>
  </UiSectionCard>
</template>
