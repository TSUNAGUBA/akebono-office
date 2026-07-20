<script setup lang="ts">
/**
 * 請求管理 + 委託精算（F-29）。ルート /akebono/billing
 * SoT = useConsignment（invoices / paymentNotices / paymentReceipts）。
 * 通常請求: 締め（洗い替え冪等）→ 発行（不変）→ 入金消込 / 訂正は赤伝。
 * 委託精算: 店舗へマージン請求 + 作家へ支払通知（発行時点の設定をスナップショット）。
 */
import { FileText, HandCoins, Plus, Wallet } from 'lucide-vue-next'
import type { Invoice, PaymentNotice, PaymentNoticeStatus } from '~/types/akebono'
import type { TableColumn, Tone } from '~/types/ui'
import { INVOICE_STATUS_LABELS, PAYOUT_METHOD_LABELS, invoiceStatusTone } from '~/utils/akebono'
import { fmtDateTime, fmtYen } from '~/utils/format'

const con = useConsignment()
const sales = useAkebonoSales()
const masters = useAkebonoMasters()
const { show } = useToast()
const { ask } = useConfirm()

// ---------- タブ ----------
const tab = ref<'billing' | 'consignment' | 'receipt'>('billing')

const salesInvoices = computed(() => con.invoices.value.filter(v => v.invoiceType === 'sales'))
const marginInvoices = computed(() => con.invoices.value.filter(v => v.invoiceType === 'consignment_margin'))
const receivableInvoices = computed(() =>
  con.invoices.value.filter(v => v.status === 'issued' || v.status === 'paid'))

const tabs = computed(() => [
  { key: 'billing', label: '請求', badge: salesInvoices.value.filter(v => v.status === 'draft').length },
  { key: 'consignment', label: '委託精算', badge: con.notices.value.filter(n => n.status === 'draft').length },
  { key: 'receipt', label: '入金', badge: con.invoices.value.filter(v => v.status === 'issued').length },
])

// ---------- 選択肢 ----------
const currentMonth = sales.currentMonth
const customerOptions = computed(() => masters.partnerCompanyOptions.value)
const consignSegmentOptions = computed(() => {
  const withTerms = new Set(masters.consignmentTerms.value.map(t => t.segmentId))
  const segs = sales.activeSegments.value.filter(s => withTerms.has(s.id))
  const list = segs.length > 0 ? segs : sales.activeSegments.value
  return list.map(s => ({ value: s.id, label: s.name }))
})
const receiptMethodOptions = [
  { value: '銀行振込', label: '銀行振込' },
  { value: '現金', label: '現金' },
  { value: 'クレジット', label: 'クレジット' },
  { value: 'その他', label: 'その他' },
]

// ---------- 支払通知の状態ラベル/トーン（当ドメイン固有・表示用） ----------
const NOTICE_STATUS_LABELS: Record<PaymentNoticeStatus, string> = {
  draft: '下書き', confirmed: '確定済み', paid: '支払済み',
}
function noticeTone(s: PaymentNoticeStatus): Tone {
  return s === 'paid' ? 'ok' : s === 'confirmed' ? 'brand' : 'warn'
}
function noticeCalcSummary(n: PaymentNotice): string {
  const s = n.snapshot
  if (s.payoutMethod === 'purchase_cost') return PAYOUT_METHOD_LABELS.purchase_cost
  return `売上 × 作家率 ${((s.payoutRate ?? 0) * 100).toFixed(0)}%`
}

// ---------- 共通ヘルパ ----------
function invoiceCode(id: string): string {
  return con.invoices.value.find(v => v.id === id)?.code ?? id
}
function asRows<T>(list: T[]): Record<string, unknown>[] {
  return list as unknown as Record<string, unknown>[]
}

