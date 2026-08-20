<script setup lang="ts">
/**
 * 顧客コンテキストパネル（改修依頼 2026-08-20: トップ層メニュー「顧客コンテキスト」）。
 * 顧客(会社)セレクタ（URL クエリ ?company= と同期 = ディープリンク可・選び直しでも URL が追従）で
 * 会社を選ぶと、以下を 1 画面で可視化し、この画面から登録・修正できる:
 *  1. 基本情報（companies マスタ。編集ドロワー = useMasterCrudAsync('companies') の save）
 *  2. 関係（companyRelations の当該会社エッジ + 担当者(人)一覧。マスタ画面への導線付き）
 *  3. 定性情報（customerContexts: ビジョン/経営課題/補足メモ。1社1行の upsert・更新者/更新日時表示）
 *  4. 定量情報（ライブ導出・保存しない: 案件/活動ログ/顧客活動/サポート活動の件数と直近活動日）
 *  5. Memo（customerContextNotes の時系列メモ。20件ページング + 取消/復元 = 原則9.5）
 *  6. AI リサーチ（Web 調査 → 候補の採用 → 構築 → 差分確認 → 反映 → 取消。useCustomerContext 経由）
 * モバイル（375px）はカードが縦積みになるレスポンシブ構成（原則8）。
 */
import {
  BookUser, Building2, ExternalLink, Network, Pencil, Plus, RefreshCw, RotateCcw, Search,
  Sparkles, Trash2, Undo2, Users,
} from 'lucide-vue-next'
import type {
  ActivityLog, Company, CompanyRelation, Contact, CustomerContextNote,
  CustomerContextResearchSource, Industry, Member, RelationType,
} from '~/types/domain'
import type { CustomerContextInput, CustomerResearchCandidate } from '~/composables/useCustomerContext'
import { fmtDateLong } from '~/utils/format'

const ctx = useCustomerContext()
const cl = useCustomerLogs()
const sales = useSalesActivities()
const support = useSupportActivities()
const companyCrud = useMasterCrudAsync('companies', 'c')
const { tbl } = useMockDb()
const { show } = useToast()
const confirm = useConfirm()
const { currentUserId } = useCurrentUser()
const route = useRoute()
const router = useRouter()
const isApi = useApiMode()

const members = computed(() => (tbl('members').value as Member[]).filter(m => m.active))
const industries = computed(() => (tbl('industries').value as Industry[]).filter(i => i.active))
const companies = computed(() => (tbl('companies').value as Company[]).filter(c => c.active && c.kind === 'customer'))
const companyOptions = computed(() => companies.value.map(c => ({ value: c.id, label: c.name })))

onMounted(() => cl.ensureLoaded())

// ---------- 顧客セレクタ（URL クエリ ?company= と同期） ----------

const selectedId = ref('')
const selectedText = ref('')
const company = computed(() => companies.value.find(c => c.id === selectedId.value) ?? null)

// 初期表示: ?company= を取り込む（API モードは companies の到着を待って解決する。
// 到着後も見つからない id は選択なしのまま確定 = 無限に解決を待たない）
let urlInitDone = false
watchEffect(() => {
  if (urlInitDone) return
  const q = route.query.company
  if (typeof q !== 'string' || !q) {
    urlInitDone = true
    return
  }
  if (companies.value.length === 0) return // ハイドレーション待ち（モックは即時に揃う）
  const target = companies.value.find(c => c.id === q)
  if (target) {
    selectedId.value = target.id
    selectedText.value = target.name
  }
  urlInitDone = true
})

// 選択変更 → URL へ反映（リロード・共有で同じ会社を開ける。値が同じなら書き換えない）
watch(selectedId, (id) => {
  const cur = typeof route.query.company === 'string' ? route.query.company : ''
  if (cur === (id || '')) return
  void router.replace({ query: { ...route.query, company: id || undefined } })
})

// ---------- 1. 基本情報 ----------

function memberName(id: string | null): string {
  return id ? ((tbl('members').value as Member[]).find(m => m.id === id)?.name ?? id) : ''
}
function industryName(id: string | null): string {
  return id ? ((tbl('industries').value as Industry[]).find(i => i.id === id)?.name ?? '') : ''
}
const industryNames = computed(() => {
  if (!company.value) return ''
  const names = company.value.industryIds.map(industryName).filter(Boolean)
  return names.join('、')
})

const companyEditOpen = ref(false)
const companySaving = ref(false)
const companyForm = ref({
  name: '',
  aliasesText: '',
  primaryIndustryId: '',
  size: '',
  location: '',
  description: '',
  ownerMemberId: '',
})

const industryOptions = computed(() => industries.value.map(i => ({ value: i.id, label: i.name })))
const memberOptions = computed(() => members.value.map(m => ({
  value: m.id,
  label: m.id === currentUserId.value ? `${m.name}（自分）` : m.name,
})))

