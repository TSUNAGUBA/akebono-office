<script setup lang="ts">
/**
 * F-13 設定・汎用化基盤（管理者専用）
 * a) 外部リンク b) 機能トグル c) カスタム項目 d) 汎用区分マスタ
 * e) エスカレーションルール f) 勤怠ルール/承認経路への導線 g) 監査ログ h) デモデータリセット
 */
import * as icons from 'lucide-vue-next'
import { ArrowRight, Plus } from 'lucide-vue-next'
import type {
  CustomFieldDef, CustomFieldEntity, CustomFieldType, EscalationRule, ExternalLink, FeatureToggle,
} from '~/types/domain'
import type { TableColumn } from '~/types/ui'
import { fmtDateTime } from '~/utils/format'

const { isAdmin } = useCurrentUser()
const toast = useToast()
const confirm = useConfirm()
const { tbl } = useMockDb()
const members = tbl('members')

function memberName(id: string): string {
  return members.value.find(m => m.id === id)?.name ?? id
}

function iconOf(name: string) {
  return (icons as Record<string, unknown>)[name] ?? icons.LayoutGrid
}

// ---------- a) 外部リンク ----------
const linkCrud = useMasterCrudAsync('externalLinks', 'el')
const sortedLinks = computed(() =>
  [...linkCrud.list.value].sort((a, b) => Number(b.active) - Number(a.active) || a.displayOrder - b.displayOrder))

const linkModalOpen = ref(false)
const linkForm = reactive({ id: '', title: '', url: '', description: '', icon: 'Link', displayOrder: 1 })
const linkErrors = reactive<Record<string, string>>({})
const linkIconFound = computed(() => (icons as Record<string, unknown>)[linkForm.icon] !== undefined)

async function openLinkModal(link?: ExternalLink): Promise<void> {
  linkForm.id = link?.id ?? ''
  linkForm.title = link?.title ?? ''
  linkForm.url = link?.url ?? 'https://'
  linkForm.description = link?.description ?? ''
  linkForm.icon = link?.icon ?? 'Link'
  linkForm.displayOrder = link?.displayOrder
    ?? Math.max(0, ...linkCrud.list.value.map(l => l.displayOrder)) + 1
  Object.keys(linkErrors).forEach(k => delete linkErrors[k])
  linkModalOpen.value = true
}

async function saveLink(): Promise<void> {
  Object.keys(linkErrors).forEach(k => delete linkErrors[k])
  if (!linkForm.title.trim()) linkErrors.title = 'タイトルを入力してください'
  if (!/^https?:\/\/.+/.test(linkForm.url.trim())) linkErrors.url = 'http(s):// から始まる URL を入力してください'
  if (Object.keys(linkErrors).length > 0) return
  const r = await linkCrud.save({
    ...(linkForm.id ? { id: linkForm.id } : {}),
    title: linkForm.title.trim(),
    url: linkForm.url.trim(),
    description: linkForm.description.trim(),
    icon: linkForm.icon.trim() || 'Link',
    displayOrder: Number(linkForm.displayOrder) || 1,
  })
  if (!r.ok) {
    toast.show(r.error.message, 'crit')
    return
  }
  linkModalOpen.value = false
  toast.show('外部リンクを保存しました', 'ok', { label: '確認', to: '/support' })
}

async function toggleLinkActive(link: ExternalLink): Promise<void> {
  const r = await (link.active ? linkCrud.archive(link.id) : linkCrud.restore(link.id))
  if (r.ok) toast.show(link.active ? `「${link.title}」を無効化しました` : `「${link.title}」を有効化しました`)
  else toast.show(r.error.message, 'crit')
}

// ---------- b) 機能トグル / e) エスカレーションルール ----------
const { featureToggles, escalationRules, setToggle, updateEscalationRule, getConfig, setConfig, resetDemo } = useAppSettings()
/** API モード（SoT = PostgreSQL）ではデモリセットを出さない */
const apiMode = useApiMode()

