<script setup lang="ts">
/**
 * 顧客別ダッシュボード（/customer-dashboard。改善要望 2026-08-21・F-54）。
 * 顧客マスタ・顧客ログ（顧客活動）・営業案件・サポート活動・顧客コンテキストを 1 画面に集約し、
 * AI 分析（shared/domain/customer-insight の決定的導出 = 常時ライブ・保存しない）と合わせて可視化する。
 * 各カードから顧客コンテキスト・顧客活動・営業活動へドリルダウンできる。
 * 顧客(会社)セレクタは ?company= と URL 同期（customer-context と同型 = ディープリンク可）。
 */
import { ExternalLink } from 'lucide-vue-next'
import type { Company, Contact, CustomerLog, Industry, Member, SalesActivity, SalesApproach, SupportActivity } from '~/types/domain'
import { buildCustomerInsight, customerActivityMonthly, hasContextInfo, isOpenDealPhase } from '../../../../shared/domain/customer-insight'
import { SALES_APPROACH_STATUS_TONES } from '~/composables/useSalesApproaches'
import { fmtDate, fmtInt } from '~/utils/format'

const route = useRoute()
const router = useRouter()
const { tbl } = useMockDb()
const cl = useCustomerLogs()
const ctx = useCustomerContext()
onMounted(() => cl.ensureLoaded())

const companies = computed(() => (tbl('companies').value as Company[]).filter(c => c.active && c.kind === 'customer'))
const companyOptions = computed(() => companies.value.map(c => ({ value: c.id, label: c.name })))
const industries = computed(() => tbl('industries').value as Industry[])
const salesActivities = computed(() =>
  (tbl('salesActivities').value as SalesActivity[]).filter(a => a.active !== false))
const supportActivities = computed(() =>
  (tbl('supportActivities').value as SupportActivity[]).filter(a => a.active !== false))
const salesApproaches = computed(() =>
  (tbl('salesApproaches').value as SalesApproach[]).filter(a => a.active !== false))

// ---------- 顧客セレクタ（URL クエリ ?company= と同期 = customer-context と同型） ----------
const selectedId = ref('')
const selectedText = ref('')
const company = computed(() => companies.value.find(c => c.id === selectedId.value) ?? null)

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

watch(selectedId, (id) => {
  const cur = typeof route.query.company === 'string' ? route.query.company : ''
  if (cur === (id || '')) return
  void router.replace({ query: { ...route.query, company: id || undefined } })
})

// ---------- 集計（各 SoT からのライブ導出・保存しない） ----------

function memberName(id: string | null): string {
  return id ? ((tbl('members').value as Member[]).find(m => m.id === id)?.name ?? id) : ''
}
function contactName(id: string | null): string {
  return id ? ((tbl('contacts').value as Contact[]).find(c => c.id === id)?.name ?? '') : ''
}
const industryNames = computed(() => {
  if (!company.value) return ''
  return company.value.industryIds
    .map(id => industries.value.find(i => i.id === id)?.name ?? '')
    .filter(Boolean)
    .join('、')
})

const companyLogs = computed(() => (cl.allLogs() as CustomerLog[])
  .filter(l => l.companyId === selectedId.value && l.active !== false))
const companyDeals = computed(() => salesActivities.value.filter(a => a.companyId === selectedId.value))
const companySupports = computed(() => supportActivities.value.filter(a => a.companyId === selectedId.value))
const context = computed(() => (selectedId.value ? ctx.contextOf(selectedId.value) : null))
const approachRow = computed(() => salesApproaches.value.find(a => a.companyId === selectedId.value) ?? null)

/** AI 分析（決定的なライブ導出。同じデータ → 常に同じ分析 = モック / API 共通） */
const insight = computed(() => {
  if (!company.value) return null
  return buildCustomerInsight({
    companyName: company.value.name,
    asOf: todayJst(),
    logs: companyLogs.value.map(l => ({ logDate: l.logDate, tags: l.tags })),
    deals: companyDeals.value.map(d => ({ phase: d.phase, amount: d.amount })),
    supports: companySupports.value.map(s => ({ status: s.status })),
    context: context.value,
  })
})

const openDeals = computed(() => companyDeals.value.filter(d => isOpenDealPhase(d.phase)))
const unresolvedSupports = computed(() => companySupports.value.filter(s => s.status !== '解決'))

const TREND_LABELS: Record<string, string> = { up: '増加', down: '減少', flat: '横ばい', none: '—' }

/** 月次の顧客活動件数（直近 6 か月・チャート用） */
const monthlyChart = computed(() => {
  const points = customerActivityMonthly(
    companyLogs.value.map(l => ({ logDate: l.logDate, tags: l.tags })), todayJst(), 6)
  return {
    labels: points.map(p => p.month.slice(2)),
    series: [{ label: '顧客活動', data: points.map(p => p.count) }],
  }
})

