<script setup lang="ts">
/**
 * 権限表モード（F-16-1・オペレーター指示 2026-07-19 #2 / 2026-07-21 バッチ7m で階層化）。
 * 行 = ページ > 機能 > 項目 の 3 階層ツリー（下位層は開閉可能）、列 = レイヤ内の対象（ロール / 役職 / 個人）。
 * - セルは常に 可否 のいずれかを表示する（未設定表示は廃止）。明示ルールが無いセルは
 *   上位階層の設定（マスタ全体 = field null・全メンバー = member:*）→ アプリ既定値 の順で
 *   引き継いだ値を薄色（破線）で表示する = shared/domain/permissions.ts のレイヤ内フォールバックと同一
 * - クリックで反転（明示ルール化）。引き継ぎ値と同じ値へ戻すと明示ルールを論理削除して
 *   上位設定・既定に従う状態へ戻る（= 操作の取消フロー。監査ログは残る）
 * - データはルール一覧モードと同じ PermissionRule（1 項目 1 ルール・スキーマ不変 = 両モード相互運用）
 * - 明示化は同一キーの無効ルールがあれば復元して再利用（冪等・履歴の乱立防止）
 * - 上位（一括）行の設定は明示ルールを持たない下位行にだけ及ぶ。下位行に明示ルールがあれば個別が優先
 */
import { Check, ChevronDown, ChevronRight, X } from 'lucide-vue-next'
import type { CodeMasterItem, Member, PermissionRule } from '~/types/domain'
import {
  AI_SCOPE_FEATURES, AI_SCOPE_FIELD, ASSIST_MEMBER_FIELD_PREFIX, FEATURE_PERMISSION_KEYS,
  MEMBER_VIEW_ALL_FIELD, REPORT_MEMBER_FIELD_PREFIX,
} from '../../../../shared/domain/permissions'
import { FIELD_CATALOG, FIELD_RESOURCES } from '../../../../shared/domain/permission-catalog'

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

// ---------- 行ツリー（ページ > 機能 > 項目） ----------

/** セルの値語彙（allow/deny の表示ラベル切替） */
type CellVocab = 'feature' | 'ai-scope' | 'view'

interface MatrixNode {
  resource: string
  field: string | null
  label: string
  /** 0 = ページ / 1 = 機能 / 2 = 項目 */
  depth: 0 | 1 | 2
  vocab: CellVocab
  /** どのレイヤにもルールが無い場合のアプリ既定値（true = 許可/すべて/参照可） */
  defaultAllow: boolean
  /** 明示ルールが無い場合に値を引き継ぐ上位行のキー（resolver のレイヤ内フォールバックと同一） */
  parent?: { resource: string; field: string | null }
  children?: MatrixNode[]
}

function nodeId(n: Pick<MatrixNode, 'resource' | 'field'>): string {
  return `${n.resource}::${n.field ?? ''}`
}

/** 参照対象（全メンバー一括 + メンバー個別）のサブツリー */
function viewTargetNodes(resource: string, label: string, prefix: string, defaultAllow: boolean): MatrixNode {
  return {
    resource,
    field: MEMBER_VIEW_ALL_FIELD,
    label: `${label}: 全メンバー（一括）`,
    depth: 1,
    vocab: 'view',
    defaultAllow,
    children: (memberCrud.activeList.value as Member[]).map(m => ({
      resource,
      field: `${prefix}${m.id}`,
      label: m.name,
      depth: 2 as const,
      vocab: 'view' as const,
      defaultAllow,
      parent: { resource, field: MEMBER_VIEW_ALL_FIELD },
    })),
  }
}

/**
 * ルール一覧モードで設定できる全リソースを網羅する（差分ゼロ = オペレーター指示 2026-07-21）:
 * 機能 18 + AI 参照範囲 3 + 日報/AIアシスタントの参照対象（全メンバー一括 + メンバー個別）+ マスタ項目 6 資源。
 * documents はマスタ項目とページ利用可否が同一キー（resource=documents・field=null）のため、
 * ページ行がそのまま項目の一括既定を兼ねる（canViewField のフォールバック仕様と同一 = 表示が実挙動）
 */