// ---------- 日報の入力方式（F-13-7。F-06-7 のオプション設定） ----------

const REPORT_INPUT_MODE_OPTIONS = [
  { value: 'form', label: '通常フォーム入力のみ' },
  { value: 'assist', label: 'AI アシスト入力のみ' },
  { value: 'both', label: '両方（メンバーが切替可能）' },
]

const reportInputMode = computed({
  get: () => getConfig('reportInputMode', 'both'),
  set: (v: string) => {
    setConfig('reportInputMode', v)
    toast.show('日報の入力方式を変更しました（日報画面に即時反映されます）')
  },
})

function onToggleFeature(t: FeatureToggle): void {
  setToggle(t.key, !t.enabled)
  toast.show(`「${t.label}」を${t.enabled ? '無効' : '有効'}にしました`)
}

function onToggleRule(r: EscalationRule): void {
  updateEscalationRule(r.key, { enabled: !r.enabled })
  toast.show(`「${r.label}」を${r.enabled ? '無効' : '有効'}にしました`)
}

function onRuleThreshold(r: EscalationRule, e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(v) || v < 0) return
  updateEscalationRule(r.key, { threshold: v })
  toast.show(`「${r.label}」の閾値を ${v} に更新しました`)
}

function onRuleCooldown(r: EscalationRule, e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(v) || v < 0) return
  updateEscalationRule(r.key, { cooldownDays: v })
  toast.show(`「${r.label}」のクールダウンを ${v} 日に更新しました`)
}

// ---------- c) カスタム項目 ----------
// labels.ts は共有ファイル（編集禁止）のため、この画面固有の enum ラベルはローカル定義とする
const CF_ENTITY_LABELS: Record<CustomFieldEntity, string> = {
  member: 'メンバー',
  company: '顧客(会社)',
  contact: '顧客(人)',
  project: 'プロジェクト',
}
const CF_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: 'テキスト',
  number: '数値',
  date: '日付',
  select: '選択',
  multiselect: '複数選択',
  boolean: 'ON/OFF',
}
const cfEntityOptions = (Object.keys(CF_ENTITY_LABELS) as CustomFieldEntity[])
  .map(k => ({ value: k, label: CF_ENTITY_LABELS[k] }))
const cfTypeOptions = (Object.keys(CF_TYPE_LABELS) as CustomFieldType[])
  .map(k => ({ value: k, label: CF_TYPE_LABELS[k] }))

const cf = useCustomFields()
const cfEntity = ref<CustomFieldEntity>('member')
const cfList = computed(() =>
  cf.list.value
    .filter(d => d.entity === cfEntity.value)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.displayOrder - b.displayOrder))

const cfModalOpen = ref(false)
const cfForm = reactive({ id: '', key: '', label: '', fieldType: 'text' as CustomFieldType, optionsText: '', required: false, displayOrder: 1 })
const cfErrors = reactive<Record<string, string>>({})

async function openCfModal(def?: CustomFieldDef): Promise<void> {
  cfForm.id = def?.id ?? ''
  cfForm.key = def?.key ?? ''
  cfForm.label = def?.label ?? ''
  cfForm.fieldType = def?.fieldType ?? 'text'
  cfForm.optionsText = def?.options.join(', ') ?? ''
  cfForm.required = def?.required ?? false
  cfForm.displayOrder = def?.displayOrder ?? (cfList.value.length + 1)
  Object.keys(cfErrors).forEach(k => delete cfErrors[k])
  cfModalOpen.value = true
}