function openCompanyEdit(): void {
  if (!company.value) return
  companyForm.value = {
    name: company.value.name,
    aliasesText: company.value.aliases.join('、'),
    primaryIndustryId: company.value.primaryIndustryId ?? '',
    size: company.value.size,
    location: company.value.location,
    description: company.value.description,
    ownerMemberId: company.value.ownerMemberId ?? '',
  }
  companyEditOpen.value = true
}

async function saveCompany(): Promise<void> {
  if (!company.value || companySaving.value) return
  const name = companyForm.value.name.trim()
  if (!name) {
    show('会社名を入力してください', 'warn')
    return
  }
  companySaving.value = true
  try {
    const aliases = companyForm.value.aliasesText.split(/[、,]/).map(s => s.trim()).filter(Boolean)
    const primary = companyForm.value.primaryIndustryId || null
    // 主業種を変えたら industryIds にも含める（複数業種の既存値は保持 = 直交軸の整合）
    const industryIds = primary && !company.value.industryIds.includes(primary)
      ? [...company.value.industryIds, primary]
      : company.value.industryIds
    const res = await companyCrud.save({
      id: company.value.id,
      name,
      aliases,
      primaryIndustryId: primary,
      industryIds,
      size: companyForm.value.size.trim(),
      location: companyForm.value.location.trim(),
      description: companyForm.value.description.trim(),
      ownerMemberId: companyForm.value.ownerMemberId || null,
    })
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    show('基本情報を更新しました')
    companyEditOpen.value = false
  } finally {
    companySaving.value = false
  }
}

// ---------- 2. 関係 ----------

const relations = computed(() => (tbl('companyRelations').value as CompanyRelation[])
  .filter(r => r.fromCompanyId === selectedId.value || r.toCompanyId === selectedId.value))

function companyName(id: string): string {
  return (tbl('companies').value as Company[]).find(c => c.id === id)?.name ?? id
}
function relationTypeOf(id: string): RelationType | undefined {
  return (tbl('relationTypes').value as RelationType[]).find(t => t.id === id)
}
/** 関係の表示（相手会社名 + 種別 + 向き。directed はこの会社から見た向きを示す） */
function relationLabel(rel: CompanyRelation): { partner: string; type: string; direction: string } {
  const type = relationTypeOf(rel.relationTypeId)
  const isFrom = rel.fromCompanyId === selectedId.value
  const partner = companyName(isFrom ? rel.toCompanyId : rel.fromCompanyId)
  const direction = type?.direction === 'mutual' ? '相互' : isFrom ? 'この会社 → 相手' : '相手 → この会社'
  return { partner, type: type?.label ?? rel.relationTypeId, direction }
}

const companyContacts = computed(() => (tbl('contacts').value as Contact[])
  .filter(c => c.active && c.companyId === selectedId.value))

// ---------- 3. 定性情報 ----------

const currentContext = computed(() => (selectedId.value ? ctx.contextOf(selectedId.value) : null))
const ctxEditing = ref(false)
const ctxSaving = ref(false)
const ctxForm = ref<CustomerContextInput>({ vision: '', challenges: '', strategyNotes: '' })

function openCtxEdit(): void {
  ctxForm.value = {
    vision: currentContext.value?.vision ?? '',
    challenges: currentContext.value?.challenges ?? '',
    strategyNotes: currentContext.value?.strategyNotes ?? '',
  }
  ctxEditing.value = true
}

async function saveCtx(): Promise<void> {
  if (!selectedId.value || ctxSaving.value) return
  ctxSaving.value = true
  try {
    const res = await ctx.saveContext(selectedId.value, ctxForm.value)
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    show(currentContext.value ? '定性情報を更新しました' : '定性情報を登録しました')
    ctxEditing.value = false
  } finally {
    ctxSaving.value = false
  }
}

// ---------- 4. 定量情報（ライブ導出・保存しない） ----------

const deals = computed(() => sales.list().filter(d => d.companyId === selectedId.value))
const openDealCount = computed(() => deals.value.filter(d => d.phase !== '受注' && d.phase !== '失注').length)
const customerLogCount = computed(() => cl.allLogs().filter(l => l.companyId === selectedId.value).length)
const supportCount = computed(() => support.list().filter(s => s.companyId === selectedId.value).length)

/** 活動ログ集計（選択会社の案件のみ算出 = 読み込みを重くしない）。API モードは案件ごとに 1 リクエスト
 *（limit=1 で総件数 + 最新行だけ取得・最大 10 案件）。失敗は 0 扱いの非ブロッキング（原則4） */
