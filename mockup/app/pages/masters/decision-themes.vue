<script setup lang="ts">
/**
 * 判断テーマ マスタ（管理者専用。監査指摘 2026-07-30 ③）
 * 意思決定支援（F-02）のテーマ（①意味 ②関係 ③制約と打ち手 → 選択肢 A/B/C）を作成・編集する。
 * 従来はシード 3 テーマ固定で編集 UI が存在しなかった（「AI 推奨」等の分析コンテンツが静的なまま
 * 増やせない状態）の是正。書込は汎用マスタ CRUD（/v1/masters/decision-themes）= 既存経路の再利用（原則3）。
 * シナリオ予測の係数はテーマ固有ロジック（useDecision.predict）のため、新規テーマは汎用線形式で予測される。
 */
import { Plus, X } from 'lucide-vue-next'
import { ACTIVE_FILTER_OPTIONS, matchesActiveFilter } from '~/components/masters/MasterShell.vue'
import type { DecisionSlot, DecisionTheme } from '~/types/domain'
import type { TableColumn } from '~/types/ui'

const crud = useMasterCrudAsync('decisionThemes', 'dt')
const toast = useToast()
const confirm = useConfirm()

// ---------- 一覧 ----------

const search = ref('')
const statusFilter = ref('active')

const filtered = computed(() =>
  (crud.list.value as DecisionTheme[])
    .filter((t) => {
      if (!matchesActiveFilter(t, statusFilter.value)) return false
      const q = search.value.trim().toLowerCase()
      return !q || t.title.toLowerCase().includes(q) || t.objective.toLowerCase().includes(q)
    })
    .sort((a, b) => a.id.localeCompare(b.id)))

const columns: TableColumn[] = [
  { key: 'title', label: 'テーマ', primary: true },
  { key: 'category', label: '区分', width: '110px', primary: true },
  { key: 'options', label: '選択肢', width: '70px', align: 'right' },
  { key: 'actions', label: '打ち手', width: '70px', align: 'right' },
  { key: 'active', label: '状態', width: '90px', primary: true },
]

const tableRows = computed(() => filtered.value.map(t => ({
  id: t.id,
  title: t.title,
  category: DECISION_CATEGORY_LABELS[t.category],
  options: t.options.length,
  actions: t.actions.length,
  active: t.active !== false,
})))

// ---------- 編集フォーム（選択肢の prediction は改行区切りテキストで編集） ----------

// UiSelect は string の v-model のため、フォーム上は string で保持し保存時に enum へ正規化する
interface OptionForm {
  slot: string
  recommended: boolean
  title: string
  predictionText: string
  basis: string
}

interface ThemeForm {
  title: string
  category: string
  objective: string
  whyRecommend: string
  semantics: { key: string; value: string }[]
  links: { label: string; to: string; info: string }[]
  actions: { name: string; status: string; slot: string; why: string }[]
  options: OptionForm[]
  scenarioParams: { key: string; label: string; min: number; max: number; step: number; default: number; unit: string }[]
}

function emptyForm(): ThemeForm {
  return {
    title: '',
    category: 'business',
    objective: '',
    whyRecommend: '',
    semantics: [],
    links: [],
    actions: [],
    options: [{ slot: 'A', recommended: false, title: '', predictionText: '', basis: '' }],
    scenarioParams: [],
  }
}

const drawerOpen = ref(false)
const mode = ref<'view' | 'edit' | 'create'>('view')
const selectedId = ref<string | null>(null)
const selected = computed<DecisionTheme | null>(() =>
  selectedId.value ? ((crud.byId(selectedId.value) as DecisionTheme | undefined) ?? null) : null)
const form = ref<ThemeForm>(emptyForm())
const saving = ref(false)

const drawerTitle = computed(() =>
  mode.value === 'create' ? '判断テーマを追加' : mode.value === 'edit' ? '判断テーマを編集' : '判断テーマ詳細')

const categoryOptions = Object.entries(DECISION_CATEGORY_LABELS).map(([value, label]) => ({ value, label }))
const statusOptions = [
  { value: 'ok', label: '通過（✓）' },
  { value: 'warn', label: '要注意（△）' },
  { value: 'ng', label: '制約により不可（✗）' },
]
const slotOptions = [
  { value: 'A', label: 'A' },
  { value: 'B', label: 'B' },
  { value: 'C', label: 'C' },
]
const actionSlotOptions = [{ value: '', label: '（昇格しない）' }, ...slotOptions]

function openDetail(row: Record<string, unknown>): void {
  selectedId.value = String(row.id)
  mode.value = 'view'
  drawerOpen.value = true
}