async function saveCustomField(): Promise<void> {
  Object.keys(cfErrors).forEach(k => delete cfErrors[k])
  const key = cfForm.key.trim()
  if (!cfForm.label.trim()) cfErrors.label = '表示名を入力してください'
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) cfErrors.key = '英字始まりの英数字（_可）で入力してください'
  else if (cf.list.value.some(d => d.entity === cfEntity.value && d.key === key && d.id !== cfForm.id)) {
    cfErrors.key = '同じキーが既に存在します'
  }
  const needsOptions = cfForm.fieldType === 'select' || cfForm.fieldType === 'multiselect'
  const options = needsOptions
    ? cfForm.optionsText.split(/[,、]/).map(s => s.trim()).filter(Boolean)
    : []
  if (needsOptions && options.length === 0) cfErrors.optionsText = '選択肢をカンマ区切りで入力してください'
  if (Object.keys(cfErrors).length > 0) return

  const r = await cf.save({
    ...(cfForm.id ? { id: cfForm.id } : {}),
    entity: cfEntity.value,
    key,
    label: cfForm.label.trim(),
    fieldType: cfForm.fieldType,
    options,
    required: cfForm.required,
    displayOrder: Number(cfForm.displayOrder) || 1,
  })
  if (!r.ok) {
    toast.show(r.error.message, 'crit')
    return
  }
  cfModalOpen.value = false
  toast.show(`カスタム項目を保存しました（${CF_ENTITY_LABELS[cfEntity.value]}のフォームに反映されます）`)
}

async function toggleCfActive(def: CustomFieldDef): Promise<void> {
  const r = await (def.active ? cf.archive(def.id) : cf.restore(def.id))
  if (r.ok) toast.show(def.active ? `「${def.label}」を無効化しました` : `「${def.label}」を有効化しました`)
  else toast.show(r.error.message, 'crit')
}

// ---------- d) 汎用区分マスタ ----------
const cm = useCodeMaster()
// 部署は Department マスタ（F-10-9）へ昇格したため、汎用区分の既定カテゴリは title
const cmCategory = ref('title')
const cmItems = computed(() =>
  cm.list.value
    .filter(i => i.category === cmCategory.value)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.displayOrder - b.displayOrder))
const cmCategoryOptions = computed(() => cm.categories.value.map(c => ({ value: c, label: c })))

const cmModalOpen = ref(false)
const cmForm = reactive({ id: '', code: '', label: '', displayOrder: 1 })
const cmErrors = reactive<Record<string, string>>({})

async function openCmModal(item?: { id: string; code: string; label: string; displayOrder: number }): Promise<void> {
  cmForm.id = item?.id ?? ''
  cmForm.code = item?.code ?? ''
  cmForm.label = item?.label ?? ''
  cmForm.displayOrder = item?.displayOrder ?? (cmItems.value.length + 1)
  Object.keys(cmErrors).forEach(k => delete cmErrors[k])
  cmModalOpen.value = true
}

async function saveCmItem(): Promise<void> {
  Object.keys(cmErrors).forEach(k => delete cmErrors[k])
  const code = cmForm.code.trim()
  if (!code) cmErrors.code = 'コードを入力してください'
  else if (cm.list.value.some(i => i.category === cmCategory.value && i.code === code && i.id !== cmForm.id)) {
    cmErrors.code = '同じコードが既に存在します'
  }
  if (!cmForm.label.trim()) cmErrors.label = 'ラベルを入力してください'
  if (Object.keys(cmErrors).length > 0) return
  const r = await cm.save({
    ...(cmForm.id ? { id: cmForm.id } : {}),
    category: cmCategory.value,
    code,
    label: cmForm.label.trim(),
    displayOrder: Number(cmForm.displayOrder) || 1,
  })
  if (!r.ok) {
    toast.show(r.error.message, 'crit')
    return
  }
  cmModalOpen.value = false
  toast.show('区分マスタを保存しました')
}

async function toggleCmActive(item: { id: string; label: string; active: boolean }): Promise<void> {
  const r = await (item.active ? cm.archive(item.id) : cm.restore(item.id))
  if (r.ok) toast.show(item.active ? `「${item.label}」を無効化しました` : `「${item.label}」を有効化しました`)
  else toast.show(r.error.message, 'crit')
}