// ---------- 請求タブ: 締めモーダル ----------
const closeBillOpen = ref(false)
const closeBillForm = ref({ companyId: '', periodFrom: '', periodTo: '' })
function openCloseBill(): void {
  closeBillForm.value = {
    companyId: customerOptions.value[0]?.value ?? '',
    periodFrom: `${currentMonth}-01`,
    periodTo: todayJst(),
  }
  closeBillOpen.value = true
}
function runCloseBill(): void {
  const f = closeBillForm.value
  if (!f.companyId) { show('得意先を選択してください', 'crit'); return }
  if (!f.periodFrom || !f.periodTo) { show('期間を入力してください', 'crit'); return }
  const res = con.closeBilling({ companyId: f.companyId, periodFrom: f.periodFrom, periodTo: f.periodTo })
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  show(`請求ドラフトを作成しました（対象売上 ${res.count} 件）`, 'ok')
  closeBillOpen.value = false
  if (res.id) { selectedInvoiceId.value = res.id; invoiceDrawerOpen.value = true }
}

// ---------- 請求/入金 共通: 明細ドロワー ----------
const invoiceDrawerOpen = ref(false)
const selectedInvoiceId = ref<string | null>(null)
const selectedInvoice = computed<Invoice | null>(() =>
  selectedInvoiceId.value ? (con.invoices.value.find(v => v.id === selectedInvoiceId.value) ?? null) : null)
const selectedPaid = computed(() => selectedInvoiceId.value ? con.paidAmountOf(selectedInvoiceId.value) : 0)

