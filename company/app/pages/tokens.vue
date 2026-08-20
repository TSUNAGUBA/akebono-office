<script setup lang="ts">
/**
 * トークン管理（FC-06）: 消費の可視化・月末予測・予算設定・抑制/制限。
 * 予算・制限の SoT はフロント localStorage（モック。後日共通 API で本実装 = requirements §5）。
 * 設定の編集は admin のみ。閲覧は全員。
 */
import { Info, RotateCcw, Save } from 'lucide-vue-next'
import { fmtInt } from '~/utils/format'

const { employees } = useAiCompany()
const {
  settings, saveSettings, resetSettings, usage,
  tokenBudgetPct, costBudgetPct, budgetState, employeeUsage,
} = useTokenBudget()
const { isAdmin } = useCurrentUser()
const { show } = useToast()
const { ask } = useConfirm()

// ---------- 可視化 ----------

const dayLabels = computed(() => usage.value.byDay.map(d => d.date.slice(8)))
const daySeries = computed(() => [{ label: 'トークン', data: usage.value.byDay.map(d => d.tokens) }])
const empItems = computed(() => usage.value.byEmployee.map(e => ({ label: e.name, value: e.tokens })))
const tierItems = computed(() =>
  usage.value.byTier.map(t => ({ label: AI_MODEL_TIER_LABELS[t.tier], value: t.tokens })))

const stateMeta = computed(() => ({
  ok: { label: '正常', tone: 'ok' as const },
  warn: { label: '警告（閾値超過）', tone: 'warn' as const },
  over: { label: '予算超過', tone: 'crit' as const },
}[budgetState.value]))

function pctBarClass(pct: number | null): string {
  if (pct === null) return 'bg-neutral-soft'
  if (pct >= 100) return 'bg-crit'
  if (pct >= settings.value.alertThresholdPct) return 'bg-warn'
  return 'bg-ok'
}

// ---------- 予算設定フォーム（admin。編集で上書き = 取消可能。原則9.5） ----------

// type=number の v-model は数値で届くため string | number で保持し、保存時に parsePositive で正規化する
const form = ref({
  monthlyTokenBudget: '' as string | number,
  monthlyCostBudgetUsd: '' as string | number,
  alertThresholdPct: 80,
  overBudgetAction: 'warn' as 'warn' | 'block',
  perEmployee: {} as Record<string, string | number>,
})

/** 保存済み設定をフォームへ反映する */
function loadForm(): void {
  const s = settings.value
  form.value = {
    monthlyTokenBudget: s.monthlyTokenBudget !== null ? String(s.monthlyTokenBudget) : '',
    monthlyCostBudgetUsd: s.monthlyCostBudgetUsd !== null ? String(s.monthlyCostBudgetUsd) : '',
    alertThresholdPct: s.alertThresholdPct,
    overBudgetAction: s.overBudgetAction,
    perEmployee: Object.fromEntries(
      employees.value.map(e => [e.id, s.perEmployeeMonthlyTokens[e.id] !== undefined ? String(s.perEmployeeMonthlyTokens[e.id]) : '']),
    ),
  }
}

onMounted(loadForm)
watch(employees, loadForm)

const formError = ref('')

/** 入力値の検証（type=number の v-model は数値で届くため string | number 両対応。空 = 未設定） */
function parsePositive(v: string | number, label: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const t = String(v ?? '').trim()
  if (!t) return { ok: true, value: null }
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return { ok: false, message: `${label}は正の数値で入力してください` }
  return { ok: true, value: n }
}

function onSave(): void {
  formError.value = ''
  const token = parsePositive(form.value.monthlyTokenBudget, '月間トークン予算')
  if (!token.ok) { formError.value = token.message; return }
  const cost = parsePositive(form.value.monthlyCostBudgetUsd, '月間コスト予算')
  if (!cost.ok) { formError.value = cost.message; return }
  const per: Record<string, number> = {}
  for (const [empId, v] of Object.entries(form.value.perEmployee)) {
    const p = parsePositive(v, 'AI 社員別上限')
    if (!p.ok) { formError.value = p.message; return }
    if (p.value !== null) per[empId] = Math.floor(p.value)
  }
  const saved = saveSettings({
    monthlyTokenBudget: token.value !== null ? Math.floor(token.value) : null,
    monthlyCostBudgetUsd: cost.value,
    alertThresholdPct: form.value.alertThresholdPct,
    overBudgetAction: form.value.overBudgetAction,
    perEmployeeMonthlyTokens: per,
  })
  if (!saved) {
    show('設定の保存に失敗しました（ブラウザの保存領域を確認してください）', 'warn')
    return
  }
  loadForm()
  show('トークン予算設定を保存しました', 'ok')
}