const catModalOpen = ref(false)
const catForm = reactive({ category: '', code: '', label: '' })
const catErrors = reactive<Record<string, string>>({})

async function openCatModal(): Promise<void> {
  catForm.category = ''
  catForm.code = ''
  catForm.label = ''
  Object.keys(catErrors).forEach(k => delete catErrors[k])
  catModalOpen.value = true
}

async function saveCategory(): Promise<void> {
  Object.keys(catErrors).forEach(k => delete catErrors[k])
  const category = catForm.category.trim()
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(category)) catErrors.category = '英字始まりの英数字（_可）で入力してください'
  else if (cm.categories.value.includes(category)) catErrors.category = '同じカテゴリが既に存在します'
  if (!catForm.code.trim()) catErrors.code = '初期項目のコードを入力してください'
  if (!catForm.label.trim()) catErrors.label = '初期項目のラベルを入力してください'
  if (Object.keys(catErrors).length > 0) return
  const r = await cm.save({
    category,
    code: catForm.code.trim(),
    label: catForm.label.trim(),
    displayOrder: 1,
  })
  if (!r.ok) {
    toast.show(r.error.message, 'crit')
    return
  }
  catModalOpen.value = false
  cmCategory.value = category
  toast.show(`カテゴリ「${category}」を作成しました`)
}

// ---------- g) 監査ログ ----------
const AUDIT_ACTION_LABELS: Record<string, string> = {
  create: '追加',
  update: '更新',
  archive: '無効化',
  restore: '再有効化',
}
const auditLogs = tbl('auditLogs')
const auditColumns: TableColumn[] = [
  { key: 'at', label: '日時', width: '130px', primary: true },
  { key: 'actor', label: '操作者', width: '110px', primary: true },
  { key: 'action', label: '操作', width: '90px', primary: true },
  { key: 'target', label: '対象' },
]
const auditRows = computed(() =>
  [...auditLogs.value]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(l => ({
      id: l.id,
      at: fmtDateTime(l.at),
      actor: memberName(l.actorId),
      action: AUDIT_ACTION_LABELS[l.action] ?? l.action,
      target: `${l.entity}: ${l.entityId}`,
      detail: l.detail,
    })))

// ---------- h) デモデータ ----------
async function onResetDemo(): Promise<void> {
  const ok = await confirm.ask(
    'デモデータをリセット',
    'すべてのデータをシード状態に戻します。追加・変更した内容は失われます。よろしいですか？',
    { danger: true, confirmLabel: 'リセット' },
  )
  if (!ok) return
  resetDemo()
  toast.show('シード状態に戻しました')
}
</script>