function openInvoice(row: Record<string, unknown>): void {
  selectedInvoiceId.value = String(row.id)
  invoiceDrawerOpen.value = true
}
function doIssue(): void {
  if (!selectedInvoice.value) return
  const res = con.issue(selectedInvoice.value.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  show('請求を発行しました', 'ok')
}
async function doVoid(): Promise<void> {
  if (!selectedInvoice.value) return
  const ok = await ask('赤伝の発行', `「${selectedInvoice.value.code}」を無効化し、赤伝（マイナス請求）を発行します。よろしいですか？`, { danger: true, confirmLabel: '赤伝発行' })
  if (!ok) return
  const res = con.voidInvoice(selectedInvoice.value.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  show('赤伝を発行しました（元請求は無効）', 'warn')
}

// ---------- 入金消込モーダル ----------
const receiptOpen = ref(false)
const receiptInvoiceId = ref('')
const receiptForm = ref({ amount: '', method: '銀行振込' })
function openReceipt(invoiceId: string): void {
  receiptInvoiceId.value = invoiceId
  const inv = con.invoices.value.find(v => v.id === invoiceId)
  const remain = inv ? inv.totalAmount - con.paidAmountOf(invoiceId) : 0
  receiptForm.value = { amount: remain > 0 ? String(remain) : '', method: '銀行振込' }
  receiptOpen.value = true
}
function runReceipt(): void {
  const amount = Number(receiptForm.value.amount)
  if (!Number.isFinite(amount) || amount <= 0) { show('入金額を正しく入力してください', 'crit'); return }
  const res = con.recordReceipt({ invoiceId: receiptInvoiceId.value, amount, method: receiptForm.value.method })
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  show('入金を記録しました', 'ok')
  receiptOpen.value = false
}

// ---------- 委託精算タブ: 締めモーダル ----------
const closeConsignOpen = ref(false)
const closeConsignForm = ref({ segmentId: '', month: currentMonth })
function openCloseConsign(): void {
  closeConsignForm.value = { segmentId: consignSegmentOptions.value[0]?.value ?? '', month: currentMonth }
  closeConsignOpen.value = true
}
function runCloseConsign(): void {
  const f = closeConsignForm.value
  if (!f.segmentId) { show('セグメントを選択してください', 'crit'); return }
  if (!f.month) { show('対象月を入力してください', 'crit'); return }
  const res = con.closeConsignment({ segmentId: f.segmentId, month: f.month })
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  show(`委託精算を締めました（マージン請求 ${res.invoices} 件・支払通知 ${res.notices} 件）`, 'ok')
  closeConsignOpen.value = false
}

// ---------- 支払通知ドロワー ----------
const noticeDrawerOpen = ref(false)
const selectedNoticeId = ref<string | null>(null)
const selectedNotice = computed<PaymentNotice | null>(() =>
  selectedNoticeId.value ? (con.notices.value.find(n => n.id === selectedNoticeId.value) ?? null) : null)
function openNotice(row: Record<string, unknown>): void {
  selectedNoticeId.value = String(row.id)
  noticeDrawerOpen.value = true
}
function doConfirmNotice(): void {
  if (!selectedNotice.value) return
  const res = con.confirmNotice(selectedNotice.value.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  show('支払通知を確定しました', 'ok')
}

// ---------- テーブル定義 ----------
const invoiceCols: TableColumn[] = [
  { key: 'code', label: 'コード', primary: true },
  { key: 'companyId', label: '得意先', primary: true },
  { key: 'period', label: '期間' },
  { key: 'totalAmount', label: '金額', align: 'right', primary: true },
  { key: 'status', label: '状態', primary: true },
]
const marginCols: TableColumn[] = [
  { key: 'code', label: 'コード', primary: true },
  { key: 'companyId', label: '店舗', primary: true },
  { key: 'period', label: '期間' },
  { key: 'totalAmount', label: '請求額', align: 'right', primary: true },
]
const noticeCols: TableColumn[] = [
  { key: 'code', label: 'コード', primary: true },
  { key: 'companyId', label: '作家', primary: true },
  { key: 'period', label: '期間' },
  { key: 'payableAmount', label: '支払額', align: 'right', primary: true },
  { key: 'status', label: '状態', primary: true },
]
const receivableCols: TableColumn[] = [
  { key: 'code', label: 'コード', primary: true },
  { key: 'companyId', label: '得意先', primary: true },
  { key: 'totalAmount', label: '請求額', align: 'right', primary: true },
  { key: 'paid', label: '入金済', align: 'right' },
  { key: 'status', label: '状態', primary: true },
]
const receiptCols: TableColumn[] = [
  { key: 'invoiceId', label: '請求', primary: true },
  { key: 'receivedAt', label: '入金日時', primary: true },
  { key: 'amount', label: '入金額', align: 'right', primary: true },
  { key: 'method', label: '方法' },
]
</script>

<template>
  <div>
    <UiPageHeader title="請求管理・委託精算" description="通常請求の締め・発行・入金消込と、委託精算（店舗マージン請求／作家支払通知）">
      <template #actions>
        <button v-if="tab === 'billing'" type="button" class="btn btn-primary btn-sm" @click="openCloseBill">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" /> 締める
        </button>
        <button v-else-if="tab === 'consignment'" type="button" class="btn btn-primary btn-sm" @click="openCloseConsign">
          <HandCoins class="h-3.5 w-3.5" aria-hidden="true" /> 委託精算を締める
        </button>
      </template>
    </UiPageHeader>

    <UiTabBar v-model="tab" :tabs="tabs" class="mb-3" />

    <!-- ============ 請求タブ ============ -->
    <div v-if="tab === 'billing'" class="grid gap-3">
      <UiSectionCard :title="`請求一覧（${salesInvoices.length}件）`" description="行をタップで明細・発行・赤伝・入金消込" flush>
        <UiDataTable
          :columns="invoiceCols"
          :rows="asRows(salesInvoices)"
          clickable
          empty-title="請求がありません"
          empty-hint="「締める」で得意先×期間の未請求売上をドラフト化します"
          @row-click="openInvoice"
        >
          <template #cell-companyId="{ row }">{{ con.companyName(String(row.companyId)) }}</template>
          <template #cell-period="{ row }">
            <span class="text-[12px] text-sub">{{ row.periodFrom }} 〜 {{ row.periodTo }}</span>
          </template>
          <template #cell-totalAmount="{ row }">
            <span class="num">{{ fmtYen(Number(row.totalAmount)) }}</span>
          </template>
          <template #cell-status="{ row }">
            <UiStatusBadge
              :label="INVOICE_STATUS_LABELS[(row.status as keyof typeof INVOICE_STATUS_LABELS)]"
              :tone="invoiceStatusTone(row.status as any)" dot
            />
          </template>
        </UiDataTable>
      </UiSectionCard>
    </div>

    <!-- ============ 委託精算タブ ============ -->
    <div v-else-if="tab === 'consignment'" class="grid gap-3">
      <UiSectionCard title="委託精算とは" flush>
        <p class="p-3 text-[13px] leading-relaxed text-sub">
          店舗が売上金を保有 → 店舗は自分の取り分を控除し残りを当社へ送金（＝当社が店舗へ請求）→ 当社から作家へ支払を行う三者精算です。
          当社の店舗宛請求額 = 売上 × (1 − 店舗取り分率)。締め時点の委託条件（店舗取り分率・作家率・端数処理等）を
          スナップショットとして凍結し、後の設定変更の影響を受けません。
          <br><span class="text-[11px] text-muted">※ 店舗取り分か当社取り分かの定義は壁打ちでの最終確認事項（決定#5 は「設定で柔軟に」）。本モックは実運用に整合する「店舗取り分」で表示。</span>
        </p>
      </UiSectionCard>

      <UiSectionCard :title="`マージン請求（${marginInvoices.length}件）`" description="店舗への請求" flush>
        <UiDataTable
          :columns="marginCols"
          :rows="asRows(marginInvoices)"
          clickable
          empty-title="マージン請求がありません"
          @row-click="openInvoice"
        >
          <template #cell-companyId="{ row }">{{ con.companyName(String(row.companyId)) }}</template>
          <template #cell-period="{ row }">
            <span class="text-[12px] text-sub">{{ row.periodFrom }} 〜 {{ row.periodTo }}</span>
          </template>
          <template #cell-totalAmount="{ row }">
            <span class="num">{{ fmtYen(Number(row.totalAmount)) }}</span>
          </template>
        </UiDataTable>
      </UiSectionCard>

      <UiSectionCard :title="`作家への支払通知（${con.notices.value.length}件）`" description="行をタップで明細・確定" flush>
        <UiDataTable
          :columns="noticeCols"
          :rows="asRows(con.notices.value)"
          clickable
          empty-title="支払通知がありません"
          @row-click="openNotice"
        >
          <template #cell-companyId="{ row }">{{ con.companyName(String(row.companyId)) }}</template>
          <template #cell-period="{ row }">
            <span class="text-[12px] text-sub">{{ row.periodFrom }} 〜 {{ row.periodTo }}</span>
          </template>
          <template #cell-payableAmount="{ row }">
            <span class="num">{{ fmtYen(Number(row.payableAmount)) }}</span>
          </template>
          <template #cell-status="{ row }">
            <UiStatusBadge
              :label="NOTICE_STATUS_LABELS[(row.status as PaymentNoticeStatus)]"
              :tone="noticeTone(row.status as PaymentNoticeStatus)" dot
            />
          </template>
        </UiDataTable>
      </UiSectionCard>
    </div>

    <!-- ============ 入金タブ ============ -->
    <div v-else class="grid gap-3">
      <UiSectionCard :title="`入金対象（${receivableInvoices.length}件）`" description="行をタップで入金を記録" flush>
        <UiDataTable
          :columns="receivableCols"
          :rows="asRows(receivableInvoices)"
          clickable
          empty-title="入金対象の請求がありません"
          empty-hint="発行済みの請求がここに表示されます"
          @row-click="(r) => openReceipt(String(r.id))"
        >
          <template #cell-companyId="{ row }">{{ con.companyName(String(row.companyId)) }}</template>
          <template #cell-totalAmount="{ row }">
            <span class="num">{{ fmtYen(Number(row.totalAmount)) }}</span>
          </template>
          <template #cell-paid="{ row }">
            <span class="num text-sub">{{ fmtYen(con.paidAmountOf(String(row.id))) }}</span>
          </template>
          <template #cell-status="{ row }">
            <UiStatusBadge
              :label="INVOICE_STATUS_LABELS[(row.status as keyof typeof INVOICE_STATUS_LABELS)]"
              :tone="invoiceStatusTone(row.status as any)" dot
            />
          </template>
        </UiDataTable>
      </UiSectionCard>

      <UiSectionCard :title="`入金履歴（${con.receipts.value.length}件）`" flush>
        <UiDataTable
          :columns="receiptCols"
          :rows="asRows(con.receipts.value)"
          empty-title="入金履歴がありません"
        >
          <template #cell-invoiceId="{ row }">{{ invoiceCode(String(row.invoiceId)) }}</template>
          <template #cell-receivedAt="{ row }">
            <span class="text-[12px] text-sub">{{ fmtDateTime(String(row.receivedAt)) }}</span>
          </template>
          <template #cell-amount="{ row }">
            <span class="num">{{ fmtYen(Number(row.amount)) }}</span>
          </template>
        </UiDataTable>
      </UiSectionCard>
    </div>

    <!-- ============ 締めモーダル（通常請求） ============ -->
    <UiModal :open="closeBillOpen" title="請求を締める" @close="closeBillOpen = false">
      <div class="grid gap-3">
        <UiFormField label="得意先" required>
          <UiSelect v-model="closeBillForm.companyId" :options="customerOptions" aria-label="得意先" />
        </UiFormField>
        <div class="grid grid-cols-2 gap-3">
          <UiFormField label="期間（開始）" required>
            <input v-model="closeBillForm.periodFrom" type="date" class="input" aria-label="期間開始">
          </UiFormField>
          <UiFormField label="期間（終了）" required>
            <input v-model="closeBillForm.periodTo" type="date" class="input" aria-label="期間終了">
          </UiFormField>
        </div>
        <p class="text-[11px] text-muted">同一得意先×期間の未発行ドラフトは洗い替え（再実行しても重複しません）。</p>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="closeBillOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" @click="runCloseBill">締める</button>
      </template>
    </UiModal>

    <!-- ============ 締めモーダル（委託精算） ============ -->
    <UiModal :open="closeConsignOpen" title="委託精算を締める" @close="closeConsignOpen = false">
      <div class="grid gap-3">
        <UiFormField label="委託セグメント" required>
          <UiSelect v-model="closeConsignForm.segmentId" :options="consignSegmentOptions" aria-label="委託セグメント" />
        </UiFormField>
        <UiFormField label="対象月" required>
          <input v-model="closeConsignForm.month" type="month" class="input" aria-label="対象月">
        </UiFormField>
        <p class="text-[11px] text-muted">
          店舗別マージン請求と作家別支払通知を発行します。対象売上には精算リンクを張り、再精算を防ぎます（冪等）。
        </p>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="closeConsignOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" @click="runCloseConsign">締める</button>
      </template>
    </UiModal>

    <!-- ============ 請求 明細ドロワー ============ -->
    <UiDrawer :open="invoiceDrawerOpen" :title="selectedInvoice ? `請求 ${selectedInvoice.code}` : '請求'" @close="invoiceDrawerOpen = false">
      <div v-if="selectedInvoice" class="grid gap-3 text-[13px]">
        <div class="flex items-center justify-between">
          <span class="text-muted">{{ con.companyName(selectedInvoice.companyId) }}</span>
          <UiStatusBadge :label="INVOICE_STATUS_LABELS[selectedInvoice.status]" :tone="invoiceStatusTone(selectedInvoice.status)" dot />
        </div>
        <div class="text-[12px] text-sub">{{ selectedInvoice.periodFrom }} 〜 {{ selectedInvoice.periodTo }}</div>

        <div class="rounded border border-line">
          <div v-for="l in selectedInvoice.lines" :key="l.id" class="flex items-center justify-between gap-2 border-b border-line px-3 py-2 last:border-0">
            <span class="min-w-0 truncate">{{ l.description }}</span>
            <span class="num shrink-0">{{ fmtYen(l.amount) }}</span>
          </div>
          <div class="flex items-center justify-between gap-2 bg-page px-3 py-2 font-bold">
            <span>合計</span>
            <span class="num">{{ fmtYen(selectedInvoice.totalAmount) }}</span>
          </div>
        </div>

        <div v-if="selectedInvoice.status !== 'draft'" class="flex items-center justify-between rounded bg-brand-soft px-3 py-2">
          <span class="text-[12px] font-semibold text-sub">入金済み</span>
          <span class="num font-bold">{{ fmtYen(selectedPaid) }}</span>
        </div>
      </div>

      <template #footer>
        <div v-if="selectedInvoice" class="flex flex-wrap items-center justify-end gap-2">
          <button v-if="selectedInvoice.status === 'draft'" type="button" class="btn btn-primary btn-sm" @click="doIssue">
            <FileText class="h-3.5 w-3.5" aria-hidden="true" /> 発行
          </button>
          <template v-else-if="selectedInvoice.status === 'issued'">
            <button v-if="selectedInvoice.invoiceType === 'sales'" type="button" class="btn btn-danger btn-sm" @click="doVoid">赤伝発行</button>
            <button type="button" class="btn btn-primary btn-sm" @click="openReceipt(selectedInvoice.id)">
              <Wallet class="h-3.5 w-3.5" aria-hidden="true" /> 入金消込
            </button>
          </template>
          <button v-else-if="selectedInvoice.status === 'paid'" type="button" class="btn btn-sm" @click="openReceipt(selectedInvoice.id)">
            追加入金
          </button>
        </div>
      </template>
    </UiDrawer>

    <!-- ============ 支払通知 ドロワー ============ -->
    <UiDrawer :open="noticeDrawerOpen" :title="selectedNotice ? `支払通知 ${selectedNotice.code}` : '支払通知'" @close="noticeDrawerOpen = false">
      <div v-if="selectedNotice" class="grid gap-3 text-[13px]">
        <div class="flex items-center justify-between">
          <span class="text-muted">{{ con.companyName(selectedNotice.companyId) }}</span>
          <UiStatusBadge :label="NOTICE_STATUS_LABELS[selectedNotice.status]" :tone="noticeTone(selectedNotice.status)" dot />
        </div>
        <div class="text-[12px] text-sub">{{ selectedNotice.periodFrom }} 〜 {{ selectedNotice.periodTo }}</div>

        <div class="rounded bg-page px-3 py-2 text-[12px]">
          <span class="font-semibold text-muted">算定方式：</span>{{ noticeCalcSummary(selectedNotice) }}
        </div>

        <div class="rounded border border-line">
          <div v-for="l in selectedNotice.lines" :key="l.id" class="flex items-center justify-between gap-2 border-b border-line px-3 py-2 last:border-0">
            <span class="min-w-0 truncate">{{ l.description }}</span>
            <span class="num shrink-0">{{ fmtYen(l.amount) }}</span>
          </div>
          <div class="flex items-center justify-between gap-2 bg-page px-3 py-2 font-bold">
            <span>支払額</span>
            <span class="num">{{ fmtYen(selectedNotice.payableAmount) }}</span>
          </div>
        </div>
      </div>

      <template #footer>
        <div v-if="selectedNotice" class="flex items-center justify-end gap-2">
          <button v-if="selectedNotice.status === 'draft'" type="button" class="btn btn-primary btn-sm" @click="doConfirmNotice">確定</button>
          <span v-else class="text-[12px] text-muted">確定済み（変更不可）</span>
        </div>
      </template>
    </UiDrawer>

    <!-- ============ 入金消込モーダル ============ -->
    <UiModal :open="receiptOpen" title="入金の記録" topmost @close="receiptOpen = false">
      <div class="grid gap-3">
        <div class="text-[12px] text-sub">請求：{{ invoiceCode(receiptInvoiceId) }}</div>
        <UiFormField label="入金額（円）" required>
          <input v-model="receiptForm.amount" type="number" min="1" step="1" class="input" placeholder="例: 120000" aria-label="入金額">
        </UiFormField>
        <UiFormField label="入金方法" required>
          <UiSelect v-model="receiptForm.method" :options="receiptMethodOptions" aria-label="入金方法" />
        </UiFormField>
        <p class="text-[11px] text-muted">部分入金が可能です。合計が請求額に達すると「入金済み」になります。</p>
      </div>
      <template #footer>
        <button type="button" class="btn btn-sm" @click="receiptOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary btn-sm" @click="runReceipt">記録する</button>
      </template>
    </UiModal>
  </div>
</template>