async function onReset(): Promise<void> {
  const ok = await ask('既定値へリセット', 'トークン予算設定を既定値へ戻します。', { confirmLabel: 'リセット' })
  if (!ok) return
  resetSettings()
  loadForm()
  show('既定値へ戻しました', 'ok')
}
</script>

<template>
  <div>
    <UiPageHeader title="トークン管理" description="AI 使用によるトークン消費と予測費用の可視化・予算による抑制・制限" />

    <!-- モック境界の明示（N-4） -->
    <div class="mb-3 flex items-start gap-2 rounded-lg border border-info/40 bg-info-soft p-3 text-xs leading-relaxed">
      <Info class="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
      <p class="text-sub">
        トークン実測値は現在モック値（決定的な擬似値）です。予算・制限の設定はこのブラウザに保存され（端末間同期なし）、
        依頼・承認のブロックは画面側の抑止です。<span class="font-semibold">いずれも共通 API での本実装までの暫定機能です。</span>
      </p>
    </div>

    <!-- サマリー KPI -->
    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <UiKpiCard label="当月トークン" :value="fmtInt(usage.totalTokens)" icon="Gauge" />
      <UiKpiCard label="当月概算コスト" :value="`$${usage.totalCostUsd.toFixed(2)}`" icon="CircleDollarSign" />
      <UiKpiCard label="月末予測トークン" :value="fmtInt(usage.forecastTokens)" sub="経過日の日平均 × 月日数" icon="TrendingUp" />
      <UiKpiCard label="月末予測コスト" :value="`$${usage.forecastCostUsd.toFixed(2)}`" sub="経過日の日平均 × 月日数" icon="TrendingUp" />
    </div>

    <!-- 予算消化率 -->
    <UiSectionCard class="mt-3" title="予算の消化状況">
      <template #actions>
        <UiStatusBadge :label="stateMeta.label" :tone="stateMeta.tone" dot />
      </template>
      <div class="grid gap-3 md:grid-cols-2">
        <div>
          <div class="flex items-baseline justify-between text-xs">
            <span class="font-semibold text-sub">トークン予算</span>
            <span class="num text-muted">
              {{ fmtInt(usage.totalTokens) }} /
              {{ settings.monthlyTokenBudget !== null ? fmtInt(settings.monthlyTokenBudget) : '未設定' }}
              <template v-if="tokenBudgetPct !== null">（{{ tokenBudgetPct }}%）</template>
            </span>
          </div>
          <div class="mt-1 h-2 overflow-hidden rounded-full bg-neutral-soft" role="progressbar" :aria-valuenow="tokenBudgetPct ?? 0" aria-valuemin="0" aria-valuemax="100" aria-label="トークン予算の消化率">
            <div class="h-full rounded-full" :class="pctBarClass(tokenBudgetPct)" :style="{ width: `${Math.min(100, tokenBudgetPct ?? 0)}%` }" />
          </div>
        </div>
        <div>
          <div class="flex items-baseline justify-between text-xs">
            <span class="font-semibold text-sub">コスト予算（USD）</span>
            <span class="num text-muted">
              ${{ usage.totalCostUsd.toFixed(2) }} /
              {{ settings.monthlyCostBudgetUsd !== null ? `$${settings.monthlyCostBudgetUsd.toFixed(2)}` : '未設定' }}
              <template v-if="costBudgetPct !== null">（{{ costBudgetPct }}%）</template>
            </span>
          </div>
          <div class="mt-1 h-2 overflow-hidden rounded-full bg-neutral-soft" role="progressbar" :aria-valuenow="costBudgetPct ?? 0" aria-valuemin="0" aria-valuemax="100" aria-label="コスト予算の消化率">
            <div class="h-full rounded-full" :class="pctBarClass(costBudgetPct)" :style="{ width: `${Math.min(100, costBudgetPct ?? 0)}%` }" />
          </div>
        </div>
      </div>
    </UiSectionCard>

    <!-- チャート -->
    <div class="mt-3 grid gap-3 lg:grid-cols-3">
      <ChartsBarChartCard
        class="lg:col-span-1"
        title="日別トークン消費（当月）"
        :labels="dayLabels"
        :series="daySeries"
        :y-formatter="fmtInt"
      />
      <ChartsDonutChartCard title="AI 社員別（当月）" :items="empItems" :value-formatter="fmtInt" />
      <ChartsDonutChartCard title="モデルティア別（当月）" :items="tierItems" :value-formatter="fmtInt" />
    </div>

    <!-- AI 社員別の消費と上限 -->
    <UiSectionCard class="mt-3" title="AI 社員別の消費と上限" description="上限を設定した AI 社員は、超過時に新規依頼をブロックできます（超過時動作 = ブロックの場合）">
      <div class="overflow-x-auto">
        <table class="tbl min-w-[480px]">
          <thead>
            <tr>
              <th>AI 社員</th>
              <th class="text-right">当月消費</th>
              <th class="text-right">月間上限</th>
              <th>状態</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in employees" :key="e.id">
              <td>{{ e.name }}</td>
              <td class="num text-right">{{ fmtInt(employeeUsage(e.id).tokens) }}</td>
              <td class="num text-right">
                {{ employeeUsage(e.id).cap !== null ? fmtInt(employeeUsage(e.id).cap!) : '—' }}
              </td>
              <td>
                <UiStatusBadge
                  v-if="employeeUsage(e.id).over"
                  label="上限超過"
                  tone="crit"
                />
                <span v-else class="text-[11px] text-muted">正常</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiSectionCard>

    <!-- 予算設定（admin） -->
    <UiSectionCard
      v-if="isAdmin"
      class="mt-3"
      title="予算・制限の設定"
      description="編集して保存で上書きできます（既定値へのリセットも可能）。設定はこのブラウザに保存されます（モック）"
    >
      <div class="grid gap-3 md:grid-cols-2">
        <UiFormField label="月間トークン予算" hint="空欄 = 制限なし">
          <input v-model="form.monthlyTokenBudget" type="number" min="1" class="input num" placeholder="例: 2000000">
        </UiFormField>
        <UiFormField label="月間コスト予算（USD）" hint="空欄 = 制限なし">
          <input v-model="form.monthlyCostBudgetUsd" type="number" min="0.01" step="0.01" class="input num" placeholder="例: 20">
        </UiFormField>
        <UiFormField label="アラート閾値（%）" hint="この割合を超えると警告します（50〜100）">
          <input v-model.number="form.alertThresholdPct" type="number" min="50" max="100" class="input num">
        </UiFormField>
        <UiFormField label="予算超過時の動作">
          <div class="grid gap-1.5" role="radiogroup" aria-label="予算超過時の動作">
            <label class="flex items-center gap-2 text-[13px]">
              <input v-model="form.overBudgetAction" type="radio" value="warn"> 警告のみ（依頼・承認は継続可能）
            </label>
            <label class="flex items-center gap-2 text-[13px]">
              <input v-model="form.overBudgetAction" type="radio" value="block"> 新規の依頼・承認をブロック
            </label>
          </div>
        </UiFormField>
      </div>

      <p class="label mt-3">AI 社員別 月間トークン上限（空欄 = 上限なし）</p>
      <div class="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
        <label v-for="e in employees" :key="e.id" class="flex items-center gap-2 text-[13px]">
          <span class="w-20 shrink-0 truncate">{{ e.name }}</span>
          <input v-model="form.perEmployee[e.id]" type="number" min="1" class="input num" placeholder="例: 500000">
        </label>
      </div>

      <p v-if="formError" class="mt-2 text-xs text-crit" role="alert">{{ formError }}</p>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" class="btn btn-primary" @click="onSave">
          <Save class="h-4 w-4" aria-hidden="true" /> 保存
        </button>
        <button type="button" class="btn" @click="onReset">
          <RotateCcw class="h-4 w-4" aria-hidden="true" /> 既定値へリセット
        </button>
      </div>
    </UiSectionCard>
    <p v-else class="mt-3 text-xs text-muted">予算・制限の設定変更は管理者のみ行えます。</p>
  </div>
</template>
