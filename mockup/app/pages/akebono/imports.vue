<script setup lang="ts">
/**
 * F-32 データ取込・連携（管理者専用）
 * 取込元（CSV/固定長/JSON/API）・項目マッピング（方式別に取込元を解析して左辺を生成し、右辺=対象アプリの
 * 有効項目〔既定+カスタム〕へ対応づけ・版管理）・取込実行（ステージング → 検証 → 反映。冪等・エラー行隔離）。
 * API モードは**実取込**（監査指摘 2026-07-30 ①）: ファイル方式は添付を、API 方式はサーバーの
 * SSRF ガード付き pull を材料に、対象テーブルへ実反映する。モックは実行をシミュレートし履歴のみ残す。
 */
import { FileUp, Plus, Play, RotateCcw, Trash2, Upload } from 'lucide-vue-next'
import {
  IMPORT_METHOD_LABELS, IMPORT_ENTITY_LABELS,
} from '~/composables/useAkebonoImports'
import type { ImportMapping, ImportRun, ImportSource, ImportSourceConfig } from '~/types/akebono'
import { SEGMENT_SCOPED_IMPORT_ENTITIES } from '~/types/akebono'
import type { FieldDef, TableColumn } from '~/types/ui'
import { importRefTargetOf, VARIANT_IMPORT_FIELDS } from '~/utils/import-link'
import type { ImportRefTarget } from '~/utils/import-link'
import { masterImportDefOf } from '~/utils/import-master'
import { parseCsvColumns, extractJsonKeys } from '~/utils/import-parse'
import { IMPORT_TRANSFORMS } from '~/utils/import-run'
import { fmtDateTime, fmtInt } from '~/utils/format'

const imp = useAkebonoImports()
const sheets = useSheetsImport()
const toast = useToast()
const confirm = useConfirm()
const isApi = useApiMode()
const route = useRoute()
const router = useRouter()

// Google スプレッドシート連携のコールバック（sheets.ts が /akebono/imports?sheets=connected|error へ戻す）
onMounted(async () => {
  const s = route.query.sheets
  if (s === 'connected') {
    await sheets.refreshStatus()
    toast.show('Google スプレッドシートに連携しました', 'ok')
  } else if (s === 'error') {
    toast.show(`Google スプレッドシートの連携に失敗しました（${String(route.query.reason ?? '不明')}）`, 'crit')
  }
  if (s) router.replace({ query: { ...route.query, sheets: undefined, reason: undefined } })
  // 共通マスタ管理からの導線（/akebono/masters →「マスタ取込元を追加」）: 追加モーダルをマスタ向けに開く
  if (route.query.add === 'master') {
    if (imp.isAdmin.value) openAdd('master')
    router.replace({ query: { ...route.query, add: undefined } })
  }
  // 取込元を指定して開く導線（マスタ一覧の各取込元カード → その取込元を選択状態にする）
  if (typeof route.query.source === 'string' && imp.sourceById(route.query.source)) {
    selectedSourceId.value = route.query.source
    router.replace({ query: { ...route.query, source: undefined } })
  }
})

// ---------- 取込元一覧 ----------

const selectedSourceId = ref<string | null>(null)
const selectedSource = computed<ImportSource | null>(() =>
  selectedSourceId.value ? (imp.sourceById(selectedSourceId.value) ?? null) : null,
)

// 無効化（archive）済みを表示するトグル。既定は有効のみ（原則9.5 = 取消済みも復元導線で見える）
const showArchived = ref(false)
const sourceRows = computed(() =>
  (showArchived.value ? imp.sources.value : imp.activeSources.value) as unknown as Record<string, unknown>[],
)

const sourceColumns = computed<TableColumn[]>(() => [
  { key: 'name', label: '名称', primary: true },
  { key: 'method', label: '方式', primary: true },
  { key: 'targetEntity', label: '対象', primary: true },
  { key: 'active', label: '状態' },
  ...(imp.isAdmin.value ? [{ key: 'actions', label: '操作' } as TableColumn] : []),
])

function asSource(row: Record<string, unknown>): ImportSource {
  return row as unknown as ImportSource
}

function selectSource(row: Record<string, unknown>): void {
  selectedSourceId.value = String(row.id)
}