const tree = computed<MatrixNode[]>(() => FEATURE_PERMISSION_KEYS.map((f) => {
  const children: MatrixNode[] = []
  const scope = AI_SCOPE_FEATURES.find(s => s.key === f.key)
  if (scope) {
    children.push({
      resource: f.key,
      field: AI_SCOPE_FIELD,
      label: `AI 参照範囲: ${scope.label}`,
      depth: 1,
      vocab: 'ai-scope',
      defaultAllow: scope.defaultScope === 'all',
    })
  }
  if (f.key === 'reports') {
    children.push(viewTargetNodes('reports', '日報の参照対象', REPORT_MEMBER_FIELD_PREFIX, true))
  }
  if (f.key === 'ai-assistant') {
    children.push(viewTargetNodes('ai-assistant', 'AI業務アシスタントの参照対象', ASSIST_MEMBER_FIELD_PREFIX, false))
  }
  if (f.key === 'documents') {
    children.push(...(FIELD_CATALOG.documents ?? []).map(fld => ({
      resource: 'documents',
      field: fld.value,
      label: fld.label,
      depth: 1 as const,
      vocab: 'feature' as const,
      defaultAllow: true,
      parent: { resource: 'documents', field: null },
    })))
  }
  if (f.key === 'masters') {
    children.push(...FIELD_RESOURCES.filter(r => r.key !== 'documents').map(r => ({
      resource: r.key,
      field: null,
      label: `${r.label}（マスタ全体）`,
      depth: 1 as const,
      vocab: 'feature' as const,
      defaultAllow: true,
      children: (FIELD_CATALOG[r.key] ?? []).map(fld => ({
        resource: r.key,
        field: fld.value,
        label: fld.label,
        depth: 2 as const,
        vocab: 'feature' as const,
        defaultAllow: true,
        parent: { resource: r.key, field: null },
      })),
    })))
  }
  return {
    resource: f.key,
    field: null,
    label: f.label,
    depth: 0 as const,
    vocab: 'feature' as const,
    defaultAllow: true,
    children: children.length > 0 ? children : undefined,
  }
}))

// ---------- 開閉状態 ----------

const expanded = ref(new Set<string>())

function toggleExpand(n: MatrixNode): void {
  const next = new Set(expanded.value)
  if (next.has(nodeId(n))) next.delete(nodeId(n))
  else next.add(nodeId(n))
  expanded.value = next
}

function allExpandableIds(nodes: MatrixNode[]): string[] {
  return nodes.flatMap(n => (n.children ? [nodeId(n), ...allExpandableIds(n.children)] : []))
}

function expandAll(): void {
  expanded.value = new Set(allExpandableIds(tree.value))
}

function collapseAll(): void {
  expanded.value = new Set()
}

const visibleRows = computed<MatrixNode[]>(() => {
  const out: MatrixNode[] = []
  const walk = (nodes: MatrixNode[]): void => {
    for (const n of nodes) {
      out.push(n)
      if (n.children && expanded.value.has(nodeId(n))) walk(n.children)
    }
  }
  walk(tree.value)
  return out
})

// ---------- セル状態（常に可否のいずれか） ----------

const activeRules = computed(() => (ruleCrud.list.value as PermissionRule[]).filter(r => r.active))

function matchKey(r: PermissionRule, subjectId: string, key: { resource: string; field: string | null }): boolean {
  return r.subjectKind === matrixLayer.value && r.subjectId === subjectId
    && r.resource === key.resource && (r.field ?? null) === key.field
}

/** このレイヤ・対象・キーの明示ルール（有効のみ） */
function explicitRules(subjectId: string, node: MatrixNode): PermissionRule[] {
  return activeRules.value.filter(r => matchKey(r, subjectId, node))
}

interface CellInfo {
  /** true = 許可/すべて/参照可 */
  value: boolean
  /** explicit = このレイヤの明示ルール / inherited = 上位行の設定 / default = アプリ既定値 */
  source: 'explicit' | 'inherited' | 'default'
}