const logStats = ref<{ count: number; latest: string | null }>({ count: 0, latest: null })
let logSeq = 0
async function computeLogStats(): Promise<void> {
  const my = ++logSeq
  const targets = deals.value
  if (!selectedId.value || targets.length === 0) {
    logStats.value = { count: 0, latest: null }
    return
  }
  if (!isApi) {
    const logs = (tbl('salesActivityLogs').value as ActivityLog[])
      .filter(l => l.active !== false && targets.some(d => d.id === l.activityId))
    logStats.value = {
      count: logs.length,
      latest: logs.map(l => l.loggedOn).sort().pop() ?? null,
    }
    return
  }
  try {
    const results = await Promise.all(targets.slice(0, 10).map(d =>
      apiFetchList<{ loggedOn: string }>(`/v1/sales-activities/${encodeURIComponent(d.id)}/logs`, {
        q: '', limit: 1, offset: 0, filter: { 'f.active': 'true' },
      })))
    if (my !== logSeq) return // 遅延応答は破棄（会社切替の取り違え防止）
    logStats.value = {
      count: results.reduce((sum, r) => sum + r.total, 0),
      latest: results.map(r => r.rows[0]?.loggedOn ?? '').filter(Boolean).sort().pop() ?? null,
    }
  } catch {
    if (my === logSeq) logStats.value = { count: 0, latest: null }
  }
}
watch([selectedId, () => deals.value.length], () => { void computeLogStats() }, { immediate: true })

// ---------- 5. Memo（時系列メモ） ----------

const noteLv = useListView<CustomerContextNote>({
  source: computed(() => (selectedId.value ? ctx.notesOf(selectedId.value) : [])),
  pageSize: 20,
})
// 会社切替でページ・入力途中のメモ・編集フォームをリセットする
// （前の会社の編集値を次の会社へ保存してしまう取り違えを防ぐ）
watch(selectedId, () => {
  noteLv.page.value = 1
  newNote.value = ''
  ctxEditing.value = false
  showArchivedNotes.value = false
})

const newNote = ref('')
const noteSaving = ref(false)
async function submitNote(): Promise<void> {
  if (!selectedId.value || noteSaving.value) return
  noteSaving.value = true
  try {
    const res = await ctx.addNote(selectedId.value, newNote.value)
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    show('メモを追記しました')
    newNote.value = ''
  } finally {
    noteSaving.value = false
  }
}

const archivedNotes = computed(() => (selectedId.value ? ctx.archivedNotesOf(selectedId.value) : []))
const showArchivedNotes = ref(false)
const noteBusy = ref(false)