/** 直近の顧客活動（最新 5 件） */
const recentLogs = computed(() => companyLogs.value.slice()
  .sort((a, b) => b.logDate.localeCompare(a.logDate) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  .slice(0, 5))

function logSummary(l: CustomerLog): string {
  const chars = [...l.body.replace(/\s+/g, ' ').trim()]
  return chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : chars.join('')
}
</script>

<template>
  <div class="grid gap-4">
    <!-- 対象の顧客(会社)。UiCombobox の候補リストはカード外へはみ出すため overflowVisible -->
    <UiSectionCard
      title="対象の顧客(会社)"
      description="顧客を選ぶと、基本情報・顧客コンテキスト・活動実績と AI 分析を 1 画面で確認できます"
      overflow-visible
    >
      <UiCombobox
        v-model="selectedId"
        v-model:text="selectedText"
        :options="companyOptions"
        :allow-create="false"
        placeholder="会社名で検索・選択"
        aria-label="対象の顧客(会社)"
      />
    </UiSectionCard>

    <UiEmptyState
      v-if="!company"
      icon="Building2"
      title="顧客(会社)を選択してください"
      hint="上のセレクタから顧客を選ぶと、顧客ごとのダッシュボードが表示されます"
    />

    <template v-else>
      <!-- KPI（ライブ導出） -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <UiKpiCard
          label="顧客活動（直近90日）"
          :value="fmtInt(insight?.engagement.recentCount ?? 0)"
          :sub="`前の90日 ${fmtInt(insight?.engagement.prevCount ?? 0)} 件・${TREND_LABELS[insight?.engagement.trend ?? 'none']}`"
          icon="MessagesSquare"
          :to="`/customer-log`"
        />
        <UiKpiCard
          label="進行中の商談"
          :value="fmtInt(openDeals.length)"
          :sub="`案件全体 ${fmtInt(companyDeals.length)} 件`"
          icon="Handshake"
          to="/sales-activity"
        />
        <UiKpiCard
          label="未解決サポート"
          :value="fmtInt(unresolvedSupports.length)"
          :sub="`サポート全体 ${fmtInt(companySupports.length)} 件`"
          icon="LifeBuoy"
          to="/support-activity"
        />
        <UiKpiCard
          label="最終接点"
          :value="insight?.engagement.lastContact ? fmtDate(insight.engagement.lastContact) : '—'"
          :sub="insight?.engagement.daysSinceContact != null ? `${insight.engagement.daysSinceContact} 日前` : '接点の記録なし'"
          icon="CalendarClock"
        />
      </div>

      <div class="grid gap-3 lg:grid-cols-2">
        <!-- 基本情報・属性（SoT = companies） -->
        <UiSectionCard title="基本情報・属性" description="顧客マスタのライブ参照です">
          <template #actions>
            <NuxtLink :to="`/customer-context?company=${company.id}`" class="link text-[11px]">顧客コンテキストで編集</NuxtLink>
          </template>
          <dl class="grid gap-1.5 text-[12px]">
            <div class="flex gap-2"><dt class="w-20 shrink-0 text-muted">会社名</dt><dd class="min-w-0 font-medium">{{ company.name }}</dd></div>
            <div class="flex gap-2"><dt class="w-20 shrink-0 text-muted">業種</dt><dd class="min-w-0">{{ industryNames || '—' }}</dd></div>
            <div class="flex gap-2"><dt class="w-20 shrink-0 text-muted">規模</dt><dd class="min-w-0">{{ company.size || '—' }}</dd></div>
            <div class="flex gap-2"><dt class="w-20 shrink-0 text-muted">所在地</dt><dd class="min-w-0">{{ company.location || '—' }}</dd></div>
            <div class="flex gap-2"><dt class="w-20 shrink-0 text-muted">担当</dt><dd class="min-w-0">{{ memberName(company.ownerMemberId) || '—' }}</dd></div>
            <div v-if="company.description" class="flex gap-2"><dt class="w-20 shrink-0 text-muted">説明</dt><dd class="min-w-0 text-sub">{{ company.description }}</dd></div>
          </dl>
          <div v-if="approachRow" class="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2 text-[12px]">
            <span class="text-muted">営業アプローチ:</span>
            <UiStatusBadge :label="approachRow.status" :tone="SALES_APPROACH_STATUS_TONES[approachRow.status] ?? 'neutral'" dot />
            <NuxtLink to="/sales-approach" class="link text-[11px]">アプローチリストへ</NuxtLink>
          </div>
        </UiSectionCard>

        <!-- 顧客コンテキスト（SoT = customerContexts） -->
        <UiSectionCard title="顧客コンテキスト（定性情報）" description="ビジョン・経営課題・事業メモのライブ参照です">
          <template #actions>
            <NuxtLink :to="`/customer-context?company=${company.id}`" class="link text-[11px]">詳細・編集</NuxtLink>
          </template>
          <template v-if="context && hasContextInfo(context)">
            <dl class="grid gap-1.5 text-[12px]">
              <div v-if="context.vision" class="grid gap-0.5"><dt class="text-muted">ビジョン</dt><dd class="whitespace-pre-wrap">{{ context.vision }}</dd></div>
              <div v-if="context.challenges" class="grid gap-0.5"><dt class="text-muted">経営課題</dt><dd class="whitespace-pre-wrap">{{ context.challenges }}</dd></div>
              <div v-if="context.businessNotes" class="grid gap-0.5"><dt class="text-muted">事業メモ</dt><dd class="whitespace-pre-wrap">{{ context.businessNotes }}</dd></div>
            </dl>
          </template>
          <UiEmptyState
            v-else
            icon="BookUser"
            title="定性情報は未整備です"
            hint="顧客コンテキストでビジョン・経営課題を整備すると、AI 分析・提案の質が上がります"
          />
        </UiSectionCard>
      </div>

      <!-- AI 分析（決定的なライブ導出 = 保存しない。ドリルダウンの起点） -->
      <UiSectionCard
        title="AI 分析"
        description="顧客ログ・案件・サポート・コンテキストからの自動分析（表示のたびに最新データから導出します）"
      >
        <div v-if="insight" class="grid gap-4">
          <div>
            <p class="label mb-1">現状サマリー</p>
            <ul class="grid list-disc gap-1 pl-4 text-[13px]">
              <li v-for="(s, i) in insight.summary" :key="i">{{ s }}</li>
            </ul>
          </div>
          <div v-if="insight.topTags.length > 0" class="flex flex-wrap items-center gap-1.5">
            <span class="label">活動目的の上位:</span>
            <span
              v-for="t in insight.topTags"
              :key="t.tag"
              class="rounded-full bg-surface-soft border border-line px-2 py-0.5 text-[11px]"
            >{{ t.tag }} <span class="num text-muted">×{{ t.count }}</span></span>
          </div>
          <div class="grid gap-3 lg:grid-cols-2">
            <div>
              <p class="label mb-1">リスク・注意点</p>
              <p v-if="insight.risks.length === 0" class="text-[12px] text-muted">検知されたリスクはありません</p>
              <ul v-else class="grid gap-1.5">
                <li v-for="(r, i) in insight.risks" :key="i" class="rounded-lg border border-warn/40 bg-warn-soft px-2.5 py-1.5 text-[12px]">{{ r }}</li>
              </ul>
            </div>
            <div>
              <p class="label mb-1">推奨アクション</p>
              <ul class="grid gap-1.5">
                <li v-for="(a, i) in insight.actions" :key="i" class="rounded-lg border border-brand/40 bg-brand-soft px-2.5 py-1.5 text-[12px]">{{ a }}</li>
              </ul>
            </div>
          </div>
        </div>
      </UiSectionCard>

      <!-- 活動トレンド + 直近の顧客活動（ドリルダウン） -->
      <div class="grid gap-3 lg:grid-cols-2">
        <ChartsBarChartCard title="顧客活動の月次推移（直近 6 か月）" :labels="monthlyChart.labels" :series="monthlyChart.series" :y-formatter="v => fmtInt(v)" />
        <UiSectionCard title="直近の顧客活動" description="最新 5 件。全件は顧客活動ページで確認できます" flush>
          <template #actions>
            <NuxtLink to="/customer-log" class="link text-[11px] inline-flex items-center gap-1">
              <ExternalLink class="h-3 w-3" aria-hidden="true" />
              顧客活動を開く
            </NuxtLink>
          </template>
          <p v-if="recentLogs.length === 0" class="px-4 py-4 text-[12px] text-muted">この顧客の活動記録はまだありません</p>
          <ul v-else class="divide-y divide-line">
            <li v-for="l in recentLogs" :key="l.id" class="px-4 py-2">
              <span class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span class="num text-[11px] text-muted">{{ fmtDate(l.logDate) }}</span>
                <span class="text-[12px] font-medium">{{ l.title || logSummary(l) }}</span>
                <span v-if="l.method" class="rounded-full bg-surface-soft border border-line px-2 text-[10px] text-sub">{{ l.method }}</span>
                <span class="ml-auto text-[11px] text-muted">{{ memberName(l.staffMemberId) }}{{ contactName(l.contactId) ? ` → ${contactName(l.contactId)}` : '' }}</span>
              </span>
              <p v-if="l.title" class="mt-0.5 text-[11px] text-sub">{{ logSummary(l) }}</p>
            </li>
          </ul>
        </UiSectionCard>
      </div>
    </template>
  </div>
</template>