/** 明示ルールを除いた場合にセルが示す値（= クリックで明示解除するときの戻り先） */
function inheritedInfo(subjectId: string, node: MatrixNode): CellInfo {
  if (node.parent) {
    const pms = activeRules.value.filter(r => matchKey(r, subjectId, node.parent!))
    if (pms.length > 0) return { value: pms.every(r => r.effect === 'allow'), source: 'inherited' }
  }
  return { value: node.defaultAllow, source: 'default' }
}

function cellInfo(subjectId: string, node: MatrixNode): CellInfo {
  if (isLockoutProtected(subjectId, node) || isSelfView(subjectId, node)) {
    return { value: true, source: 'default' } // 判定時に deny が無視される保護セル（下記参照）は常に可
  }
  const ms = explicitRules(subjectId, node)
  if (ms.length > 0) return { value: ms.every(r => r.effect === 'allow'), source: 'explicit' } // 同一キー複数は deny 優先
  return inheritedInfo(subjectId, node)
}

/**
 * admin のマスタ・設定 deny はロックアウト防止のため無視される（shared/domain/permissions.ts の
 * canUseFeature と同期。保護は利用者属性ベース = ロール列の admin と、role が admin の個人列が対象。
 * 役職レイヤは対象者が静的に決まらないため脚注での言及に留める）
 */
function isLockoutProtected(subjectId: string, node: MatrixNode): boolean {
  if (!(node.resource === 'masters' || node.resource === 'settings') || node.field !== null) return false
  if (matrixLayer.value === 'role') return subjectId === 'admin'
  if (matrixLayer.value === 'member') {
    return (memberCrud.byId(subjectId) as Member | undefined)?.role === 'admin'
  }
  return false
}

/** 個人レイヤで参照対象の行が本人自身のセル（本人は常に参照可 = resolver と同期）か */
function isSelfView(subjectId: string, node: MatrixNode): boolean {
  if (matrixLayer.value !== 'member' || node.vocab !== 'view') return false
  return node.field === `${REPORT_MEMBER_FIELD_PREFIX}${subjectId}`
}

/** 保護セル（クリック不可）か */
function isProtectedCell(subjectId: string, node: MatrixNode): boolean {
  return isLockoutProtected(subjectId, node) || isSelfView(subjectId, node)
}

const VOCAB_LABELS: Record<CellVocab, { allow: string; deny: string }> = {
  'feature': { allow: '許可', deny: '拒否' },
  'ai-scope': { allow: 'すべて', deny: '自分のみ' },
  'view': { allow: '参照可', deny: '参照不可' },
}
const SOURCE_LABELS: Record<CellInfo['source'], string> = {
  explicit: '明示設定',
  inherited: '上位の一括設定に従う',
  default: '既定値',
}

/** セル状態の読み上げ・ツールチップ */
function stateLabel(subjectId: string, node: MatrixNode): string {
  if (isLockoutProtected(subjectId, node)) return '許可（ロックアウト防止のため管理者への拒否は無効）'
  if (isSelfView(subjectId, node)) return '参照可（本人は常に参照可）'
  const info = cellInfo(subjectId, node)
  const v = VOCAB_LABELS[node.vocab][info.value ? 'allow' : 'deny']
  return `${v}（${SOURCE_LABELS[info.source]}）`
}

// ---------- クリック = 反転（明示化）/ 引き継ぎ値へ戻すと明示解除 ----------

/** 連打の競合防止（同一セルの処理中は無視） */
const busyCells = ref(new Set<string>())

function busyKey(subjectId: string, node: MatrixNode): string {
  return `${subjectId}:${node.resource}:${node.field ?? ''}`
}