<template>
  <div>
    <!-- 管理者以外は案内のみ -->
    <UiEmptyState
      v-if="!isAdmin"
      icon="Lock"
      title="設定は管理者専用です"
      hint="カスタム項目・外部リンク・機能トグルなどの変更は管理者が行います。ヘッダーのデモユーザー切替で管理者に切り替えると確認できます"
    >
      <template #action>
        <NuxtLink to="/" class="btn btn-sm">ダッシュボードへ戻る</NuxtLink>
      </template>
    </UiEmptyState>

    <template v-else>
      <UiPageHeader title="設定" description="他社展開を見据えた汎用化基盤（カスタム項目・区分・リンク・トグル）" />

      <div class="grid items-start gap-3 lg:grid-cols-2">
        <!-- a) 外部リンク -->
        <UiSectionCard title="外部リンク" description="業務支援ツールのカードメニューに表示されます">
          <template #actions>
            <button type="button" class="btn btn-primary btn-sm" @click="openLinkModal()">
              <Plus class="h-3.5 w-3.5" aria-hidden="true" />
              追加
            </button>
          </template>
          <ul class="grid gap-1.5">
            <li
              v-for="link in sortedLinks"
              :key="link.id"
              class="flex items-center gap-2.5 rounded-lg border border-line px-2.5 py-2"
              :class="link.active ? '' : 'opacity-55'"
            >
              <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                <component :is="iconOf(link.icon)" class="h-4 w-4" aria-hidden="true" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  <span class="text-[13px] font-bold">{{ link.title }}</span>
                  <span class="num text-[10px] text-muted">#{{ link.displayOrder }}</span>
                  <UiStatusBadge v-if="!link.active" label="無効" tone="neutral" />
                </span>
                <span class="block truncate text-[11px] text-muted">{{ link.url }}</span>
              </span>
              <button type="button" class="btn btn-sm" @click="openLinkModal(link)">編集</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="toggleLinkActive(link)">
                {{ link.active ? '無効化' : '有効化' }}
              </button>
            </li>
          </ul>
          <UiEmptyState v-if="sortedLinks.length === 0" title="外部リンクがありません" hint="「追加」から登録できます" />
        </UiSectionCard>

        <!-- b) 機能トグル -->
        <UiSectionCard title="機能トグル" description="無効にするとナビゲーションから消えます（他社導入時のカスタマイズを想定）">
          <ul class="grid gap-1">
            <li
              v-for="t in featureToggles"
              :key="t.key"
              class="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-surface-soft"
            >
              <span class="text-[13px] font-medium">
                {{ t.label }}
                <span class="ml-1 text-[10px] text-muted">{{ t.key }}</span>
              </span>
              <button
                type="button"
                role="switch"
                :aria-checked="t.enabled"
                :aria-label="t.label"
                class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
                :class="t.enabled ? 'bg-brand' : 'bg-line-strong'"
                @click="onToggleFeature(t)"
              >
                <span
                  class="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all"
                  :class="t.enabled ? 'left-[22px]' : 'left-0.5'"
                  aria-hidden="true"
                />
              </button>
            </li>
          </ul>
        </UiSectionCard>

        <!-- b2) 日報の入力方式（F-13-7） -->
        <UiSectionCard
          title="日報の入力方式"
          description="AI アシスト入力はオプション機能です。カレンダー予定・ぽいぽいメモ・AI ヒアリングから日報ドラフトを生成し、本人が確認・修正してから提出します"
        >
          <div class="max-w-xs">
            <UiSelect v-model="reportInputMode" :options="REPORT_INPUT_MODE_OPTIONS" aria-label="日報の入力方式" />
          </div>
          <p class="mt-2 text-[11px] text-muted">
            「AI アシスト入力のみ」でも、生成されたドラフトの確認・修正は通常フォームで行います（AI の出力をそのまま提出することはありません）
          </p>
        </UiSectionCard>

        <!-- c) カスタム項目 -->
        <UiSectionCard title="カスタム項目" description="各マスタのフォームに自動反映されます">
          <template #actions>
            <select v-model="cfEntity" class="select w-auto" aria-label="対象エンティティ">
              <option v-for="o in cfEntityOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <button type="button" class="btn btn-primary btn-sm" @click="openCfModal()">
              <Plus class="h-3.5 w-3.5" aria-hidden="true" />
              追加
            </button>
          </template>
          <ul class="grid gap-1.5">
            <li
              v-for="def in cfList"
              :key="def.id"
              class="flex items-center gap-2.5 rounded-lg border border-line px-2.5 py-2"
              :class="def.active ? '' : 'opacity-55'"
            >
              <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-1.5">
                  <span class="text-[13px] font-bold">{{ def.label }}</span>
                  <span class="num text-[10px] text-muted">{{ def.key }}</span>
                  <UiStatusBadge :label="CF_TYPE_LABELS[def.fieldType]" tone="info" />
                  <UiStatusBadge v-if="def.required" label="必須" tone="warn" />
                  <UiStatusBadge v-if="!def.active" label="無効" tone="neutral" />
                </span>
                <span v-if="def.options.length > 0" class="block truncate text-[11px] text-muted">
                  選択肢: {{ def.options.join(' / ') }}
                </span>
              </span>
              <button type="button" class="btn btn-sm" @click="openCfModal(def)">編集</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="toggleCfActive(def)">
                {{ def.active ? '無効化' : '有効化' }}
              </button>
            </li>
          </ul>
          <UiEmptyState
            v-if="cfList.length === 0"
            :title="`${CF_ENTITY_LABELS[cfEntity]}のカスタム項目はありません`"
            hint="「追加」から定義できます"
          />
        </UiSectionCard>

        <!-- d) 汎用区分マスタ -->
        <UiSectionCard title="汎用区分マスタ" description="各画面の選択肢はここを参照します">
          <template #actions>
            <UiSelect v-model="cmCategory" :options="cmCategoryOptions" aria-label="カテゴリ" />
            <button type="button" class="btn btn-sm" @click="openCatModal">新カテゴリ</button>
            <button type="button" class="btn btn-primary btn-sm" @click="openCmModal()">
              <Plus class="h-3.5 w-3.5" aria-hidden="true" />
              追加
            </button>
          </template>
          <ul class="grid gap-1.5">
            <li
              v-for="item in cmItems"
              :key="item.id"
              class="flex items-center gap-2.5 rounded-lg border border-line px-2.5 py-2"
              :class="item.active ? '' : 'opacity-55'"
            >
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  <span class="text-[13px] font-bold">{{ item.label }}</span>
                  <span class="num text-[10px] text-muted">{{ item.code }} / #{{ item.displayOrder }}</span>
                  <UiStatusBadge v-if="!item.active" label="無効" tone="neutral" />
                </span>
              </span>
              <button type="button" class="btn btn-sm" @click="openCmModal(item)">編集</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="toggleCmActive(item)">
                {{ item.active ? '無効化' : '有効化' }}
              </button>
            </li>
          </ul>
          <UiEmptyState v-if="cmItems.length === 0" title="このカテゴリに項目はありません" hint="「追加」から登録できます" />
        </UiSectionCard>

        <!-- e) エスカレーションルール -->
        <UiSectionCard title="エスカレーションルール" description="シグナル検知の有効/無効・閾値・クールダウンを調整します">
          <ul class="grid gap-1.5">
            <li
              v-for="r in escalationRules"
              :key="r.key"
              class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line px-2.5 py-2"
            >
              <button
                type="button"
                role="switch"
                :aria-checked="r.enabled"
                :aria-label="r.label"
                class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
                :class="r.enabled ? 'bg-brand' : 'bg-line-strong'"
                @click="onToggleRule(r)"
              >
                <span
                  class="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all"
                  :class="r.enabled ? 'left-[22px]' : 'left-0.5'"
                  aria-hidden="true"
                />
              </button>
              <span class="min-w-0 flex-1 text-[13px] font-medium" :class="r.enabled ? '' : 'text-muted'">
                {{ r.label }}
              </span>
              <label v-if="r.threshold !== null" class="flex items-center gap-1 text-[11px] text-sub">
                {{ r.thresholdLabel }}
                <input
                  type="number"
                  class="input num w-16"
                  min="0"
                  :value="r.threshold"
                  :aria-label="`${r.label}の閾値`"
                  @change="onRuleThreshold(r, $event)"
                >
              </label>
              <label class="flex items-center gap-1 text-[11px] text-sub">
                クールダウン
                <input
                  type="number"
                  class="input num w-14"
                  min="0"
                  :value="r.cooldownDays"
                  :aria-label="`${r.label}のクールダウン日数`"
                  @change="onRuleCooldown(r, $event)"
                >
                日
              </label>
            </li>
          </ul>
        </UiSectionCard>

        <!-- f) 勤怠ルール / 承認経路 -->
        <UiSectionCard title="勤怠ルール / 承認経路" description="それぞれの管理画面に集約されています">
          <div class="grid gap-2">
            <NuxtLink
              to="/attendance?tab=settings"
              class="card flex items-center gap-3 p-3 transition-colors hover:border-brand"
            >
              <span class="min-w-0 flex-1">
                <span class="block text-[13px] font-bold">勤怠ルール</span>
                <span class="block text-[11px] text-sub">雇用区分別の就業時間・休憩・フレックス・締め日の設定</span>
              </span>
              <ArrowRight class="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            </NuxtLink>
            <NuxtLink
              to="/workflow?tab=routes"
              class="card flex items-center gap-3 p-3 transition-colors hover:border-brand"
            >
              <span class="min-w-0 flex-1">
                <span class="block text-[13px] font-bold">承認経路</span>
                <span class="block text-[11px] text-sub">稟議区分×金額帯ごとの承認ステップ（直列/合議）の設定</span>
              </span>
              <ArrowRight class="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            </NuxtLink>
          </div>
        </UiSectionCard>

        <!-- g) 監査ログ -->
        <UiSectionCard
          class="lg:col-span-2"
          title="監査ログ"
          description="マスタ・設定変更の操作履歴（読み取り専用）"
          flush
        >
          <UiDataTable
            :columns="auditColumns"
            :rows="auditRows"
            max-height="340px"
            empty-title="操作履歴はまだありません"
            empty-hint="マスタや設定を変更すると記録されます"
          >
            <template #cell-target="{ row }">
              <span class="block">{{ row.target }}</span>
              <span class="block text-[11px] text-muted">{{ row.detail }}</span>
            </template>
          </UiDataTable>
        </UiSectionCard>

        <!-- h) デモデータ（モックモード専用。API モードでは SoT が PostgreSQL のため非表示） -->
        <UiSectionCard
          v-if="!apiMode"
          class="lg:col-span-2"
          title="デモデータ"
          description="モックアップのデータをシード状態に戻します（打刻・申請・設定変更など全てが初期化されます）"
        >
          <button type="button" class="btn btn-danger" @click="onResetDemo">デモデータをリセット</button>
        </UiSectionCard>
      </div>

      <!-- 外部リンク 追加/編集モーダル -->
      <UiModal :open="linkModalOpen" :title="linkForm.id ? '外部リンクを編集' : '外部リンクを追加'" @close="linkModalOpen = false">
        <div class="grid gap-3">
          <UiFormField label="タイトル" required :error="linkErrors.title">
            <input v-model="linkForm.title" type="text" class="input" placeholder="例: 経費精算 SaaS">
          </UiFormField>
          <UiFormField label="URL" required :error="linkErrors.url">
            <input v-model="linkForm.url" type="url" class="input" placeholder="https://example.com/">
          </UiFormField>
          <UiFormField label="説明">
            <input v-model="linkForm.description" type="text" class="input" placeholder="カードに表示される説明文">
          </UiFormField>
          <UiFormField
            label="アイコン名（lucide）"
            :hint="linkIconFound ? '' : '該当するアイコンが見つかりません（LayoutGrid で表示されます）'"
          >
            <div class="flex items-center gap-2">
              <input v-model="linkForm.icon" type="text" class="input flex-1" placeholder="例: Table2, Receipt, BookOpen">
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand" aria-label="アイコンプレビュー">
                <component :is="iconOf(linkForm.icon)" class="h-5 w-5" aria-hidden="true" />
              </span>
            </div>
          </UiFormField>
          <UiFormField label="表示順" hint="小さいほど先頭に表示されます">
            <input v-model.number="linkForm.displayOrder" type="number" min="1" class="input num w-24">
          </UiFormField>
        </div>
        <template #footer>
          <button type="button" class="btn" @click="linkModalOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" @click="saveLink">保存</button>
        </template>
      </UiModal>

      <!-- カスタム項目 追加/編集モーダル -->
      <UiModal
        :open="cfModalOpen"
        :title="`カスタム項目を${cfForm.id ? '編集' : '追加'}（${CF_ENTITY_LABELS[cfEntity]}）`"
        @close="cfModalOpen = false"
      >
        <div class="grid gap-3">
          <UiFormField label="表示名" required :error="cfErrors.label">
            <input v-model="cfForm.label" type="text" class="input" placeholder="例: 保有資格">
          </UiFormField>
          <UiFormField
            label="キー（英数字）"
            required
            :error="cfErrors.key"
            :hint="cfForm.id ? '既存データとの互換性維持のため、キーは変更できません' : '保存後は変更できません'"
          >
            <input v-model="cfForm.key" type="text" class="input" placeholder="例: certifications" :disabled="cfForm.id !== ''">
          </UiFormField>
          <UiFormField label="型" required>
            <select v-model="cfForm.fieldType" class="select" aria-label="型">
              <option v-for="o in cfTypeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </UiFormField>
          <UiFormField
            v-if="cfForm.fieldType === 'select' || cfForm.fieldType === 'multiselect'"
            label="選択肢（カンマ区切り）"
            required
            :error="cfErrors.optionsText"
          >
            <input v-model="cfForm.optionsText" type="text" class="input" placeholder="例: 週次, 隔週, 月次">
          </UiFormField>
          <UiFormField label="必須">
            <label class="flex cursor-pointer items-center gap-2 text-[13px]">
              <input v-model="cfForm.required" type="checkbox" class="h-4 w-4 accent-[var(--c-brand)]">
              <span class="text-sub">入力を必須にする</span>
            </label>
          </UiFormField>
          <UiFormField label="表示順">
            <input v-model.number="cfForm.displayOrder" type="number" min="1" class="input num w-24">
          </UiFormField>
        </div>
        <template #footer>
          <button type="button" class="btn" @click="cfModalOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" @click="saveCustomField">保存</button>
        </template>
      </UiModal>

      <!-- 区分マスタ 項目 追加/編集モーダル -->
      <UiModal
        :open="cmModalOpen"
        :title="`区分項目を${cmForm.id ? '編集' : '追加'}（${cmCategory}）`"
        @close="cmModalOpen = false"
      >
        <div class="grid gap-3">
          <UiFormField label="コード" required :error="cmErrors.code">
            <input v-model="cmForm.code" type="text" class="input" placeholder="例: consulting">
          </UiFormField>
          <UiFormField label="ラベル" required :error="cmErrors.label">
            <input v-model="cmForm.label" type="text" class="input" placeholder="例: コンサルティング部">
          </UiFormField>
          <UiFormField label="表示順">
            <input v-model.number="cmForm.displayOrder" type="number" min="1" class="input num w-24">
          </UiFormField>
        </div>
        <template #footer>
          <button type="button" class="btn" @click="cmModalOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" @click="saveCmItem">保存</button>
        </template>
      </UiModal>

      <!-- 新カテゴリモーダル -->
      <UiModal :open="catModalOpen" title="新しいカテゴリを作成" @close="catModalOpen = false">
        <div class="grid gap-3">
          <UiFormField label="カテゴリ名（英数字）" required :error="catErrors.category" hint="例: contractType, region">
            <input v-model="catForm.category" type="text" class="input" placeholder="例: region">
          </UiFormField>
          <p class="text-[11px] text-muted">カテゴリは最初の項目と同時に作成されます。</p>
          <UiFormField label="初期項目のコード" required :error="catErrors.code">
            <input v-model="catForm.code" type="text" class="input" placeholder="例: east">
          </UiFormField>
          <UiFormField label="初期項目のラベル" required :error="catErrors.label">
            <input v-model="catForm.label" type="text" class="input" placeholder="例: 東日本">
          </UiFormField>
        </div>
        <template #footer>
          <button type="button" class="btn" @click="catModalOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" @click="saveCategory">作成</button>
        </template>
      </UiModal>
    </template>
  </div>
</template>