// 取込元の無効化 / 復元（原則9.5 = 誤登録を UI から取り消せる）
async function archiveSource(row: Record<string, unknown>): Promise<void> {
  const s = asSource(row)
  if (!await confirm.ask('取込元を無効化', `「${s.name}」を無効化します。実行履歴は残ります。復元は「無効も表示」から行えます。`, { confirmLabel: '無効化', danger: true })) return
  const res = await imp.archiveSource(s.id)
  if (!res.ok) { toast.show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  toast.show('取込元を無効化しました', 'ok')
  if (selectedSourceId.value === s.id) selectedSourceId.value = null
}
async function restoreSource(row: Record<string, unknown>): Promise<void> {
  const s = asSource(row)
  const res = await imp.restoreSource(s.id)
  if (!res.ok) { toast.show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  toast.show('取込元を復元しました', 'ok')
}

// ---------- 取込元を追加（モーダル） ----------

const addOpen = ref(false)
const addForm = ref<Record<string, unknown>>({})
const addErrors = ref<Record<string, string>>({})

const masters = useAkebonoMasters()

/** 選択中の取込対象がセグメントを取込元単位で持つか（= 事業セグメント選択欄を出す） */
const addNeedsSegment = computed(() =>
  SEGMENT_SCOPED_IMPORT_ENTITIES.includes(addForm.value.targetEntity as ImportSource['targetEntity']))

// 取込対象は「記録系」→「共通マスタ」の順で並べる（マスタは import-master のラベルに "マスタ: " 接頭辞あり）
const addFields = computed<FieldDef[]>(() => {
  const base: FieldDef[] = [
    { key: 'name', label: '取込元名', type: 'text', required: true, placeholder: '例）本社売上 CSV（日次）' },
    {
      key: 'method', label: '取込方式', type: 'select', required: true,
      options: (Object.keys(IMPORT_METHOD_LABELS) as (keyof typeof IMPORT_METHOD_LABELS)[])
        .map(k => ({ value: k, label: IMPORT_METHOD_LABELS[k] })),
    },
    {
      key: 'encoding', label: '文字コード', type: 'select', required: true,
      options: [{ value: 'utf8', label: 'UTF-8' }, { value: 'sjis', label: 'Shift_JIS' }],
      hint: 'API 接続の場合も応答本文の文字コードを指定します',
    },
    {
      key: 'targetEntity', label: '取込対象', type: 'select', required: true,
      options: (Object.keys(IMPORT_ENTITY_LABELS) as (keyof typeof IMPORT_ENTITY_LABELS)[])
        .map(k => ({ value: k, label: IMPORT_ENTITY_LABELS[k] })),
    },
  ]
  // 事業セグメントは取込元単位（オペレーター指示 2026-08-09）。セグメントを持つ取込対象でのみ選択させ、
  // 配下の全マッピング定義で共通適用する（マッピング右辺の列取込からは外す）
  if (addNeedsSegment.value) {
    base.push({
      key: 'segmentId', label: '事業セグメント', type: 'select', required: true,
      options: masters.segmentOptions.value,
      hint: 'この取込元で取り込む行に共通で適用します（各マッピングで列指定は不要）',
    })
  }
  return base
})

function openAdd(scope?: 'master'): void {
  // マスタ導線からは既定の取込対象を共通マスタ（事業セグメント）にする
  const targetEntity = scope === 'master' ? 'master_segment' : 'product'
  addForm.value = { name: '', method: 'file_csv', encoding: 'utf8', targetEntity, segmentId: '' }
  addErrors.value = {}
  addOpen.value = true
}

const addBusy = ref(false)
async function submitAdd(): Promise<void> {
  const e: Record<string, string> = {}
  if (!String(addForm.value.name ?? '').trim()) e.name = '取込元名は必須です'
  if (addNeedsSegment.value && !String(addForm.value.segmentId ?? '').trim()) e.segmentId = '事業セグメントを選択してください'
  addErrors.value = e
  if (Object.keys(e).length > 0) {
    toast.show('必須項目を入力してください', 'crit')
    return
  }
  if (addBusy.value) return
  addBusy.value = true
  try {
    const res = await imp.addSource({
      name: String(addForm.value.name ?? ''),
      method: addForm.value.method as ImportSource['method'],
      encoding: addForm.value.encoding as ImportSource['encoding'],
      targetEntity: addForm.value.targetEntity as ImportSource['targetEntity'],
      segmentId: addNeedsSegment.value ? String(addForm.value.segmentId ?? '') : null,
    })
    if (!res.ok) {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    toast.show('取込元を追加しました', 'ok')
    addOpen.value = false
    if (res.id) selectedSourceId.value = res.id
  } finally { addBusy.value = false }
}

// ---------- マッピング ----------

const mappingRows = computed<ImportMapping[]>(() =>
  selectedSourceId.value ? imp.mappingsOf(selectedSourceId.value) : [],
)
const mappingTableRows = computed(() =>
  mappingRows.value as unknown as Record<string, unknown>[],
)
const mappingColumns: TableColumn[] = [
  { key: 'version', label: '版', align: 'right', width: '70px', primary: true },
  { key: 'status', label: '状態', primary: true },
  { key: 'fieldCount', label: '項目数', align: 'right', primary: true },
]
function asMapping(row: Record<string, unknown>): ImportMapping {
  return row as unknown as ImportMapping
}

const MAPPING_STATUS: Record<ImportMapping['status'], { label: string; tone: 'ok' | 'neutral' | 'info' }> = {
  active: { label: '有効', tone: 'ok' },
  draft: { label: '下書き', tone: 'info' },
  superseded: { label: '旧版', tone: 'neutral' },
}

// ---------- マッピング編集（方式別。左辺=取込元・右辺=アプリ項目〔既定+カスタム〕） ----------
const { appFields, builtinResolved } = useAppFields()

// company（取引先）取込は Akebono カタログを持たないため CRM 会社項目へフォールバック（§44-6）。
// キーは companies マスタの実項目に一致させる（実取込の反映先。旧 email/phone 等は実列が無く反映不能だった）。
// partnerRoles = 取引ロール（複数可。キー〔customer 等〕/和名〔得意先 等〕を / 等の区切りで列挙 = parsePartnerRoles。2026-08-17）
const COMPANY_IMPORT_FIELDS: { key: string; label: string }[] = [
  { key: 'name', label: '会社名' }, { key: 'kind', label: '区分（self/customer）' },
  { key: 'partnerRoles', label: '取引ロール（複数可・/区切り）' }, { key: 'industryId', label: '業界' },
  { key: 'size', label: '規模' }, { key: 'location', label: '所在地' }, { key: 'description', label: '備考' },
]
/**
 * 取込対象の項目カタログ（マッピングの左辺 = 固定行。オペレーター指示 2026-08-09 ①）。
 * 「取込対象に設定された項目」を列挙し、各項目に対して取込元のどの列/キーを割り当てるかを右辺で設定する。
 * - 標準エンティティ（商品/SKU/売上明細/在庫）: 有効な既定項目＋カスタム項目（appFields）
 * - company: CRM 会社項目＋会社カスタム項目 / product_variant: バリアント軸カタログ＋商品カスタム項目
 * - master_*: 共通マスタ取込カタログ（import-master。#14 = 空ドロップダウンの是正）
 * 事業セグメントは取込元単位で共通適用するため、取込元にセグメント設定済みなら列マッピングから外す（#12）。
 */
interface TargetField { key: string; label: string; required: boolean; isRef: boolean }

const targetFields = computed<TargetField[]>(() => {
  const ent = selectedSource.value?.targetEntity
  if (!ent) return []
  let fields: { key: string; label: string; required: boolean }[]
  const mdef = masterImportDefOf(ent)
  if (mdef) {
    fields = mdef.fields.map(f => ({ key: f.key, label: f.label, required: f.key === 'name' || Boolean(f.requiredOnCreate) }))
  } else if (ent === 'company') {
    const builtins = COMPANY_IMPORT_FIELDS.map(f => ({ key: f.key, label: f.label, required: f.key === 'name' }))
    const customs = appFields('company').filter(f => f.source === 'custom').map(f => ({ key: f.key, label: `${f.label}（カスタム）`, required: f.required }))
    fields = [...builtins, ...customs]
  } else if (ent === 'product_variant') {
    // 商品カタログのラベル差分（テナントのリネーム。例: 既定仕入先→作家）を商品レベル項目へ反映する。
    // code は SKU 固有 ID（商品コードではない）ため、商品カタログの code ラベルで上書きしない。
    const productLabel = new Map(builtinResolved('product').map(r => [r.itemKey, r.labelDisplay]))
    const builtins = VARIANT_IMPORT_FIELDS.map(f => ({
      key: f.key,
      label: f.key !== 'code' && productLabel.has(f.key) ? productLabel.get(f.key)! : f.label,
      required: f.key === 'productCode' || f.key === 'code',
    }))
    const customs = appFields('product').filter(f => f.source === 'custom').map(f => ({ key: f.key, label: `${f.label}（カスタム・商品）`, required: false }))
    fields = [...builtins, ...customs]
  } else {
    fields = appFields(ent).map(f => ({ key: f.key, label: f.source === 'custom' ? `${f.label}（カスタム）` : f.label, required: f.required }))
  }
  // 事業セグメントは取込元単位で共通適用（取込元にセグメント設定済みなら列マッピングからは外す）
  if (selectedSource.value?.segmentId) fields = fields.filter(f => f.key !== 'segmentId')
  return fields.map(f => ({ ...f, isRef: importRefTargetOf(ent, f.key) != null }))
})

// ---------- マスタ間連携キー（突合キー。参照項目の右辺を選ぶと連携キー選択を表示） ----------

/** 参照項目の突合先（取込対象 × 対象項目 → 参照先マスタ）。null = 参照項目ではない */
function refTargetOf(itemKey: string): ImportRefTarget | null {
  const ent = selectedSource.value?.targetEntity
  return ent ? importRefTargetOf(ent, itemKey) : null
}

/** 突合キーの選択肢（参照先マスタの項目＋取引先はカスタム項目も可） */
function lookupOptionsOf(itemKey: string): { value: string; label: string }[] {
  const t = refTargetOf(itemKey)
  if (!t) return []
  const opts: { value: string; label: string }[] = [...t.fields]
  if (t.allowCustom && t.refEntity === 'company') {
    for (const f of appFields('company').filter(x => x.source === 'custom')) {
      opts.push({ value: f.key, label: `${f.label}（カスタム）` })
    }
  }
  return opts
}

/** 既定解決の表示名（SKU は ID → SKU コード・他マスタは ID → 名称） */
function defaultLookupLabel(itemKey: string): string {
  return refTargetOf(itemKey)?.refEntity === 'sku' ? '既定（ID → SKUコードの自動判定）' : '既定（ID → 名称の自動判定）'
}

/** 変換の説明（選択中の値のツールチップ。カタログ外 = 旧設定の自由入力値は素通し挙動を明示） */
function transformHint(value: string): string {
  return IMPORT_TRANSFORMS.find(t => t.value === value)?.hint
    ?? '旧設定の値です（未対応の変換名は「変換なし」と同じ挙動 = 前後の空白のみ除去）'
}

/**
 * マッピング行（取込対象基準 = 左辺は固定の対象項目、右辺で取込元の列/キーを割り当てる）。
 * sourceField 空 = 未マッピング（保存対象外）。columnIndex は CSV/Sheets の検出列に一致すれば保持
 * （ヘッダ無し CSV の位置指定を失わない）、手入力は null = 実行時にヘッダ名で解決。
 */
type MapDraftRow = {
  targetItemKey: string; targetLabel: string; required: boolean; isRef: boolean
  sourceField: string; transform: string
  columnIndex: number | null; byteStart: number | null; byteEnd: number | null
  /** 参照項目の突合キー（null = 既定の ID → 名称/コード解決） */
  lookupField: string | null
}

const mapOpen = ref(false)
const mapDraft = ref<MapDraftRow[]>([])
// 取込元の解析で検出した列（CSV/Sheets）・キー（JSON/API）。右辺の候補（datalist）＋列番号解決に使う
const detectedColumns = ref<{ name: string; index: number }[]>([])
const detectedKeys = ref<string[]>([])
const mapMethod = computed(() => selectedSource.value?.method ?? 'file_csv')

/** 検出済み列名 → 列番号（ヘッダ無し CSV の位置解決用。未検出・不一致は null = ヘッダ名で解決） */
function columnIndexOf(name: string): number | null {
  return detectedColumns.value.find(c => c.name === name)?.index ?? null
}

/** 対象項目 1 行へ取込元を割り当てる draft を作る（保存済みマッピングの復元にも使う） */
function draftRowOf(tf: TargetField, saved?: ImportMapping['fields'][number]): MapDraftRow {
  return {
    targetItemKey: tf.key, targetLabel: tf.label, required: tf.required, isRef: tf.isRef,
    sourceField: saved?.sourceField ?? '', transform: saved?.transform ?? '',
    columnIndex: saved?.columnIndex ?? null, byteStart: saved?.byteStart ?? null, byteEnd: saved?.byteEnd ?? null,
    lookupField: saved?.lookupField ?? null,
  }
}

/** 対象項目の固定行に、保存済みマッピングの割当（sourceField/ロケータ/変換/突合キー）を重ねて draft を作る */
function buildMapDraft(): void {
  const active = imp.activeMappingOf(selectedSource.value?.id ?? '')
  const savedByKey = new Map((active?.fields ?? []).map(f => [f.targetItemKey, f]))
  mapDraft.value = targetFields.value.map(tf => draftRowOf(tf, savedByKey.get(tf.key)))
}

// 対象項目が後から増える場合（API モードでカスタム項目が遅延ハイドレーションする等）、編集中の入力を
// 保ったまま新規の対象項目行を追加する（固定行スナップショット化で失われた候補追従を復元 = レビュー MINOR-4）。
watch(targetFields, (tfs) => {
  if (!mapOpen.value) return
  const have = new Set(mapDraft.value.map(r => r.targetItemKey))
  const active = imp.activeMappingOf(selectedSource.value?.id ?? '')
  const savedByKey = new Map((active?.fields ?? []).map(f => [f.targetItemKey, f]))
  const additions = tfs.filter(tf => !have.has(tf.key)).map(tf => draftRowOf(tf, savedByKey.get(tf.key)))
  if (additions.length > 0) mapDraft.value = [...mapDraft.value, ...additions]
})

/** CSV/Sheets の右辺入力変更時: 検出列に一致すれば列番号を追随、未検出時は保存済みの列番号を保持 */
function onCsvSourceInput(r: MapDraftRow): void {
  if (detectedColumns.value.length > 0) r.columnIndex = columnIndexOf(r.sourceField.trim())
}

/** 検出した取込元列/キーを、名称一致する対象項目へ自動割当（論理名 = 対象ラベル or キーの完全一致） */
function autoAssignDetected(): void {
  const norm = (s: string): string => s.trim().toLowerCase()
  for (const r of mapDraft.value) {
    if (r.sourceField.trim()) continue // 既に割当済みは尊重
    const hit = mapMethod.value === 'file_json' || mapMethod.value === 'api_pull'
      ? detectedKeys.value.find(k => norm(k) === norm(r.targetLabel) || norm(k) === norm(r.targetItemKey))
      : detectedColumns.value.find(c => norm(c.name) === norm(r.targetLabel) || norm(c.name) === norm(r.targetItemKey))?.name
    if (hit) {
      r.sourceField = hit
      if (mapMethod.value === 'file_csv' || mapMethod.value === 'sheets_pull') r.columnIndex = columnIndexOf(hit)
    }
  }
}
// 方式別設定のドラフト（CSV: hasHeader/delimiter・API: endpoint/auth・JSON/API: jsonRootPath）。
// v-model 摩擦回避のため具体型（全項目 required）。保存時に ImportSourceConfig へ渡す
const cfgDraft = ref<{
  hasHeader: boolean; delimiter: string; endpoint: string; authType: string; authValue: string; jsonRootPath: string
  spreadsheetId: string; spreadsheetName: string; sheetName: string; headerRow: number; startColumn: string
}>({
  hasHeader: true, delimiter: ',', endpoint: '', authType: 'none', authValue: '', jsonRootPath: '',
  spreadsheetId: '', spreadsheetName: '', sheetName: '', headerRow: 1, startColumn: 'A',
})
const parseText = ref('') // JSON/API 貼付
const parseError = ref('')

// Google スプレッドシート取込（sheets_pull）: 連携状態・ブック検索/一覧・タブ一覧
const sheetsSearch = ref('')
const sheetsList = ref<{ id: string; name: string }[]>([])
const sheetsTabs = ref<string[]>([])
const sheetsBusy = ref(false)

const AUTH_TYPE_OPTIONS = [
  { value: 'none', label: '認証なし' }, { value: 'bearer', label: 'Bearer トークン' },
  { value: 'api_key', label: 'API キー' }, { value: 'basic', label: 'Basic 認証' },
]

/** マッピング行のグリッド列（左辺 = 対象項目〔固定〕→ 右辺 = 取込元の割当。方式で右辺の列数が異なる） */
const rowGridClass = computed(() => {
  // minmax(0, Nfr) で min-content 拡張を抑止（長いラベルが列幅を支配しないように = 切詰め表示）
  switch (mapMethod.value) {
    case 'file_fixed': return 'grid-cols-[minmax(0,1.1fr)_16px_64px_64px_minmax(0,1fr)_minmax(0,0.8fr)]'
    default: return 'grid-cols-[minmax(0,1.1fr)_16px_minmax(0,1.3fr)_minmax(0,0.8fr)]'
  }
})

/** マッピング済み（取込元を割り当てた）対象項目の件数（未割当の必須項目の警告表示に使う） */
const mappedCount = computed(() =>
  mapDraft.value.filter(f => mapMethod.value === 'file_fixed' ? (f.byteStart != null && f.byteEnd != null) : f.sourceField.trim()).length,
)
/** 取込元未割当の必須対象項目（保存はできるが実行時に隔離される旨を事前提示） */
const unmappedRequired = computed(() =>
  mapDraft.value.filter(f => f.required && !(mapMethod.value === 'file_fixed' ? (f.byteStart != null && f.byteEnd != null) : f.sourceField.trim())),
)

async function openMapEditor(): Promise<void> {
  const src = selectedSource.value
  if (!src) return
  cfgDraft.value = {
    hasHeader: src.config?.hasHeader ?? true, delimiter: src.config?.delimiter ?? ',',
    endpoint: src.config?.endpoint ?? '', authType: src.config?.authType ?? 'none',
    authValue: src.config?.authValue ?? '', jsonRootPath: src.config?.jsonRootPath ?? '',
    spreadsheetId: src.config?.spreadsheetId ?? '', spreadsheetName: src.config?.spreadsheetName ?? '',
    sheetName: src.config?.sheetName ?? '', headerRow: src.config?.headerRow ?? 1, startColumn: src.config?.startColumn ?? 'A',
  }
  parseText.value = ''
  parseError.value = ''
  sheetsSearch.value = ''
  sheetsList.value = []
  sheetsTabs.value = []
  detectedColumns.value = []
  detectedKeys.value = []
  // 左辺 = 取込対象の項目（固定）に、保存済みマッピングの割当を重ねる
  buildMapDraft()
  mapOpen.value = true
  // Sheets 方式は連携状態を取得し、設定済みブックのタブ一覧を復元（非ブロッキング = 原則4）
  if (src.method === 'sheets_pull') {
    await sheets.refreshStatus()
    if (cfgDraft.value.spreadsheetId && sheets.status.value.connected) {
      try { sheetsTabs.value = await sheets.listTabs(cfgDraft.value.spreadsheetId) } catch { /* 復元失敗は無視 */ }
    }
  }
}

// ---------- Google スプレッドシート取込（sheets_pull）の操作 ----------

/** 対象スプレッドシートを検索（名称部分一致・空で最近更新順） */
async function searchSpreadsheets(): Promise<void> {
  if (sheetsBusy.value) return
  sheetsBusy.value = true
  try {
    sheetsList.value = await sheets.listSpreadsheets(sheetsSearch.value)
    if (sheetsList.value.length === 0) toast.show('該当するスプレッドシートが見つかりませんでした', 'warn')
  } catch (e) {
    toast.show(`スプレッドシートの取得に失敗しました（${(e as Error).message}）`, 'crit')
  } finally { sheetsBusy.value = false }
}

/** ブックを選択 → タブ一覧を取得（シート選択・列検出をリセット） */
async function selectSpreadsheet(s: { id: string; name: string }): Promise<void> {
  cfgDraft.value.spreadsheetId = s.id
  cfgDraft.value.spreadsheetName = s.name
  cfgDraft.value.sheetName = ''
  sheetsTabs.value = []
  if (sheetsBusy.value) return
  sheetsBusy.value = true
  try {
    sheetsTabs.value = await sheets.listTabs(s.id)
    if (sheetsTabs.value.length > 0 && !sheetsTabs.value.includes(cfgDraft.value.sheetName)) {
      cfgDraft.value.sheetName = sheetsTabs.value[0]!
    }
  } catch (e) {
    toast.show(`シート一覧の取得に失敗しました（${(e as Error).message}）`, 'crit')
  } finally { sheetsBusy.value = false }
}

/** 開始行/列を指定して列定義（ヘッダ行の各セル）を取得 → 左辺を自動生成 */
async function detectSheetColumns(): Promise<void> {
  if (!cfgDraft.value.spreadsheetId || !cfgDraft.value.sheetName) {
    parseError.value = '対象のスプレッドシートとシートを選択してください'
    return
  }
  if (sheetsBusy.value) return
  sheetsBusy.value = true
  try {
    const cols = await sheets.detectColumns(
      cfgDraft.value.spreadsheetId, cfgDraft.value.sheetName, cfgDraft.value.headerRow, cfgDraft.value.startColumn,
    )
    if (cols.length === 0) { parseError.value = '列を検出できませんでした（開始行・開始列をご確認ください）'; return }
    // 開始列でスライス済みのため columnIndex は 0 始まり（extractCsvRecords と一致）
    detectedColumns.value = cols.map((name, i) => ({ name, index: i }))
    autoAssignDetected()
    parseError.value = ''
    toast.show(`${cols.length} 列を検出しました。各対象項目に取込元の列を割り当ててください（名称一致は自動割当済み）`, 'ok')
  } catch (e) {
    parseError.value = `列の取得に失敗しました: ${(e as Error).message}`
  } finally { sheetsBusy.value = false }
}

/** CSV アップロード → 列（index＋論理名）抽出 → 検出列に取り込み（対象項目へ名称一致で自動割当） */
async function onCsvUpload(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  // 取込元の文字コードで復号（Shift_JIS を UTF-8 で読むと列名が文字化けする = m-3）
  const enc = selectedSource.value?.encoding === 'sjis' ? 'shift_jis' : 'utf-8'
  const text = new TextDecoder(enc).decode(await file.arrayBuffer())
  input.value = '' // 同一ファイル再選択を許可
  const { columns } = parseCsvColumns(text, { hasHeader: cfgDraft.value.hasHeader ?? true, delimiter: cfgDraft.value.delimiter || ',' })
  if (columns.length === 0) { parseError.value = '列を検出できませんでした（区切り文字・ヘッダ有無をご確認ください）'; return }
  detectedColumns.value = columns.map(c => ({ name: c.name, index: c.index }))
  autoAssignDetected()
  parseError.value = ''
  toast.show(`${columns.length} 列を検出しました。各対象項目に取込元の列を割り当ててください（名称一致は自動割当済み）`, 'ok')
}

/** JSON/API: 貼付テキスト → キー抽出 → 検出キーに取り込み（対象項目へ名称一致で自動割当） */
function onJsonParse(): void {
  try {
    const { keys, recordCount } = extractJsonKeys(parseText.value, cfgDraft.value.jsonRootPath || undefined)
    if (keys.length === 0) { parseError.value = 'キーを検出できませんでした'; return }
    detectedKeys.value = keys
    autoAssignDetected()
    parseError.value = ''
    toast.show(`${keys.length} キー（${recordCount} 件）を検出しました。各対象項目に取込元のキーを割り当ててください（名称一致は自動割当済み）`, 'ok')
  } catch (e) {
    parseError.value = `JSON を解析できませんでした: ${(e as Error).message}`
  }
}

const mapBusy = ref(false)
async function saveMapping(): Promise<void> {
  const src = selectedSource.value
  if (!src) return
  const method = src.method
  // 取込元（右辺）を割り当てた対象項目のみ保存対象。固定長は開始/終了バイトの指定を割当の条件にする
  const valid = mapDraft.value.filter(f =>
    method === 'file_fixed' ? (f.byteStart != null && f.byteEnd != null) : f.sourceField.trim())
  if (valid.length === 0) {
    toast.show('取込元（列・キー・バイト範囲）を 1 項目以上割り当ててください', 'crit')
    return
  }
  // Sheets 方式は取込元（ブック・シート）の指定を必須にする（実行時 AKO-SHEETS-003 を事前に防ぐ）
  if (src.method === 'sheets_pull' && (!cfgDraft.value.spreadsheetId || !cfgDraft.value.sheetName)) {
    toast.show('対象のスプレッドシートとシートを選択してください', 'crit')
    return
  }
  if (mapBusy.value) return
  mapBusy.value = true
  try {
    // 方式別設定を先に保存（SoT → キャッシュの順 = 原則6）→ マッピング新版
    const cfgRes = await imp.updateSourceConfig(src.id, cfgDraft.value as ImportSourceConfig)
    if (!cfgRes.ok) { toast.show(`${cfgRes.error.code}: ${cfgRes.error.message}`, 'crit'); return }
    const res = await imp.saveMapping(src.id, valid.map(f => ({
      // 固定長は sourceField（項目名）任意 = 対象ラベルで補完。CSV/Sheets/JSON は入力した列名/キー
      sourceField: (f.sourceField.trim() || (method === 'file_fixed' ? f.targetLabel : '')),
      targetItemKey: f.targetItemKey, transform: f.transform.trim(),
      // 方式別ロケータのみ保持し他方式の残骸を混入させない（JSON/API は sourceField = JSON キー）
      // Sheets は開始列でスライス済みの CSV として扱うため CSV と同じ columnIndex を保持する
      columnIndex: (method === 'file_csv' || method === 'sheets_pull') ? f.columnIndex : null,
      byteStart: method === 'file_fixed' ? f.byteStart : null,
      byteEnd: method === 'file_fixed' ? f.byteEnd : null,
      jsonKey: (method === 'file_json' || method === 'api_pull') ? f.sourceField.trim() : null,
      // 突合キーは参照項目のみ保持（非参照項目の残骸を混入させない = ロケータと同じ思想）
      lookupField: f.isRef ? f.lookupField : null,
    })))
    if (!res.ok) { toast.show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
    toast.show('マッピングを新しい版として保存しました', 'ok')
    mapOpen.value = false
  } finally { mapBusy.value = false }
}

// ---------- 取込実行 ----------

const runBusy = ref(false)
/** 実取込のファイル（API モード × ファイル方式で必須。実行成功でクリア） */
const runFile = ref<File | null>(null)
const runFileInput = ref<HTMLInputElement | null>(null)
/** API モードでファイル添付が必要な取込元か */
const needsRunFile = computed(() => isApi && (selectedSource.value?.method.startsWith('file') ?? false))

function onRunFilePick(ev: Event): void {
  const input = ev.target as HTMLInputElement
  runFile.value = input.files?.[0] ?? null
  input.value = ''
}

// 取込元を切り替えたら選択済みファイルを引き継がない（別取込元への誤取込を防ぐ）
watch(selectedSourceId, () => { runFile.value = null })

async function runImport(): Promise<void> {
  if (!selectedSourceId.value || runBusy.value) return
  runBusy.value = true
  try {
    const res = await imp.runImport(selectedSourceId.value, runFile.value)
    if (!res.ok) {
      toast.show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    const run = res.runId ? imp.runsOf(selectedSourceId.value).find(r => r.id === res.runId) : undefined
    const failed = run?.counts.failed ?? 0
    const skipped = run?.counts.skipped ?? 0
    toast.show(
      `取込を実行しました（${run?.code ?? ''}）: ${run?.counts.applied ?? 0}件反映`
      + `${skipped > 0 ? ` / ${skipped}件は取込済みのためスキップ` : ''}${failed > 0 ? ` / ${failed}件を隔離` : ''}`,
      failed > 0 ? 'warn' : 'ok',
    )
    runFile.value = null
  } finally { runBusy.value = false }
}

// ---------- 実行履歴 ----------

const runRows = computed(() =>
  (selectedSourceId.value ? imp.runsOf(selectedSourceId.value) : []) as unknown as Record<string, unknown>[],
)
// クライアントページング（取込元切替で 1 ページ目へ）
const {
  page: runPage, pageSize: runPageSize, rows: runPaged, total: runTotal,
} = useListView<Record<string, unknown>>({ source: runRows, pageSize: 20 })
watch(selectedSourceId, () => { runPage.value = 1 })
const runColumns: TableColumn[] = [
  { key: 'code', label: 'コード', primary: true },
  { key: 'startedAt', label: '開始', primary: true },
  { key: 'status', label: '状態', primary: true },
  { key: 'counts', label: '件数（済/反映/失敗）', align: 'right' },
  { key: 'errorCount', label: 'エラー', align: 'right' },
]
function asRun(row: Record<string, unknown>): ImportRun {
  return row as unknown as ImportRun
}

const RUN_STATUS: Record<ImportRun['status'], { label: string; tone: 'ok' | 'warn' | 'crit' | 'info' | 'neutral' }> = {
  staged: { label: 'ステージング', tone: 'info' },
  validated: { label: '検証済', tone: 'info' },
  applied: { label: '反映済', tone: 'ok' },
  failed: { label: '失敗', tone: 'crit' },
  reverted: { label: '取消済', tone: 'neutral' },
}

// エラー明細ドロワー
const errorDrawerOpen = ref(false)
const errorRun = ref<ImportRun | null>(null)
function openRun(row: Record<string, unknown>): void {
  errorRun.value = asRun(row)
  errorDrawerOpen.value = true
}
</script>

<template>
  <MastersMasterShell
    title="データ取込・連携"
    description="外部ファイル・API から商品・取引先・売上などを取り込みます（F-32）。取込方式ごとに取込元を解析し、対象アプリの有効項目（既定＋カスタマイズ項目）へ対応づけます"
  >
    <template #actions>
      <label class="flex items-center gap-1.5 text-[12px] text-sub">
        <input v-model="showArchived" type="checkbox">無効も表示
      </label>
      <button v-if="imp.isAdmin.value" type="button" class="btn btn-primary" @click="openAdd()">
        <Plus class="h-4 w-4" aria-hidden="true" />
        取込元を追加
      </button>
    </template>

    <!-- 思想注記 -->
    <div class="card border-line bg-info-soft p-3 text-[12px] leading-relaxed text-sub">
      取込は <span class="font-semibold text-ink">ステージング → 検証 → 反映</span> の順で行い、
      マスタ未登録などの不正行は隔離して健全行のみ反映します（原則4）。同一データの再取込は冪等に扱われます
      （商品・SKU・取引先 = 上書き更新 / 売上・在庫 = 取込済み行をスキップ）。
      <template v-if="isApi">
        ファイル方式は添付ファイル（CSV/固定長/JSON・10MB 以下）を、API 接続方式はサーバーが安全確認付きで取得した
        応答を材料に、<span class="font-semibold text-ink">対象アプリのデータへ実反映</span>します。
      </template>
      <template v-else>
        モックモードでは取込実行は結果をシミュレートし、実行履歴のみを残します（実反映は API モード）。
      </template>
    </div>

    <!-- 非管理者は閲覧のみ（取込設定・実行は管理者権限。両モードで一致 = AKO-AUTH-003） -->
    <div v-if="!imp.isAdmin.value" class="card border-warn bg-warn-soft p-3 text-[12px] text-ink">
      取込元の登録・マッピング保存・取込実行は<strong>管理者のみ</strong>が行えます。ここでは設定と実行履歴を閲覧できます。
    </div>

    <!-- 取込元一覧 -->
    <UiSectionCard :title="`取込元（${sourceRows.length}件）`" flush>
      <UiDataTable
        :columns="sourceColumns"
        :rows="sourceRows"
        clickable
        empty-title="取込元がまだありません"
        empty-hint="「取込元を追加」から登録してください"
        @row-click="selectSource"
      >
        <template #cell-name="{ row }">
          <span class="font-medium" :class="{ 'text-brand': asSource(row).id === selectedSourceId }">
            {{ asSource(row).name }}
          </span>
        </template>
        <template #cell-method="{ row }">
          {{ IMPORT_METHOD_LABELS[asSource(row).method] }}
        </template>
        <template #cell-targetEntity="{ row }">
          {{ IMPORT_ENTITY_LABELS[asSource(row).targetEntity] }}
        </template>
        <template #cell-active="{ row }">
          <UiStatusBadge :label="asSource(row).active ? '有効' : '無効'" :tone="asSource(row).active ? 'ok' : 'neutral'" dot />
        </template>
        <template #cell-actions="{ row }">
          <button
            v-if="asSource(row).active"
            type="button" class="btn btn-ghost btn-sm text-crit"
            aria-label="取込元を無効化" @click.stop="archiveSource(row)"
          >
            <Trash2 class="h-4 w-4" aria-hidden="true" /> 無効化
          </button>
          <button
            v-else
            type="button" class="btn btn-ghost btn-sm"
            aria-label="取込元を復元" @click.stop="restoreSource(row)"
          >
            <RotateCcw class="h-4 w-4" aria-hidden="true" /> 復元
          </button>
        </template>
      </UiDataTable>
    </UiSectionCard>

    <!-- 選択取込元の詳細 -->
    <UiSectionCard v-if="selectedSource" :title="`${selectedSource.name} の詳細`" :description="`${IMPORT_METHOD_LABELS[selectedSource.method]} / ${IMPORT_ENTITY_LABELS[selectedSource.targetEntity]} / ${selectedSource.encoding === 'utf8' ? 'UTF-8' : 'Shift_JIS'}${selectedSource.segmentId ? ` / 事業セグメント: ${masters.segmentName(selectedSource.segmentId)}` : ''}`">
      <template v-if="imp.isAdmin.value" #actions>
        <button type="button" class="btn btn-sm" @click="openMapEditor">
          <Upload class="h-4 w-4" aria-hidden="true" />
          マッピングを設定
        </button>
        <template v-if="needsRunFile">
          <input
            ref="runFileInput"
            type="file"
            class="hidden"
            accept=".csv,.txt,.dat,.json"
            aria-label="取込ファイルを選択"
            @change="onRunFilePick"
          >
          <button type="button" class="btn btn-sm" @click="runFileInput?.click()">
            <FileUp class="h-4 w-4" aria-hidden="true" />
            {{ runFile ? runFile.name : 'ファイルを選択' }}
          </button>
        </template>
        <button
          type="button" class="btn btn-primary btn-sm"
          :disabled="runBusy || (needsRunFile && !runFile)"
          @click="runImport"
        >
          <Play class="h-4 w-4" aria-hidden="true" />
          {{ runBusy ? '実行中…' : '取込を実行' }}
        </button>
      </template>

      <div class="grid gap-4">
        <!-- マッピング版一覧 -->
        <div>
          <p class="mb-1.5 text-[12px] font-semibold text-muted">マッピング定義（版管理）</p>
          <UiDataTable
            :columns="mappingColumns"
            :rows="mappingTableRows"
            empty-title="マッピング未定義"
            empty-hint="「マッピングを設定」で取込元の列/キーを対象アプリ項目へ対応づけてください"
          >
            <template #cell-version="{ row }">
              <span class="num tabular-nums">v{{ asMapping(row).version }}</span>
            </template>
            <template #cell-status="{ row }">
              <UiStatusBadge :label="MAPPING_STATUS[asMapping(row).status].label" :tone="MAPPING_STATUS[asMapping(row).status].tone" dot />
            </template>
            <template #cell-fieldCount="{ row }">
              <span class="num tabular-nums">{{ asMapping(row).fields.length }}</span>
            </template>
          </UiDataTable>
        </div>

        <!-- 実行履歴 -->
        <div>
          <p class="mb-1.5 text-[12px] font-semibold text-muted">実行履歴（行クリックでエラー明細）</p>
          <UiDataTable
            :columns="runColumns"
            :rows="runPaged"
            clickable
            empty-title="実行履歴がありません"
            empty-hint="「取込を実行」で取込を開始してください"
            @row-click="openRun"
          >
            <template #cell-code="{ row }">
              <span class="font-medium">{{ asRun(row).code }}</span>
            </template>
            <template #cell-startedAt="{ row }">
              {{ fmtDateTime(asRun(row).startedAt) }}
            </template>
            <template #cell-status="{ row }">
              <UiStatusBadge :label="RUN_STATUS[asRun(row).status].label" :tone="RUN_STATUS[asRun(row).status].tone" dot />
            </template>
            <template #cell-counts="{ row }">
              <span class="num tabular-nums">
                {{ fmtInt(asRun(row).counts.staged) }} / {{ fmtInt(asRun(row).counts.applied) }} /
                <span :class="asRun(row).counts.failed > 0 ? 'text-crit font-semibold' : ''">{{ fmtInt(asRun(row).counts.failed) }}</span>
              </span>
            </template>
            <template #cell-errorCount="{ row }">
              <span class="num tabular-nums" :class="asRun(row).errors.length > 0 ? 'text-crit font-semibold' : 'text-muted'">
                {{ asRun(row).errors.length }}
              </span>
            </template>
          </UiDataTable>
          <UiPagination v-model:page="runPage" v-model:page-size="runPageSize" :total="runTotal" />
        </div>
      </div>
    </UiSectionCard>

    <UiEmptyState
      v-else
      icon="MousePointerClick"
      title="取込元を選択してください"
      hint="上の一覧から取込元を選ぶと、マッピング定義と実行履歴を表示します"
    />

    <!-- 取込元を追加モーダル -->
    <UiModal :open="addOpen" title="取込元を追加" @close="addOpen = false">
      <UiSchemaForm v-model="addForm" :fields="addFields" :errors="addErrors" />
      <template #footer>
        <div class="flex items-center justify-end gap-2">
          <button type="button" class="btn" @click="addOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" :disabled="addBusy" @click="submitAdd">{{ addBusy ? '追加中…' : '追加' }}</button>
        </div>
      </template>
    </UiModal>

    <!-- マッピング編集モーダル（取込対象基準。左辺=対象項目〔固定〕・右辺=取込元の列/キーを割当） -->
    <UiModal :open="mapOpen" title="マッピングを設定（新しい版）" width="720px" @close="mapOpen = false">
      <div v-if="selectedSource" class="grid gap-3">
        <p class="text-[12px] leading-relaxed text-sub">
          対象「{{ IMPORT_ENTITY_LABELS[selectedSource.targetEntity] }}」の項目（左）に、取込元のどの列/キー（右）を割り当てるかを設定します。
          左辺は取込対象に設定された項目（既定＋カスタマイズ項目）です。使わない項目は空欄のままで構いません。
          「変換」は取込時に値を整形する処理で、選択式です（選ぶと行の下に説明を表示。前後の空白は常に除去されます）。
          保存すると新しい版になり、既存の有効版は旧版になります。
        </p>
        <p v-if="selectedSource.segmentId" class="rounded border border-line bg-info-soft px-3 py-2 text-[12px] text-sub">
          この取込元の<span class="font-semibold text-ink">事業セグメントは「{{ masters.segmentName(selectedSource.segmentId) }}」</span>で共通適用されます（各項目での列割当は不要です）。
        </p>

        <!-- バリアント軸取込（product_variant）の説明: グルーピングキー・固有ID・バリアント軸の役割 -->
        <div v-if="selectedSource.targetEntity === 'product_variant'" class="card border-line bg-info-soft p-3 text-[12px] leading-relaxed text-sub">
          <span class="font-semibold text-ink">バリアント軸取込:</span>
          「<span class="font-semibold text-ink">商品コード（グルーピングキー）</span>」で行を商品へまとめ、
          「<span class="font-semibold text-ink">SKUコード（固有ID）</span>」を各データ行の固有 ID として SKU を登録・更新します。
          カラー・サイズのような軸の列は「<span class="font-semibold text-ink">バリアント軸1/2の値</span>」へ割り当ててください。
          割り当てた<span class="font-semibold text-ink">列の論理名（例: カラー / サイズ）がそのまま商品のバリアント軸ラベル</span>になり、
          カラー×サイズ等の 2 次元バリアント表（縦持ち）を商品＋SKU として取り込めます。
          例）「商品id / skuid / カラー / サイズ」の列なら、商品id → 商品コード・skuid → SKUコード・カラー → 軸1・サイズ → 軸2。
        </div>

        <!-- 方式別の接続 / 解析設定 -->
        <div class="card border-line bg-page p-3 grid gap-2.5">
          <p class="text-[11px] font-semibold text-muted">{{ IMPORT_METHOD_LABELS[selectedSource.method] }} の設定</p>

          <!-- CSV -->
          <template v-if="mapMethod === 'file_csv'">
            <div class="flex flex-wrap items-end gap-3">
              <label class="flex items-center gap-1.5 text-[12px] text-sub">
                <input v-model="cfgDraft.hasHeader" type="checkbox">1 行目はヘッダ（項目名）
              </label>
              <label class="grid gap-1 text-[11px] font-semibold text-muted">
                区切り文字
                <input v-model="cfgDraft.delimiter" class="input w-20" type="text" maxlength="1" placeholder="," aria-label="区切り文字">
              </label>
              <label class="btn btn-sm cursor-pointer">
                <Upload class="h-4 w-4" aria-hidden="true" />
                CSV を読み込んで列を検出
                <input type="file" accept=".csv,.txt,text/csv,text/plain" class="sr-only" @change="onCsvUpload">
              </label>
            </div>
            <p class="text-[11px] text-muted">
              ファイルを読み込むと各列（{{ cfgDraft.hasHeader ? '列番号＋論理名' : '列番号' }}）が左辺に展開されます。手動で行を追加することもできます。
            </p>
          </template>

          <!-- 固定長 -->
          <template v-else-if="mapMethod === 'file_fixed'">
            <p class="text-[12px] text-sub">
              各項目の <span class="font-semibold text-ink">開始バイト〜終了バイト</span>（1 始まり・両端を含む）を指定し、右辺のアプリ項目へ対応づけます。
              「行を追加」で項目を増やせます。
            </p>
          </template>

          <!-- Google スプレッドシート（連携認証 → ブック検索/選択 → シート選択 → 開始行/列 → 列検出） -->
          <template v-else-if="mapMethod === 'sheets_pull'">
            <div v-if="!sheets.status.value.enabled" class="card border-warn bg-warn-soft p-2.5 text-[12px] text-ink">
              Google スプレッドシート連携が未設定です（サーバーの GOOGLE_OAUTH_* を設定してください）。
            </div>
            <div v-else-if="!sheets.status.value.connected" class="grid gap-2">
              <p class="text-[12px] text-sub">
                Google カレンダー連携と同様に、Google アカウントで連携すると対象のスプレッドシートを検索・選択できます。
              </p>
              <div>
                <button type="button" class="btn btn-sm btn-primary" :disabled="!sheets.isAdmin.value" @click="sheets.connect()">
                  <Upload class="h-4 w-4" aria-hidden="true" />
                  Google スプレッドシートと連携
                </button>
              </div>
            </div>
            <template v-else>
              <div class="flex items-center justify-between">
                <p class="text-[11px] font-semibold text-ok">連携済み</p>
                <button type="button" class="btn btn-ghost btn-sm text-crit" @click="sheets.disconnect()">連携を解除</button>
              </div>

              <!-- 1) 対象スプレッドシートの検索・選択 -->
              <div class="grid gap-1.5">
                <span class="text-[11px] font-semibold text-muted">対象スプレッドシートを検索</span>
                <div class="flex gap-2">
                  <input
                    v-model="sheetsSearch" class="input flex-1" type="text"
                    placeholder="ブック名で検索（空で最近更新順）" aria-label="スプレッドシート検索"
                    @keyup.enter="searchSpreadsheets"
                  >
                  <button type="button" class="btn btn-sm" :disabled="sheetsBusy" @click="searchSpreadsheets">検索</button>
                </div>
                <div v-if="sheetsList.length > 0" class="max-h-40 overflow-y-auto rounded border border-line">
                  <button
                    v-for="s in sheetsList" :key="s.id" type="button"
                    class="flex w-full items-center justify-between border-b border-line px-2.5 py-1.5 text-left text-[12px] last:border-b-0 hover:bg-page"
                    :class="{ 'bg-brand-soft text-brand': s.id === cfgDraft.spreadsheetId }"
                    @click="selectSpreadsheet(s)"
                  >
                    <span>{{ s.name }}</span>
                    <span v-if="s.id === cfgDraft.spreadsheetId" class="text-[11px]">選択中</span>
                  </button>
                </div>
                <p v-if="cfgDraft.spreadsheetName" class="text-[12px] text-sub">
                  対象ブック: <span class="font-semibold text-ink">{{ cfgDraft.spreadsheetName }}</span>
                </p>
              </div>

              <!-- 2) シート（タブ）選択 -->
              <label v-if="sheetsTabs.length > 0" class="grid gap-1 text-[11px] font-semibold text-muted">
                シート（タブ）
                <select v-model="cfgDraft.sheetName" class="select" aria-label="シート">
                  <option value="">（選択）</option>
                  <option v-for="t in sheetsTabs" :key="t" :value="t">{{ t }}</option>
                </select>
              </label>

              <!-- 3) 開始行・開始列 → 列検出 -->
              <div class="flex flex-wrap items-end gap-3">
                <label class="grid gap-1 text-[11px] font-semibold text-muted">
                  開始行（ヘッダ行・1 始まり）
                  <input v-model.number="cfgDraft.headerRow" class="input w-28" type="number" min="1" aria-label="開始行">
                </label>
                <label class="grid gap-1 text-[11px] font-semibold text-muted">
                  開始列（A1 記法）
                  <input v-model="cfgDraft.startColumn" class="input w-20" type="text" maxlength="3" placeholder="A" aria-label="開始列">
                </label>
                <button
                  type="button" class="btn btn-sm"
                  :disabled="sheetsBusy || !cfgDraft.spreadsheetId || !cfgDraft.sheetName"
                  @click="detectSheetColumns"
                >
                  <Upload class="h-4 w-4" aria-hidden="true" />
                  {{ sheetsBusy ? '取得中…' : '列を取得' }}
                </button>
              </div>
              <p class="text-[11px] text-muted">
                指定した開始行を項目名（ヘッダ）とし、開始列以降の各列が左辺に展開されます。右辺（アプリ項目）を選択してください。
              </p>
            </template>
          </template>

          <!-- JSON / API -->
          <template v-else>
            <template v-if="mapMethod === 'api_pull'">
              <label class="grid gap-1 text-[11px] font-semibold text-muted">
                エンドポイント URL
                <input v-model="cfgDraft.endpoint" class="input" type="url" placeholder="https://api.example.com/records" aria-label="エンドポイント URL">
              </label>
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-[200px_1fr]">
                <label class="grid gap-1 text-[11px] font-semibold text-muted">
                  認証方式
                  <select v-model="cfgDraft.authType" class="select" aria-label="認証方式">
                    <option v-for="o in AUTH_TYPE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                </label>
                <label v-if="cfgDraft.authType !== 'none'" class="grid gap-1 text-[11px] font-semibold text-muted">
                  {{ cfgDraft.authType === 'basic' ? '資格情報（user:pass）' : 'トークン / キー' }}
                  <input v-model="cfgDraft.authValue" class="input" type="text" placeholder="値を入力" aria-label="認証値" autocomplete="off">
                </label>
              </div>
            </template>
            <label class="grid gap-1 text-[11px] font-semibold text-muted">
              レコード配列のルートパス（任意・空 = 応答が配列 or 単一オブジェクト）
              <input v-model="cfgDraft.jsonRootPath" class="input" type="text" placeholder="例）data.items" aria-label="ルートパス">
            </label>
            <label class="grid gap-1 text-[11px] font-semibold text-muted">
              {{ mapMethod === 'api_pull' ? 'サンプル応答（JSON）を貼り付け' : 'JSON を貼り付け' }}
              <textarea v-model="parseText" class="textarea" rows="4" placeholder='[{"code":"A","name":"商品A"}]' aria-label="JSON 貼付" />
            </label>
            <div>
              <button type="button" class="btn btn-sm" @click="onJsonParse">
                <Upload class="h-4 w-4" aria-hidden="true" />
                JSON からキーを検出
              </button>
            </div>
          </template>

          <p v-if="parseError" class="text-[12px] text-crit">{{ parseError }}</p>
        </div>

        <!-- マッピング行（左辺 = 取込対象の項目〔固定〕・右辺 = 取込元の割当） -->
        <div class="flex flex-wrap items-center justify-between gap-1">
          <p class="text-[12px] font-semibold text-muted">
            項目マッピング（{{ IMPORT_ENTITY_LABELS[selectedSource.targetEntity] }}の {{ mapDraft.length }} 項目・割当済み {{ mappedCount }}）
          </p>
          <p v-if="(detectedColumns.length > 0 || detectedKeys.length > 0)" class="text-[11px] text-muted">
            取込元を検出済み（{{ detectedColumns.length || detectedKeys.length }} 件）。右辺の入力候補から選べます
          </p>
        </div>

        <div v-if="mapDraft.length === 0" class="card border-warn bg-warn-soft p-2.5 text-[12px] text-ink">
          対象の項目がありません。項目カスタマイズ画面で項目を有効化してください。
        </div>
        <div v-else-if="unmappedRequired.length > 0" class="card border-warn bg-warn-soft p-2.5 text-[12px] text-ink">
          必須項目（{{ unmappedRequired.map(f => f.targetLabel).join('・') }}）に取込元が未割当です。未割当のままでも保存できますが、実行時に該当行は隔離されます。
        </div>

        <!-- 検出済み取込元の候補（右辺入力の datalist）。CSV/Sheets = 列名・JSON/API = キー -->
        <datalist id="import-source-options">
          <option v-for="c in detectedColumns" :key="`c-${c.index}`" :value="c.name" />
          <option v-for="k in detectedKeys" :key="`k-${k}`" :value="k" />
        </datalist>

        <div class="overflow-x-auto">
          <div class="grid gap-2" :class="mapMethod === 'file_fixed' ? 'min-w-[620px]' : 'min-w-[520px]'">
            <div v-for="(r, i) in mapDraft" :key="i" class="grid gap-1">
              <div class="grid items-center gap-2" :class="rowGridClass">
                <!-- 左辺: 取込対象の項目（固定。必須はバッジ表示） -->
                <div class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate text-[12px] font-medium text-ink" :title="r.targetLabel">{{ r.targetLabel }}</span>
                  <UiStatusBadge v-if="r.required" tone="warn" label="必須" />
                </div>

                <span class="text-center text-muted" aria-hidden="true">←</span>

                <!-- 右辺: 取込元の割当（方式別。CSV/Sheets/JSON は検出候補の datalist 付き入力・固定長はバイト範囲） -->
                <template v-if="mapMethod === 'file_fixed'">
                  <input v-model.number="r.byteStart" class="input" type="number" min="1" placeholder="開始" :aria-label="`${r.targetLabel} の開始バイト`">
                  <input v-model.number="r.byteEnd" class="input" type="number" min="1" placeholder="終了" :aria-label="`${r.targetLabel} の終了バイト`">
                  <input v-model="r.sourceField" class="input" type="text" placeholder="項目名（任意）" :aria-label="`${r.targetLabel} の取込元項目名`">
                </template>
                <input
                  v-else
                  v-model="r.sourceField"
                  class="input"
                  type="text"
                  list="import-source-options"
                  :placeholder="mapMethod === 'file_json' || mapMethod === 'api_pull' ? '取込元の JSON キー' : '取込元の列名'"
                  :aria-label="`${r.targetLabel} に割り当てる取込元`"
                  @input="onCsvSourceInput(r)"
                >

                <!-- 変換は選択式（何が起きるかは行下の説明キャプションで表示 = title 非対応のモバイルにも届く） -->
                <select v-model="r.transform" class="select" aria-label="変換" :title="transformHint(r.transform)">
                  <option v-for="o in IMPORT_TRANSFORMS" :key="o.value" :value="o.value" :title="o.hint">{{ o.label }}</option>
                  <!-- 旧版から読み込んだカタログ外の自由入力値: 黙って消さず可視化（連携キーの方針と同型） -->
                  <option
                    v-if="r.transform && !IMPORT_TRANSFORMS.some(o => o.value === r.transform)"
                    :value="r.transform"
                    :title="transformHint(r.transform)"
                  >
                    {{ r.transform }}（旧設定の値）
                  </option>
                </select>
              </div>

              <!-- 変換の説明（選択中のみ。title ツールチップが出ないタッチ端末でも読める可視テキスト） -->
              <p v-if="r.transform" class="pl-2 text-[11px] leading-relaxed text-muted">
                変換: {{ transformHint(r.transform) }}
              </p>

              <!-- マスタ間連携キー（参照項目のみ）: 参照先マスタのどの項目と突合して解決するか -->
              <div
                v-if="r.isRef && refTargetOf(r.targetItemKey)"
                class="flex flex-wrap items-center gap-1.5 pl-2 text-[11px] text-muted"
              >
                <span>連携キー（{{ refTargetOf(r.targetItemKey)!.refLabel }}マスタとの突合項目）:</span>
                <select v-model="r.lookupField" class="select w-auto max-w-[240px]" aria-label="突合キー">
                  <option :value="null">{{ defaultLookupLabel(r.targetItemKey) }}</option>
                  <option v-for="o in lookupOptionsOf(r.targetItemKey)" :key="o.value" :value="o.value">{{ o.label }}</option>
                  <!-- 保存済みだが現在の候補に無いキー（定義を削除されたカスタム項目等）: 黙って消さず可視化する -->
                  <option
                    v-if="r.lookupField && !lookupOptionsOf(r.targetItemKey).some(o => o.value === r.lookupField)"
                    :value="r.lookupField"
                  >
                    {{ r.lookupField }}（候補に無いキー）
                  </option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="flex items-center justify-end gap-2">
          <button type="button" class="btn" @click="mapOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" :disabled="mapBusy" @click="saveMapping">{{ mapBusy ? '保存中…' : '保存' }}</button>
        </div>
      </template>
    </UiModal>

    <!-- エラー明細ドロワー -->
    <template #drawer>
      <UiDrawer :open="errorDrawerOpen" :title="errorRun ? `${errorRun.code} のエラー明細` : 'エラー明細'" @close="errorDrawerOpen = false">
        <div v-if="errorRun" class="grid gap-3 text-[13px]">
          <div class="grid grid-cols-2 gap-2">
            <div class="card p-2.5">
              <p class="text-[11px] text-muted">ステージ / 反映</p>
              <p class="num tabular-nums text-[15px] font-bold">{{ fmtInt(errorRun.counts.staged) }} / {{ fmtInt(errorRun.counts.applied) }}</p>
            </div>
            <div class="card p-2.5">
              <p class="text-[11px] text-muted">隔離（失敗）</p>
              <p class="num tabular-nums text-[15px] font-bold" :class="errorRun.counts.failed > 0 ? 'text-crit' : ''">{{ fmtInt(errorRun.counts.failed) }}</p>
            </div>
          </div>

          <UiEmptyState
            v-if="errorRun.errors.length === 0"
            icon="CircleCheck"
            title="エラー行はありません"
            hint="全行が正常に反映されました"
          />
          <div v-else class="grid gap-2">
            <p class="text-[11px] font-semibold text-muted">隔離された行（{{ errorRun.errors.length }}件）</p>
            <div v-for="(e, i) in errorRun.errors" :key="i" class="card border-crit p-2.5">
              <div class="flex items-center justify-between">
                <span class="text-[11px] font-semibold text-muted">行 {{ e.rowNo }}</span>
                <UiStatusBadge label="隔離" tone="crit" dot />
              </div>
              <p class="mt-1 text-[12px] text-crit">{{ e.message }}</p>
              <pre class="mt-1.5 overflow-x-auto rounded bg-page p-2 text-[11px] text-sub">{{ e.rawText }}</pre>
            </div>
          </div>
        </div>
      </UiDrawer>
    </template>
  </MastersMasterShell>
</template>
