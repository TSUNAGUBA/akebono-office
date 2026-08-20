<script setup lang="ts">
/**
 * 営業活動 案件詳細（改修依頼 2026-08-20）。
 * 上段 = 案件の基本情報（編集・取消/復元）→ 中段 = AI集約（生成・再生成）→ 下段 = 活動ログ
 * （登録・20件/ページ・活動日降順・ログ詳細ドロワー）。
 * AI集約・活動ログは営業/パートナー共通部品（WidgetsActivityDigestCard / WidgetsActivityLogsCard = 原則3）。
 * 不正な id は EmptyState + 一覧へ戻る導線。取消済み案件は警告バナー + 復元ボタン（原則9.5）。
 */
import { Pencil, RotateCcw } from 'lucide-vue-next'
import type { Company, Contact, Member, SalesActivity, Village } from '~/types/domain'
import { fmtYen } from '~/utils/format'

const route = useRoute()
const sal = useSalesActivities()
const { tbl } = useMockDb()
const { show } = useToast()
const confirm = useConfirm()

// API モードで直リンク・リロードでも最新の案件行（aiDigest 含む）を取得する
onMounted(() => { void sal.refresh() })

const id = computed(() => String(route.params.id))
const activity = computed<SalesActivity | null>(() => sal.byId(id.value))
const isArchived = computed(() => activity.value?.active === false)

function companyName(cid: string): string {
  return (tbl('companies').value as Company[]).find(c => c.id === cid)?.name ?? cid
}
function villageName(vid: string | null | undefined): string {
  if (!vid) return ''
  return (tbl('villages').value as Village[]).find(v => v.id === vid)?.name ?? ''
}
function contactName(cid: string | null | undefined): string {
  if (!cid) return ''
  return (tbl('contacts').value as Contact[]).find(c => c.id === cid)?.name ?? ''
}
function memberName(mid: string): string {
  return (tbl('members').value as Member[]).find(m => m.id === mid)?.name ?? mid
}
function fmtDateKey(d: string | null): string {
  return d ? d.replace(/-/g, '/') : '—'
}

const detailRows = computed(() => {
  const s = activity.value
  if (!s) return []
  return [
    { label: '事業区分', value: villageName(s.villageId) || '—' },
    { label: '顧客', value: companyName(s.companyId) },
    { label: '担当', value: contactName(s.contactId) || '—' },
    { label: 'アプローチグループ', value: s.approachGroup || '—' },
    { label: '商談名', value: s.title },
    { label: '商談種別', value: s.dealType },
    { label: '担当者', value: memberName(s.staffMemberId) },
    { label: '商談フェーズ', value: s.phase },
    { label: '商談金額', value: s.amount === null ? '—' : fmtYen(s.amount) },
    { label: '受注確度', value: s.probability === null ? '—' : `${s.probability}%` },
    { label: '受注予定日', value: fmtDateKey(s.expectedCloseDate) },
    { label: '顧客課題', value: s.customerIssue || '—' },
    { label: '提案概要', value: s.proposal || '—' },
    { label: 'Next Action', value: s.nextAction || '—' },
    { label: 'Next Action日', value: fmtDateKey(s.nextActionDate) },
    { label: '参考リンク', value: (s.links ?? []).join('\n') || '—' },
    { label: '記録者', value: memberName(s.memberId) },
  ]
})

// ---------- 編集（共通フォームドロワー）・取消/復元 ----------

const editOpen = ref(false)

async function onArchive(): Promise<void> {
  const s = activity.value
  if (!s) return
  const ok = await confirm.ask(
    '営業活動の取消',
    `「${s.title}」を取り消しますか？（一覧から外れます。あとから復元できます）`,
    { danger: true, confirmLabel: '取り消す' },
  )
  if (!ok) return
  const res = await sal.archive(s.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  show('取り消しました', 'warn')
}

async function onRestore(): Promise<void> {
  const s = activity.value
  if (!s) return
  const res = await sal.restore(s.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  show('復元しました')
}
</script>

<template>
  <div v-if="!activity">
    <UiEmptyState icon="Handshake" title="案件が見つかりません" hint="URL が正しいか確認してください">
      <template #action>
        <NuxtLink to="/sales-activity" class="btn btn-primary btn-sm">案件一覧へ戻る</NuxtLink>
      </template>
    </UiEmptyState>
  </div>

  <div v-else>
    <UiPageHeader :title="activity.title" :description="`顧客: ${companyName(activity.companyId)} / 営業活動の案件詳細`">
      <template #actions>
        <UiStatusBadge :label="activity.phase" :tone="SALES_PHASE_TONES[activity.phase] ?? 'neutral'" dot />
        <!-- 一覧への戻る導線はヘッダー共通の親リンク（nav-map.ts）に統一 -->
      </template>
    </UiPageHeader>

    <!-- 取消済み案件の警告 + 復元（原則9.5） -->
    <div v-if="isArchived" class="mb-3 flex flex-wrap items-center gap-2 rounded-[10px] border border-warn bg-warn-soft px-3 py-2 text-[13px]" role="status">
      <span class="font-semibold text-warn">この案件は取消済みです（一覧から外れています）</span>
      <button type="button" class="btn btn-sm ml-auto" @click="onRestore">
        <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
        元に戻す
      </button>
    </div>

    <div class="grid gap-3">
      <!-- 基本情報 -->
      <UiSectionCard title="案件の基本情報" description="チーム共有の記録 = 全員が編集できます（訂正履歴は監査ログ）">
        <template #actions>
          <button v-if="!isArchived" type="button" class="btn btn-danger btn-sm" @click="onArchive">取り消す</button>
          <button type="button" class="btn btn-primary btn-sm" @click="editOpen = true">
            <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
            編集
          </button>
        </template>
        <dl class="grid gap-2 text-[13px] sm:grid-cols-2">
          <div
            v-for="r in detailRows"
            :key="r.label"
            class="grid grid-cols-[130px_1fr] gap-2 border-b border-line pb-2"
          >
            <dt class="pt-0.5 text-[11px] font-semibold text-muted">{{ r.label }}</dt>
            <dd class="whitespace-pre-wrap break-words">{{ r.value }}</dd>
          </div>
        </dl>
      </UiSectionCard>

      <!-- AI集約（活動ログの時系列集約） -->
      <WidgetsActivityDigestCard kind="sales" :activity-id="activity.id" :digest="activity.aiDigest ?? null" />

      <!-- 活動ログ（登録・一覧・詳細ドロワー・取消/復元） -->
      <WidgetsActivityLogsCard kind="sales" :activity-id="activity.id" />
    </div>

    <WidgetsSalesActivityFormDrawer
      :open="editOpen"
      mode="edit"
      :activity="activity"
      @close="editOpen = false"
      @saved="editOpen = false"
    />
  </div>
</template>