async function onArchiveNote(note: CustomerContextNote): Promise<void> {
  const ok = await confirm.ask(
    'メモの取消',
    `${fmtDateLong(note.createdAt)} の ${note.memberName} さんのメモを取り消しますか？（あとから復元できます）`,
    { danger: true, confirmLabel: '取り消す' },
  )
  if (!ok) return
  const res = await ctx.archiveNote(selectedId.value, note.id)
  if (!res.ok) {
    show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  show('取り消しました', 'warn')
}

async function onRestoreNote(note: CustomerContextNote): Promise<void> {
  if (noteBusy.value) return
  noteBusy.value = true
  try {
    const res = await ctx.restoreNote(selectedId.value, note.id)
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    show('復元しました')
  } finally {
    noteBusy.value = false
  }
}

/** research ノートに「反映を取り消す」を出すか（payload.before があり、まだ取り消していない） */
function canRevert(note: CustomerContextNote): boolean {
  return note.kind === 'research' && !!note.payload?.before && !note.payload?.revertedAt
}

// ---------- 6. AI リサーチ（Web 調査 → 採用 → 構築 → 差分確認 → 反映 → 取消） ----------

const researchOpen = ref(false)
const researchStep = ref<'hints' | 'candidates' | 'proposal'>('hints')
const researchLoading = ref(false)
const hintForm = ref({ address: '', phone: '', keywords: '' })
const candidates = ref<CustomerResearchCandidate[]>([])
const adoptedUris = ref<string[]>([])
const researchLlm = ref(false)
const proposal = ref<CustomerContextInput | null>(null)
const applying = ref(false)
/** 反映直後の「反映を取り消す」導線（定性情報カードのバナー。会社切替でクリア） */
const lastAppliedNoteId = ref('')
watch(selectedId, () => { lastAppliedNoteId.value = '' })

function openResearch(): void {
  if (!company.value) return
  researchStep.value = 'hints'
  hintForm.value = { address: company.value.location, phone: '', keywords: '' }
  candidates.value = []
  adoptedUris.value = []
  proposal.value = null
  researchOpen.value = true
}

async function runResearch(): Promise<void> {
  if (!selectedId.value || researchLoading.value) return
  researchLoading.value = true
  try {
    const res = await ctx.research(selectedId.value, {
      address: hintForm.value.address.trim() || undefined,
      phone: hintForm.value.phone.trim() || undefined,
      keywords: hintForm.value.keywords.trim() || undefined,
    })
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    candidates.value = res.candidates
    researchLlm.value = res.llm
    adoptedUris.value = []
    researchStep.value = 'candidates'
  } finally {
    researchLoading.value = false
  }
}

function toggleAdopt(uri: string): void {
  adoptedUris.value = adoptedUris.value.includes(uri)
    ? adoptedUris.value.filter(u => u !== uri)
    : [...adoptedUris.value, uri]
}

const adoptedSources = computed<CustomerContextResearchSource[]>(() =>
  candidates.value.filter(c => adoptedUris.value.includes(c.uri)).map(c => ({ title: c.title, uri: c.uri })))

async function runBuild(): Promise<void> {
  if (!selectedId.value || researchLoading.value) return
  if (adoptedSources.value.length === 0) {
    show('採用する情報源を 1 件以上選択してください', 'warn')
    return
  }
  researchLoading.value = true
  try {
    const res = await ctx.buildProposal(selectedId.value, adoptedSources.value)
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    proposal.value = res.proposal
    researchLlm.value = res.llm
    researchStep.value = 'proposal'
  } finally {
    researchLoading.value = false
  }
}

/** 差分表示用（現在値と提案値のペア）。changed = 反映で書き換わる項目 */
const diffRows = computed(() => {
  if (!proposal.value) return []
  const cur = currentContext.value
  const fields: { key: keyof CustomerContextInput; label: string }[] = [
    { key: 'vision', label: 'ビジョン' },
    { key: 'challenges', label: '経営課題' },
    { key: 'strategyNotes', label: '補足メモ' },
  ]
  return fields.map(f => ({
    ...f,
    current: cur?.[f.key] ?? '',
    proposed: proposal.value![f.key],
    changed: (cur?.[f.key] ?? '') !== proposal.value![f.key],
  }))
})

async function applyProposal(): Promise<void> {
  if (!selectedId.value || !proposal.value || applying.value) return
  applying.value = true
  try {
    const res = await ctx.applyResearch(selectedId.value, proposal.value, adoptedSources.value)
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    lastAppliedNoteId.value = res.id ?? ''
    show('AI リサーチの内容を反映しました（リサーチノートから取り消せます）')
    researchOpen.value = false
  } finally {
    applying.value = false
  }
}

async function onRevert(noteId: string): Promise<void> {
  const ok = await confirm.ask(
    '反映の取消',
    'AI リサーチで反映した内容を取り消し、反映前の定性情報へ戻しますか？（リサーチノートは監査のため残ります）',
    { danger: true, confirmLabel: '反映を取り消す' },
  )
  if (!ok) return
  const res = await ctx.revertResearch(selectedId.value, noteId)
  if (!res.ok) {
    show(`${res.error.code}: ${res.error.message}`, 'crit')
    return
  }
  if (lastAppliedNoteId.value === noteId) lastAppliedNoteId.value = ''
  show('反映を取り消し、反映前の内容へ戻しました', 'warn')
}
</script>

<template>
  <div class="grid gap-3">
    <!-- 顧客セレクタ -->
    <UiSectionCard title="対象の顧客(会社)" description="会社を選ぶと基本情報・関係・定性/定量情報・メモを 1 画面で確認できます">
      <template #actions>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="再読み込み" @click="ctx.refresh()">
          <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </template>
      <div class="max-w-md">
        <UiCombobox
          v-model="selectedId"
          v-model:text="selectedText"
          :options="companyOptions"
          :allow-create="false"
          placeholder="会社名で検索・選択"
          aria-label="対象の顧客(会社)"
        />
      </div>
    </UiSectionCard>

    <UiEmptyState
      v-if="!company"
      icon="BookUser"
      title="顧客(会社)を選択してください"
      hint="上の検索ボックスから会社を選ぶと、顧客コンテキストが表示されます"
    />

    <template v-else>
      <div class="grid gap-3 lg:grid-cols-2">
        <!-- 1. 基本情報 -->
        <UiSectionCard title="基本情報" description="顧客(会社)マスタの主要項目">
          <template #actions>
            <button type="button" class="btn btn-sm" :aria-label="`「${company.name}」の基本情報を編集`" @click="openCompanyEdit">
              <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
              編集
            </button>
          </template>
          <dl class="grid gap-2 text-[13px]">
            <div class="flex items-start gap-2">
              <dt class="w-20 shrink-0 text-[11px] font-semibold text-muted">名称</dt>
              <dd class="min-w-0 font-bold">
                <Building2 class="mr-1 inline h-3.5 w-3.5 text-muted" aria-hidden="true" />{{ company.name }}
              </dd>
            </div>
            <div v-if="company.aliases.length > 0" class="flex items-start gap-2">
              <dt class="w-20 shrink-0 text-[11px] font-semibold text-muted">かな・別名</dt>
              <dd class="min-w-0 text-sub">{{ company.aliases.join('、') }}</dd>
            </div>
            <div class="flex items-start gap-2">
              <dt class="w-20 shrink-0 text-[11px] font-semibold text-muted">業種</dt>
              <dd class="min-w-0">
                {{ industryNames || '未設定' }}
                <span v-if="industryName(company.primaryIndustryId)" class="ml-1 text-[11px] text-muted">（主: {{ industryName(company.primaryIndustryId) }}）</span>
              </dd>
            </div>
            <div class="flex items-start gap-2">
              <dt class="w-20 shrink-0 text-[11px] font-semibold text-muted">規模</dt>
              <dd class="min-w-0">{{ company.size || '未設定' }}</dd>
            </div>
            <div class="flex items-start gap-2">
              <dt class="w-20 shrink-0 text-[11px] font-semibold text-muted">所在地</dt>
              <dd class="min-w-0">{{ company.location || '未設定' }}</dd>
            </div>
            <div class="flex items-start gap-2">
              <dt class="w-20 shrink-0 text-[11px] font-semibold text-muted">説明</dt>
              <dd class="min-w-0 whitespace-pre-wrap leading-relaxed text-sub">{{ company.description || '未設定' }}</dd>
            </div>
            <div class="flex items-start gap-2">
              <dt class="w-20 shrink-0 text-[11px] font-semibold text-muted">担当者</dt>
              <dd class="min-w-0">{{ memberName(company.ownerMemberId) || '未設定' }}</dd>
            </div>
          </dl>
          <NuxtLink to="/masters/customers" class="mt-2 inline-flex items-center gap-1 text-[11px] text-brand hover:underline">
            <ExternalLink class="h-3 w-3" aria-hidden="true" />顧客(会社)マスタで開く
          </NuxtLink>
        </UiSectionCard>

        <!-- 2. 関係 -->
        <UiSectionCard title="関係" description="会社間の関係と担当者(人)の一覧">
          <div class="grid gap-3">
            <div>
              <p class="label mb-1">会社間の関係（{{ relations.length }}件）</p>
              <p v-if="relations.length === 0" class="text-[12px] text-muted">登録されている関係はありません</p>
              <ul v-else class="grid gap-1" aria-label="会社間の関係一覧">
                <li v-for="rel in relations" :key="rel.id" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
                  <Network class="h-3.5 w-3.5 shrink-0 self-center text-muted" aria-hidden="true" />
                  <span class="font-semibold">{{ relationLabel(rel).partner }}</span>
                  <span class="rounded-full border border-brand bg-brand-soft px-1.5 py-px text-[10px] font-medium text-brand">{{ relationLabel(rel).type }}</span>
                  <span class="text-[11px] text-muted">{{ relationLabel(rel).direction }}</span>
                  <span v-if="rel.notes" class="w-full text-[11px] text-sub">{{ rel.notes }}</span>
                </li>
              </ul>
              <NuxtLink to="/masters/relations-company" class="mt-1 inline-flex items-center gap-1 text-[11px] text-brand hover:underline">
                <ExternalLink class="h-3 w-3" aria-hidden="true" />顧客関係(会社)で編集
              </NuxtLink>
            </div>
            <div>
              <p class="label mb-1">担当者(人)（{{ companyContacts.length }}名）</p>
              <p v-if="companyContacts.length === 0" class="text-[12px] text-muted">登録されている担当者はいません</p>
              <ul v-else class="grid gap-1" aria-label="担当者一覧">
                <li v-for="p in companyContacts" :key="p.id" class="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                  <Users class="h-3 w-3 shrink-0 self-center text-muted" aria-hidden="true" />
                  <span class="font-semibold">{{ p.name }}</span>
                  <span v-if="p.dept || p.title" class="text-sub">{{ [p.dept, p.title].filter(Boolean).join(' / ') }}</span>
                  <span v-if="p.keyPerson >= 3" class="rounded-full border border-warn bg-warn-soft px-1.5 py-px text-[10px] font-medium text-warn">キーパーソン</span>
                </li>
              </ul>
              <NuxtLink to="/masters/contacts" class="mt-1 inline-flex items-center gap-1 text-[11px] text-brand hover:underline">
                <ExternalLink class="h-3 w-3" aria-hidden="true" />顧客(人)マスタで編集
              </NuxtLink>
            </div>
          </div>
        </UiSectionCard>
      </div>

      <!-- 3. 定性情報 -->
      <UiSectionCard title="定性情報" description="ビジョン・経営課題・補足メモ（チーム共有。上書き更新はチーム全員可）">
        <template #actions>
          <div class="flex flex-wrap items-center gap-2">
            <button type="button" class="btn btn-sm" aria-label="AI の Web 調査で定性情報を更新" @click="openResearch">
              <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
              AI で調査
            </button>
            <button
              v-if="!ctxEditing"
              type="button"
              class="btn btn-primary btn-sm"
              :aria-label="currentContext ? '定性情報を編集' : '定性情報を登録'"
              @click="openCtxEdit"
            >
              <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
              {{ currentContext ? '編集' : '登録' }}
            </button>
          </div>
        </template>

        <!-- 反映直後の取消導線（原則9.5） -->
        <div
          v-if="lastAppliedNoteId"
          class="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn bg-warn-soft px-3 py-2"
          role="status"
        >
          <p class="text-[12px] text-warn">AI リサーチの内容を反映しました。内容が違う場合は反映前へ戻せます。</p>
          <button type="button" class="btn btn-sm" @click="onRevert(lastAppliedNoteId)">
            <Undo2 class="h-3.5 w-3.5" aria-hidden="true" />
            反映を取り消す
          </button>
        </div>

        <div v-if="ctxEditing" class="grid gap-3">
          <UiFormField label="ビジョン" hint="顧客が掲げる将来像・パーパス">
            <textarea v-model="ctxForm.vision" class="textarea min-h-20" placeholder="例）地域とともに歩む小売プラットフォームになる" aria-label="ビジョン" />
          </UiFormField>
          <UiFormField label="経営課題" hint="改行区切りの箇条書きがおすすめです">
            <textarea v-model="ctxForm.challenges" class="textarea min-h-24" placeholder="例）・在庫最適化&#10;・データ活用人材の育成" aria-label="経営課題" />
          </UiFormField>
          <UiFormField label="補足メモ" hint="戦略メモなどの任意の定性情報">
            <textarea v-model="ctxForm.strategyNotes" class="textarea min-h-20" aria-label="補足メモ" />
          </UiFormField>
          <div class="flex items-center justify-end gap-2">
            <button type="button" class="btn" @click="ctxEditing = false">キャンセル</button>
            <button type="button" class="btn btn-primary" :disabled="ctxSaving" @click="saveCtx">
              {{ ctxSaving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>

        <UiEmptyState
          v-else-if="!currentContext"
          icon="Sparkles"
          title="定性情報はまだ登録されていません"
          hint="「登録」から手入力するか、「AI で調査」で Web 情報から下書きを作れます"
        />

        <div v-else class="grid gap-3">
          <div>
            <p class="label">ビジョン</p>
            <p class="whitespace-pre-wrap text-[13px] leading-relaxed">{{ currentContext.vision || '未登録' }}</p>
          </div>
          <div>
            <p class="label">経営課題</p>
            <p class="whitespace-pre-wrap text-[13px] leading-relaxed">{{ currentContext.challenges || '未登録' }}</p>
          </div>
          <div v-if="currentContext.strategyNotes">
            <p class="label">補足メモ</p>
            <p class="whitespace-pre-wrap text-[13px] leading-relaxed text-sub">{{ currentContext.strategyNotes }}</p>
          </div>
          <p class="text-[11px] text-muted">
            最終更新: {{ currentContext.updatedByName || memberName(currentContext.updatedByMemberId) }} ・ {{ fmtDateLong(currentContext.updatedAt) }}
          </p>
        </div>
      </UiSectionCard>

      <!-- 4. 定量情報（ライブ導出） -->
      <UiSectionCard title="定量情報" description="各記録から自動集計（この画面では保存しません）">
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <UiKpiCard label="営業案件" :value="`${deals.length}件`" icon="Handshake" :to="`/sales-activity`" />
          <UiKpiCard label="進行中案件" :value="`${openDealCount}件`" sub="受注・失注を除く" icon="TrendingUp" />
          <UiKpiCard
            label="活動ログ"
            :value="`${logStats.count}件`"
            :sub="logStats.latest ? `直近 ${logStats.latest.replace(/-/g, '/')}` : '記録なし'"
            icon="NotebookPen"
          />
          <UiKpiCard label="顧客活動" :value="`${customerLogCount}件`" icon="MessageSquare" :to="`/customer-log`" />
          <UiKpiCard label="サポート活動" :value="`${supportCount}件`" icon="Headset" :to="`/support-activity`" />
        </div>
      </UiSectionCard>

      <!-- 5. Memo（時系列メモ） -->
      <UiSectionCard
        :title="`Memo（${noteLv.total.value}件）`"
        description="この顧客に関する時系列メモ。チーム全員が閲覧・追記できます（取消・復元可）"
        flush
      >
        <div class="grid gap-2 border-b border-line px-4 py-3">
          <textarea
            v-model="newNote"
            class="textarea min-h-16"
            placeholder="例）経営企画室と面談。次年度は物流とデータ基盤へ投資予定"
            aria-label="メモを追記"
          />
          <div class="flex items-center justify-end">
            <button type="button" class="btn btn-primary btn-sm" :disabled="noteSaving || !newNote.trim()" @click="submitNote">
              <Plus class="h-3.5 w-3.5" aria-hidden="true" />
              {{ noteSaving ? '追記中…' : 'メモを追記' }}
            </button>
          </div>
        </div>

        <UiEmptyState
          v-if="noteLv.total.value === 0"
          icon="NotebookPen"
          title="メモはまだありません"
          hint="上のフォームから最初のメモを追記できます"
        />
        <template v-else>
          <ul class="divide-y divide-line" aria-label="メモ一覧">
            <li v-for="note in noteLv.rows.value" :key="note.id" class="px-4 py-2.5">
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span class="num text-[11px] text-muted">{{ fmtDateLong(note.createdAt) }}</span>
                <span class="text-[12px] font-semibold">{{ note.memberName }}</span>
                <span
                  v-if="note.kind === 'research'"
                  class="rounded-full border border-brand bg-brand-soft px-1.5 py-px text-[10px] font-medium text-brand"
                >AI リサーチ</span>
                <span
                  v-if="note.payload?.revertedAt"
                  class="rounded-full border border-line-strong bg-surface px-1.5 py-px text-[10px] font-medium text-sub"
                >反映取消済み（{{ fmtDateLong(note.payload.revertedAt) }}）</span>
                <span class="ml-auto flex items-center gap-1">
                  <button
                    v-if="canRevert(note)"
                    type="button"
                    class="btn btn-ghost btn-sm"
                    aria-label="この反映を取り消して反映前の定性情報へ戻す"
                    @click="onRevert(note.id)"
                  >
                    <Undo2 class="h-3.5 w-3.5" aria-hidden="true" />
                    反映を取り消す
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :aria-label="`${note.memberName} さんのメモを取り消す`"
                    @click="onArchiveNote(note)"
                  >
                    <Trash2 class="h-3.5 w-3.5 text-crit" aria-hidden="true" />
                  </button>
                </span>
              </div>
              <p class="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed">{{ note.body }}</p>
              <ul v-if="(note.payload?.sources ?? []).length > 0" class="mt-1 grid gap-0.5" aria-label="採用した情報源">
                <li v-for="s in note.payload!.sources" :key="s.uri" class="truncate text-[11px]">
                  <a :href="s.uri" target="_blank" rel="noopener noreferrer" class="text-brand hover:underline">
                    <ExternalLink class="mr-0.5 inline h-3 w-3" aria-hidden="true" />{{ s.title }}
                  </a>
                </li>
              </ul>
            </li>
          </ul>
          <div class="px-4 pb-3">
            <UiPagination v-model:page="noteLv.page.value" v-model:page-size="noteLv.pageSize.value" :total="noteLv.total.value" />
          </div>
        </template>

        <!-- 取消済みメモ（復元 = 原則9.5） -->
        <div v-if="archivedNotes.length > 0" class="border-t border-line px-4 py-2">
          <button type="button" class="btn btn-ghost btn-sm" @click="showArchivedNotes = !showArchivedNotes">
            {{ showArchivedNotes ? '取消済みを隠す' : `取消済みを表示（${archivedNotes.length}件）` }}
          </button>
          <ul v-if="showArchivedNotes" class="mt-1 divide-y divide-line">
            <li v-for="note in archivedNotes" :key="note.id" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2">
              <span class="num text-[11px] text-muted">{{ fmtDateLong(note.createdAt) }}</span>
              <span class="min-w-0 flex-1 truncate text-[12px] text-muted line-through">{{ note.body }}</span>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="noteBusy"
                :aria-label="`${note.memberName} さんのメモを復元する`"
                @click="onRestoreNote(note)"
              >
                <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
                元に戻す
              </button>
            </li>
          </ul>
        </div>
      </UiSectionCard>
    </template>

    <!-- 基本情報の編集モーダル -->
    <UiModal :open="companyEditOpen" title="基本情報を編集" width="620px" @close="companyEditOpen = false">
      <div class="grid gap-3">
        <UiFormField label="会社名" required>
          <input v-model="companyForm.name" type="text" class="input" aria-label="会社名" required>
        </UiFormField>
        <UiFormField label="かな・別名" hint="「、」またはカンマ区切りで複数入力できます">
          <input v-model="companyForm.aliasesText" type="text" class="input" placeholder="例）アケボノ、akebono" aria-label="かな・別名">
        </UiFormField>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="主業種">
            <UiSelect v-model="companyForm.primaryIndustryId" :options="industryOptions" empty-label="未設定" aria-label="主業種" />
          </UiFormField>
          <UiFormField label="規模">
            <input v-model="companyForm.size" type="text" class="input" placeholder="例）100-300名" aria-label="規模">
          </UiFormField>
        </div>
        <UiFormField label="所在地">
          <input v-model="companyForm.location" type="text" class="input" placeholder="例）東京都" aria-label="所在地">
        </UiFormField>
        <UiFormField label="説明">
          <textarea v-model="companyForm.description" class="textarea min-h-20" aria-label="説明" />
        </UiFormField>
        <UiFormField label="担当者">
          <UiSelect v-model="companyForm.ownerMemberId" :options="memberOptions" empty-label="未設定" aria-label="担当者" />
        </UiFormField>
      </div>
      <template #footer>
        <div class="flex items-center justify-end gap-2">
          <button type="button" class="btn" @click="companyEditOpen = false">キャンセル</button>
          <button type="button" class="btn btn-primary" :disabled="companySaving" @click="saveCompany">
            {{ companySaving ? '保存中…' : '更新' }}
          </button>
        </div>
      </template>
    </UiModal>

    <!-- AI リサーチモーダル（調査 → 採用 → 構築 → 差分確認 → 反映） -->
    <UiModal
      :open="researchOpen"
      :title="`AI で調査（${company?.name ?? ''}）`"
      width="720px"
      @close="researchOpen = false"
    >
      <!-- ステップ1: 検索ヒント -->
      <div v-if="researchStep === 'hints'" class="grid gap-3">
        <p class="text-[12px] text-sub">
          社名「{{ company?.name }}」で Web を調査し、該当するホームページや記事の候補をリスト化します。
          同名企業と区別するためのヒント（任意）があると精度が上がります。
        </p>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <UiFormField label="住所">
            <input v-model="hintForm.address" type="text" class="input" placeholder="例）東京都" aria-label="住所ヒント">
          </UiFormField>
          <UiFormField label="電話番号">
            <input v-model="hintForm.phone" type="text" class="input" placeholder="例）03-1234-5678" aria-label="電話番号ヒント">
          </UiFormField>
        </div>
        <UiFormField label="キーワード" hint="事業内容・ブランド名など">
          <input v-model="hintForm.keywords" type="text" class="input" placeholder="例）小売 SCM" aria-label="キーワードヒント">
        </UiFormField>
      </div>

      <!-- ステップ2: 候補リスト（採用の選択） -->
      <div v-else-if="researchStep === 'candidates'" class="grid gap-2">
        <p class="text-[12px] text-sub">
          採用する情報源にチェックを入れてください（{{ adoptedUris.length }}件選択中）。
          <span v-if="!researchLlm" class="text-warn">現在はデモ生成（LLM 無効環境のため決定的なダミー候補・example.com）です。</span>
        </p>
        <ul class="grid gap-1.5" aria-label="調査候補リスト">
          <li v-for="cand in candidates" :key="cand.uri">
            <label class="flex cursor-pointer items-start gap-2 rounded-md border border-line px-3 py-2 transition-colors hover:bg-brand-soft" :class="adoptedUris.includes(cand.uri) ? 'border-brand bg-brand-soft' : ''">
              <input
                type="checkbox"
                class="mt-0.5"
                :checked="adoptedUris.includes(cand.uri)"
                :aria-label="`「${cand.title}」を採用する`"
                @change="toggleAdopt(cand.uri)"
              >
              <span class="min-w-0">
                <span class="block text-[13px] font-semibold">{{ cand.title }}</span>
                <span class="block truncate text-[11px] text-brand">{{ cand.uri }}</span>
                <span class="block text-[12px] leading-relaxed text-sub">{{ cand.snippet }}</span>
              </span>
            </label>
          </li>
        </ul>
      </div>

      <!-- ステップ3: 構築結果（現在値との差分） -->
      <div v-else-if="researchStep === 'proposal'" class="grid gap-3">
        <p class="text-[12px] text-sub">
          採用した {{ adoptedSources.length }} 件の情報から構築した提案値です。「反映」すると定性情報が更新され、
          採用ソースと反映前の値がリサーチノートに自動追記されます（あとから取り消せます）。
          <span v-if="!researchLlm" class="text-warn">現在はデモ生成（決定的ヒューリスティック）です。</span>
        </p>
        <div v-for="row in diffRows" :key="row.key" class="grid gap-1.5 sm:grid-cols-2">
          <div class="rounded-md border border-line p-2">
            <p class="label">{{ row.label }}（現在）</p>
            <p class="whitespace-pre-wrap text-[12px] leading-relaxed text-sub">{{ row.current || '未登録' }}</p>
          </div>
          <div class="rounded-md border p-2" :class="row.changed ? 'border-brand bg-brand-soft' : 'border-line'">
            <p class="label">{{ row.label }}（提案）{{ row.changed ? '' : ' — 変更なし' }}</p>
            <p class="whitespace-pre-wrap text-[12px] leading-relaxed">{{ row.proposed || '（空にする）' }}</p>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <button
              v-if="researchStep === 'candidates'"
              type="button"
              class="btn btn-sm"
              :disabled="researchLoading"
              @click="researchStep = 'hints'"
            >ヒントへ戻る</button>
            <button
              v-if="researchStep === 'proposal'"
              type="button"
              class="btn btn-sm"
              :disabled="researchLoading || applying"
              @click="researchStep = 'candidates'"
            >候補へ戻る</button>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" class="btn" @click="researchOpen = false">閉じる</button>
            <button
              v-if="researchStep === 'hints'"
              type="button"
              class="btn btn-primary"
              :disabled="researchLoading"
              @click="runResearch"
            >
              <Search class="h-3.5 w-3.5" aria-hidden="true" />
              {{ researchLoading ? '調査中…' : '調査開始' }}
            </button>
            <button
              v-else-if="researchStep === 'candidates'"
              type="button"
              class="btn btn-primary"
              :disabled="researchLoading || adoptedUris.length === 0"
              @click="runBuild"
            >
              <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
              {{ researchLoading ? '構築中…' : '採用した情報で構築' }}
            </button>
            <button
              v-else
              type="button"
              class="btn btn-primary"
              :disabled="applying"
              @click="applyProposal"
            >
              <BookUser class="h-3.5 w-3.5" aria-hidden="true" />
              {{ applying ? '反映中…' : '反映' }}
            </button>
          </div>
        </div>
      </template>
    </UiModal>
  </div>
</template>