function openCreate(): void {
  selectedId.value = null
  form.value = emptyForm()
  mode.value = 'create'
  drawerOpen.value = true
}

function openEdit(): void {
  const t = selected.value
  if (!t) return
  form.value = {
    title: t.title,
    category: t.category,
    objective: t.objective,
    whyRecommend: t.whyRecommend,
    semantics: t.semantics.map(s => ({ ...s })),
    links: t.links.map(l => ({ ...l })),
    actions: t.actions.map(a => ({ ...a, slot: a.slot ?? '' })),
    options: t.options.map(o => ({
      slot: o.slot, recommended: o.recommended, title: o.title,
      predictionText: o.prediction.join('\n'), basis: o.basis,
    })),
    scenarioParams: t.scenarioParams.map(p => ({ ...p })),
  }
  mode.value = 'edit'
}

function cancelEdit(): void {
  if (mode.value === 'edit') mode.value = 'view'
  else drawerOpen.value = false
}

// ---------- 行の追加・削除 ----------

function addSemantic(): void {
  form.value.semantics.push({ key: '', value: '' })
}
function addLink(): void {
  form.value.links.push({ label: '', to: '', info: '' })
}
function addAction(): void {
  form.value.actions.push({ name: '', status: 'ok', slot: '', why: '' })
}
function addOption(): void {
  const used = new Set(form.value.options.map(o => o.slot))
  const next = ['A', 'B', 'C'].find(s => !used.has(s))
  if (!next) {
    toast.show('選択肢は A / B / C の 3 件までです', 'warn')
    return
  }
  form.value.options.push({ slot: next, recommended: false, title: '', predictionText: '', basis: '' })
}
function addParam(): void {
  form.value.scenarioParams.push({ key: '', label: '', min: 0, max: 100, step: 1, default: 50, unit: '' })
}