async function toggleCell(subjectId: string, node: MatrixNode): Promise<void> {
  if (isProtectedCell(subjectId, node)) return
  const key = busyKey(subjectId, node)
  if (busyCells.value.has(key)) return
  busyCells.value = new Set([...busyCells.value, key])
  try {
    const ms = explicitRules(subjectId, node)
    const inherited = inheritedInfo(subjectId, node)
    const target = ms.length > 0 ? !ms.every(r => r.effect === 'allow') : !inherited.value
    const targetEffect: PermissionRule['effect'] = target ? 'allow' : 'deny'
    let res: { ok: true } | { ok: false; error: { code: string; message: string } } = { ok: true }
    if (ms.length === 0) {
      // 引き継ぎ値の反転 = 明示ルールを新規作成。同一キーの無効ルールがあれば復元して再利用
      // （履歴の乱立防止）。順序は「無効のまま effect を書き換え → 復元」: 途中失敗しても
      // 旧効果のルールが復活しない = 操作失敗が権限を広げる方向に倒れない（フェイルセーフ。レビュー R-1）
      const inactive = (ruleCrud.list.value as PermissionRule[]).find(r => !r.active && matchKey(r, subjectId, node))
      if (inactive) {
        if (inactive.effect !== targetEffect) res = await ruleCrud.save({ id: inactive.id, effect: targetEffect })
        if (res.ok) res = await ruleCrud.restore(inactive.id)
      } else {
        res = await ruleCrud.save({
          subjectKind: matrixLayer.value as PermissionRule['subjectKind'], subjectId,
          resource: node.resource, field: node.field, effect: targetEffect,
        })
      }
    } else if (target === inherited.value) {
      // 反転先が引き継ぎ値と同じ = 明示ルールを解除（論理削除 = 監査保持）して上位設定・既定に従う。
      // allow を先に消し deny を最後に消す: 途中失敗しても deny が残る = 緩む方向に倒れない
      const ordered = [...ms.filter(r => r.effect === 'allow'), ...ms.filter(r => r.effect === 'deny')]
      for (const m of ordered) {
        res = await ruleCrud.archive(m.id)
        if (!res.ok) break
      }
    } else {
      // 明示ルールの値を反転。代表 1 件を書き換え、同一キーの残り（旧データの併存）は論理削除で整理。
      // 書き換えを先に行う: target=deny は即拒否が立ち、target=allow の途中失敗は deny が残る（安全側）
      res = await ruleCrud.save({ id: ms[0]!.id, effect: targetEffect })
      if (res.ok) {
        for (const m of ms.slice(1)) {
          res = await ruleCrud.archive(m.id)
          if (!res.ok) break
        }
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

const INDENT: Record<number, string> = { 0: 'pl-3', 1: 'pl-8', 2: 'pl-14' }

/** セルボタンの見た目（明示 = 実線濃色 / 引き継ぎ = 破線薄色。busy 中は薄色を上書きしない） */
function cellClass(subjectId: string, node: MatrixNode): string[] {
  const busy = busyCells.value.has(busyKey(subjectId, node))
  const info = cellInfo(subjectId, node)
  const cls: string[] = []
  if (info.source === 'explicit') {
    cls.push(info.value ? 'border-ok/40 bg-ok-soft' : 'border-crit/40 bg-crit-soft')
  } else {
    cls.push('border-dashed', info.value ? 'border-ok/40' : 'border-crit/40')
    if (!busy) cls.push('opacity-55 hover:opacity-80')
  }
  if (busy) cls.push('opacity-40')
  if (isProtectedCell(subjectId, node)) cls.push('cursor-not-allowed')
  return cls
}
</script>

<template>
  <UiSectionCard
    title="権限表"
    description="ページ > 機能 > 項目 の階層で権限を設定します。セルは常に可否のいずれかを表示し、クリックで反転します（濃色 = このレイヤの明示設定 / 薄色破線 = 上位の一括設定・既定値に従う状態。反転を戻すと明示設定は解除されます）。最終的な可否は 個人 > 役職 > ロール の順で解決されます"
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
      <div class="ml-auto flex items-center gap-2">
        <button type="button" class="btn btn-sm" @click="expandAll">全て展開</button>
        <button type="button" class="btn btn-sm" @click="collapseAll">全て閉じる</button>
      </div>
      <div class="flex w-full items-center gap-3 text-[11px] text-muted">
        <span class="inline-flex items-center gap-1"><X class="h-3 w-3 text-crit" aria-hidden="true" />拒否 / 自分のみ / 参照不可</span>
        <span class="inline-flex items-center gap-1"><Check class="h-3 w-3 text-ok" aria-hidden="true" />許可 / すべて / 参照可</span>
        <span>薄色破線 = 上位の一括設定・既定値に従う</span>
      </div>
    </div>

    <p v-if="columns.length === 0" class="px-4 py-6 text-center text-[13px] text-muted">
      {{ matrixLayer === 'member' ? '列に表示するメンバーを選択してください' : '対象がありません（役職マスタを確認してください）' }}
    </p>

    <!-- 表ヘッダは内部スクロール + sticky で常に画面内に保つ（UiSectionCard のカードは
         overflow-hidden・横スクロールも必要なため、ページ側 sticky ではなく表専用のスクロール領域で固定する） -->
    <div v-else class="scroll-slim max-h-[calc(100dvh-var(--header-h)-11rem)] min-h-64 overflow-auto">
      <table class="w-full min-w-[560px] border-collapse text-[13px]" style="isolation: isolate">
        <thead>
          <tr class="border-b border-line">
            <th class="sticky left-0 top-0 z-30 bg-surface-soft px-4 py-2 text-left text-[11px] font-semibold text-muted">
              ページ / 機能 / 項目
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
          <tr
            v-for="row in visibleRows"
            :key="nodeId(row)"
            class="border-b border-line last:border-b-0"
            :class="{ 'bg-surface-soft': row.depth === 0 && row.children }"
          >
            <td
              class="sticky left-0 z-10 py-1 pr-3"
              :class="[INDENT[row.depth], row.depth === 0 && row.children ? 'bg-surface-soft' : 'bg-surface']"
              :title="row.field ? `物理キー: ${row.resource} / ${row.field}` : `物理キー: ${row.resource}`"
            >
              <button
                v-if="row.children"
                type="button"
                class="inline-flex items-center gap-1 text-left font-medium hover:text-brand"
                :aria-expanded="expanded.has(nodeId(row))"
                :aria-label="`${row.label} の下位項目を${expanded.has(nodeId(row)) ? '閉じる' : '開く'}`"
                @click="toggleExpand(row)"
              >
                <ChevronDown v-if="expanded.has(nodeId(row))" class="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                <ChevronRight v-else class="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                {{ row.label }}
                <span class="text-[10px] font-normal text-muted">({{ row.children.length }})</span>
              </button>
              <span v-else :class="{ 'font-medium': row.depth === 0 }">{{ row.label }}</span>
            </td>
            <td v-for="col in columns" :key="col.id" class="px-2 py-1 text-center">
              <button
                type="button"
                class="inline-flex h-7 w-10 items-center justify-center rounded-md border transition-colors"
                :class="cellClass(col.id, row)"
                :disabled="isProtectedCell(col.id, row)"
                :aria-busy="busyCells.has(busyKey(col.id, row))"
                :aria-label="`${col.label} × ${row.label}: ${stateLabel(col.id, row)}。クリックで切替`"
                :title="stateLabel(col.id, row)"
                @click="toggleCell(col.id, row)"
              >
                <X v-if="!cellInfo(col.id, row).value" class="h-4 w-4 text-crit" aria-hidden="true" />
                <Check v-else class="h-4 w-4 text-ok" aria-hidden="true" />
                <span v-if="isProtectedCell(col.id, row)" class="ml-0.5 text-[10px] text-muted">※</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="border-t border-line px-4 py-2 text-[11px] text-muted">
      ※ 管理者（ロール列の管理者・権限ロールが管理者の個人。役職経由で該当する場合も同様）の「マスタメンテナンス」「設定」への拒否、および参照対象の本人セルはロックアウト防止のため操作できません。AI 参照範囲行は ✓ = すべて / × = 自分のみ、参照対象行は ✓ = 参照可 / × = 参照不可 を表します。マスタ項目の表示制御はページの利用可否とは独立に、アプリ全体のマスタ応答へ適用されます（ドキュメントのみページ行が項目の一括既定を兼ねます）。個々のルールの無効化・復元の履歴はルール一覧モードで確認できます
    </p>
  </UiSectionCard>
</template>