async function save(): Promise<void> {
  const f = form.value
  if (!f.title.trim()) {
    toast.show('AKO-GEN-001: テーマ名を入力してください', 'crit')
    return
  }
  const opts = f.options.filter(o => o.title.trim())
  if (opts.length === 0) {
    toast.show('AKO-GEN-001: 選択肢（タイトル）を 1 つ以上入力してください', 'crit')
    return
  }
  if (new Set(opts.map(o => o.slot)).size !== opts.length) {
    toast.show('AKO-GEN-001: 選択肢のスロット（A/B/C）が重複しています', 'crit')
    return
  }
  const asSlot = (v: string): DecisionSlot | null => (v === 'A' || v === 'B' || v === 'C' ? v : null)
  const payload: Partial<DecisionTheme> & { id?: string } = {
    title: f.title.trim(),
    category: f.category === 'project' ? 'project' : 'business',
    objective: f.objective.trim(),
    whyRecommend: f.whyRecommend.trim(),
    semantics: f.semantics.filter(s => s.key.trim() || s.value.trim()),
    links: f.links.filter(l => l.label.trim()),
    actions: f.actions.filter(a => a.name.trim()).map(a => ({
      name: a.name.trim(),
      status: a.status === 'warn' || a.status === 'ng' ? a.status : 'ok',
      slot: asSlot(a.slot),
      why: a.why.trim(),
    })),
    options: opts.map(o => ({
      slot: asSlot(o.slot) ?? 'A',
      recommended: o.recommended,
      title: o.title.trim(),
      prediction: o.predictionText.split('\n').map(s => s.trim()).filter(Boolean),
      basis: o.basis.trim(),
    })),
    scenarioParams: f.scenarioParams
      .filter(p => p.key.trim() && p.label.trim())
      .map(p => ({
        ...p, min: Number(p.min) || 0, max: Number(p.max) || 0,
        step: Number(p.step) || 1, default: Number(p.default) || 0,
      })),
  }
  if (mode.value === 'edit' && selectedId.value) payload.id = selectedId.value
  saving.value = true
  const res = await crud.save(payload)
  saving.value = false
  if (!res.ok) {
    toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  toast.show(mode.value === 'create' ? '判断テーマを追加しました' : '判断テーマを更新しました')
  if (res.id) selectedId.value = res.id
  mode.value = 'view'
}

async function archiveSelected(): Promise<void> {
  if (!selected.value) return
  const ok = await confirm.ask(
    '判断テーマの無効化',
    `「${selected.value.title}」を無効化しますか？（意思決定支援の一覧から外れます。判断履歴は保持され、あとから復元できます）`,
    { danger: true, confirmLabel: '無効化' },
  )
  if (!ok) return
  const res = await crud.archive(selected.value.id)
  if (res.ok) toast.show('無効化しました', 'warn')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}

async function restoreSelected(): Promise<void> {
  if (!selected.value) return
  const res = await crud.restore(selected.value.id)
  if (res.ok) toast.show('復元しました')
  else toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
}
</script>

<template>
  <MastersMasterShell
    title="判断テーマ"
    description="意思決定支援のテーマを管理します（①意味 ②関係 ③制約と打ち手 → 選択肢 A/B/C・推奨理由）。シナリオ予測は登録したパラメータ定義から汎用線形式で計算されます"
  >
    <template #actions>
      <button type="button" class="btn btn-primary" @click="openCreate">
        <Plus class="h-4 w-4" aria-hidden="true" />
        新規追加
      </button>
    </template>

    <template #filter>
      <UiSearchInput v-model="search" placeholder="テーマ名・目的で検索" />
      <UiSelect v-model="statusFilter" :options="ACTIVE_FILTER_OPTIONS" aria-label="状態フィルタ" />
    </template>

    <UiSectionCard :title="`判断テーマ一覧（${filtered.length}件）`" flush>
      <UiDataTable
        :columns="columns"
        :rows="tableRows"
        clickable
        empty-title="判断テーマがまだありません"
        empty-hint="「新規追加」からテーマを登録すると、意思決定支援に表示されます"
        @row-click="openDetail"
      >
        <template #cell-active="{ value }">
          <UiStatusBadge :label="value ? '有効' : '無効'" :tone="value ? 'ok' : 'neutral'" dot />
        </template>
      </UiDataTable>
    </UiSectionCard>

    <template #drawer>
      <UiDrawer :open="drawerOpen" :title="drawerTitle" width="640px" @close="drawerOpen = false">
        <!-- 詳細表示 -->
        <div v-if="mode === 'view' && selected" class="grid gap-3 text-[13px]">
          <div class="flex items-center gap-2">
            <UiStatusBadge :label="DECISION_CATEGORY_LABELS[selected.category]" :tone="DECISION_CATEGORY_TONES[selected.category]" />
            <UiStatusBadge :label="selected.active !== false ? '有効' : '無効'" :tone="selected.active !== false ? 'ok' : 'neutral'" dot />
          </div>
          <h2 class="text-[15px] font-bold">{{ selected.title }}</h2>
          <p class="text-sub">{{ selected.objective || '—' }}</p>
          <div>
            <p class="label">①意味（属性・KPI）</p>
            <dl v-if="selected.semantics.length > 0" class="grid gap-1">
              <div v-for="s in selected.semantics" :key="s.key" class="grid grid-cols-[140px_1fr] gap-2">
                <dt class="text-[11px] font-semibold text-muted">{{ s.key }}</dt>
                <dd>{{ s.value }}</dd>
              </div>
            </dl>
            <p v-else class="text-xs text-muted">未設定</p>
          </div>
          <div>
            <p class="label">②関係（実データへのリンク）</p>
            <ul v-if="selected.links.length > 0" class="grid gap-1">
              <li v-for="(l, i) in selected.links" :key="i">{{ l.label }}<span class="text-xs text-muted">（{{ l.to }}）{{ l.info }}</span></li>
            </ul>
            <p v-else class="text-xs text-muted">未設定</p>
          </div>
          <div>
            <p class="label">③制約と打ち手</p>
            <ul v-if="selected.actions.length > 0" class="grid gap-1">
              <li v-for="(a, i) in selected.actions" :key="i" class="flex items-start gap-2">
                <UiStatusBadge
                  :label="a.status === 'ok' ? '✓' : a.status === 'warn' ? '△' : '✗'"
                  :tone="a.status === 'ok' ? 'ok' : a.status === 'warn' ? 'warn' : 'crit'"
                />
                <span>
                  {{ a.name }}
                  <span v-if="a.slot" class="text-xs font-semibold text-brand">→ 選択肢 {{ a.slot }}</span>
                  <span v-if="a.why" class="block text-xs text-muted">{{ a.why }}</span>
                </span>
              </li>
            </ul>
            <p v-else class="text-xs text-muted">未設定</p>
          </div>
          <div>
            <p class="label">選択肢</p>
            <ul class="grid gap-2">
              <li v-for="o in selected.options" :key="o.slot" class="rounded-lg border border-line p-2.5">
                <p class="font-semibold">
                  {{ o.slot }}: {{ o.title }}
                  <UiStatusBadge v-if="o.recommended" label="★ 推奨" tone="brand" />
                </p>
                <ul v-if="o.prediction.length > 0" class="mt-1 grid gap-0.5 text-xs text-sub">
                  <li v-for="(p, i) in o.prediction" :key="i">・{{ p }}</li>
                </ul>
                <p v-if="o.basis" class="mt-1 text-xs text-muted">根拠: {{ o.basis }}</p>
              </li>
            </ul>
          </div>
          <div v-if="selected.whyRecommend">
            <p class="label">推奨理由</p>
            <p class="whitespace-pre-wrap rounded-lg border border-line bg-surface-soft p-2.5 text-xs">{{ selected.whyRecommend }}</p>
          </div>
          <div>
            <p class="label">シナリオ比較パラメータ</p>
            <ul v-if="selected.scenarioParams.length > 0" class="grid gap-1 text-xs">
              <li v-for="p in selected.scenarioParams" :key="p.key" class="num">
                {{ p.label }}（{{ p.key }}）: {{ p.min }}〜{{ p.max }} / step {{ p.step }} / 既定 {{ p.default }}{{ p.unit }}
              </li>
            </ul>
            <p v-else class="text-xs text-muted">未設定（シナリオ比較は表示されません）</p>
          </div>
        </div>

        <!-- 編集フォーム -->
        <div v-else class="grid gap-4">
          <div class="grid gap-3 md:grid-cols-2">
            <UiFormField label="区分" required>
              <UiSelect v-model="form.category" :options="categoryOptions" aria-label="区分" class="!w-full" />
            </UiFormField>
            <UiFormField label="テーマ名" required class="md:col-span-1">
              <input v-model="form.title" type="text" class="input" placeholder="例）新規サービスの価格改定">
            </UiFormField>
          </div>
          <UiFormField label="目的">
            <textarea v-model="form.objective" class="textarea" rows="2" placeholder="このテーマで何を判断したいか" />
          </UiFormField>

          <UiFormField label="①意味（属性・KPI）" hint="キーと値のペアで現状を整理します">
            <div v-for="(s, i) in form.semantics" :key="i" class="mb-1.5 flex gap-2">
              <input v-model="s.key" type="text" class="input w-40" placeholder="キー（例: 月間売上）" :aria-label="`意味キー ${i + 1}`">
              <input v-model="s.value" type="text" class="input flex-1" placeholder="値（例: ¥220万）" :aria-label="`意味値 ${i + 1}`">
              <button type="button" class="btn btn-sm" aria-label="行を削除" @click="form.semantics.splice(i, 1)"><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
            </div>
            <button type="button" class="btn btn-sm" @click="addSemantic"><Plus class="h-3.5 w-3.5" aria-hidden="true" />行を追加</button>
          </UiFormField>

          <UiFormField label="②関係（実データへのリンク）" hint="関連するマスタ・画面へのリンク（to は /masters/customers 等のパス）">
            <div v-for="(l, i) in form.links" :key="i" class="mb-1.5 flex gap-2">
              <input v-model="l.label" type="text" class="input w-40" placeholder="ラベル" :aria-label="`関係ラベル ${i + 1}`">
              <input v-model="l.to" type="text" class="input w-44" placeholder="/masters/customers" :aria-label="`関係リンク先 ${i + 1}`">
              <input v-model="l.info" type="text" class="input flex-1" placeholder="補足" :aria-label="`関係補足 ${i + 1}`">
              <button type="button" class="btn btn-sm" aria-label="行を削除" @click="form.links.splice(i, 1)"><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
            </div>
            <button type="button" class="btn btn-sm" @click="addLink"><Plus class="h-3.5 w-3.5" aria-hidden="true" />行を追加</button>
          </UiFormField>

          <UiFormField label="③制約と打ち手" hint="制約チェックの結果（✓/△/✗）と、通過した打ち手の選択肢への昇格先">
            <div v-for="(a, i) in form.actions" :key="i" class="mb-2 grid gap-1.5 rounded-lg border border-line p-2">
              <div class="flex gap-2">
                <input v-model="a.name" type="text" class="input flex-1" placeholder="打ち手（例: 値上げ + 機能追加）" :aria-label="`打ち手名 ${i + 1}`">
                <button type="button" class="btn btn-sm" aria-label="行を削除" @click="form.actions.splice(i, 1)"><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
              </div>
              <div class="flex flex-wrap gap-2">
                <UiSelect v-model="a.status" :options="statusOptions" :aria-label="`打ち手判定 ${i + 1}`" />
                <UiSelect v-model="a.slot" :options="actionSlotOptions" :aria-label="`昇格先スロット ${i + 1}`" />
                <input v-model="a.why" type="text" class="input flex-1" placeholder="判定理由（✗ の場合は必ず）" :aria-label="`判定理由 ${i + 1}`">
              </div>
            </div>
            <button type="button" class="btn btn-sm" @click="addAction"><Plus class="h-3.5 w-3.5" aria-hidden="true" />打ち手を追加</button>
          </UiFormField>

          <UiFormField label="選択肢（A/B/C）" required hint="予測は 1 行 1 項目で入力します">
            <div v-for="(o, i) in form.options" :key="i" class="mb-2 grid gap-1.5 rounded-lg border border-line p-2">
              <div class="flex flex-wrap items-center gap-2">
                <UiSelect v-model="o.slot" :options="slotOptions" :aria-label="`選択肢スロット ${i + 1}`" />
                <label class="flex items-center gap-1 text-xs font-semibold">
                  <input v-model="o.recommended" type="checkbox" class="checkbox"> ★ 推奨
                </label>
                <button type="button" class="btn btn-sm ml-auto" aria-label="選択肢を削除" @click="form.options.splice(i, 1)"><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
              </div>
              <input v-model="o.title" type="text" class="input" placeholder="選択肢のタイトル" :aria-label="`選択肢タイトル ${i + 1}`">
              <textarea v-model="o.predictionText" class="textarea" rows="2" placeholder="予測（1 行 1 項目）" :aria-label="`選択肢の予測 ${i + 1}`" />
              <input v-model="o.basis" type="text" class="input" placeholder="根拠" :aria-label="`選択肢の根拠 ${i + 1}`">
            </div>
            <button type="button" class="btn btn-sm" :disabled="form.options.length >= 3" @click="addOption">
              <Plus class="h-3.5 w-3.5" aria-hidden="true" />選択肢を追加
            </button>
          </UiFormField>

          <UiFormField label="推奨理由" hint="★ 推奨を付けた選択肢を推す理由（画面に「AI が推奨する理由」として表示されます）">
            <textarea v-model="form.whyRecommend" class="textarea" rows="3" />
          </UiFormField>

          <UiFormField label="シナリオ比較パラメータ" hint="スライダーで動かす変数の定義（未設定ならシナリオ比較は非表示）">
            <div v-for="(p, i) in form.scenarioParams" :key="i" class="mb-2 grid gap-1.5 rounded-lg border border-line p-2">
              <div class="flex gap-2">
                <input v-model="p.key" type="text" class="input w-36" placeholder="キー（半角英数）" :aria-label="`パラメータキー ${i + 1}`">
                <input v-model="p.label" type="text" class="input flex-1" placeholder="表示ラベル" :aria-label="`パラメータラベル ${i + 1}`">
                <input v-model="p.unit" type="text" class="input w-20" placeholder="単位" :aria-label="`パラメータ単位 ${i + 1}`">
                <button type="button" class="btn btn-sm" aria-label="行を削除" @click="form.scenarioParams.splice(i, 1)"><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
              </div>
              <div class="flex flex-wrap items-center gap-2 text-xs">
                <label class="flex items-center gap-1">最小 <input v-model.number="p.min" type="number" class="input num w-20" :aria-label="`最小値 ${i + 1}`"></label>
                <label class="flex items-center gap-1">最大 <input v-model.number="p.max" type="number" class="input num w-20" :aria-label="`最大値 ${i + 1}`"></label>
                <label class="flex items-center gap-1">刻み <input v-model.number="p.step" type="number" class="input num w-20" :aria-label="`刻み ${i + 1}`"></label>
                <label class="flex items-center gap-1">既定 <input v-model.number="p.default" type="number" class="input num w-20" :aria-label="`既定値 ${i + 1}`"></label>
              </div>
            </div>
            <button type="button" class="btn btn-sm" @click="addParam"><Plus class="h-3.5 w-3.5" aria-hidden="true" />パラメータを追加</button>
          </UiFormField>
        </div>

        <template #footer>
          <div v-if="mode === 'view' && selected" class="flex items-center justify-between gap-2">
            <button v-if="selected.active !== false" type="button" class="btn btn-danger btn-sm" @click="archiveSelected">無効化</button>
            <button v-else type="button" class="btn btn-sm" @click="restoreSelected">復元</button>
            <button type="button" class="btn btn-primary" @click="openEdit">編集</button>
          </div>
          <div v-else class="flex items-center justify-end gap-2">
            <button type="button" class="btn" @click="cancelEdit">キャンセル</button>
            <button type="button" class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
          </div>
        </template>
      </UiDrawer>
    </template>
  </MastersMasterShell>
</template>
