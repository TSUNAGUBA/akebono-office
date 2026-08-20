<script setup lang="ts">
/**
 * インサイト（FI-03）: 分析の実行（テーマ・対象選択）と生成結果の一覧・アーカイブ。
 * 分析エンジンは決定的ヒューリスティック（モック。後日 AI 推論 + RAG + WebSearch で本実装）。
 * 生成のたびにサイクル（FI-05）を追記し、反映したフィードバックを明細で残す。
 */
import { Globe, Lightbulb, Plus, Sparkles } from 'lucide-vue-next'
import type { EngineData } from '~/utils/insight-engine'
import { generateInsightDraft } from '~/utils/insight-engine'
import type { InsightTheme, IntelInsight } from '~/types/intelligence'
import {
  ACTION_STATUS_LABELS, CONFIDENCE_LABELS, CONFIDENCE_TONES, FEEDBACK_EFFECT_LABELS,
  INSIGHT_THEME_LABELS, INSIGHT_THEME_TONES,
} from '~/utils/labels'
import { fmtDateTime, fmtInt } from '~/utils/format'

const data = useIntelligenceData()
const { insights, actions, recordGeneration, setInsightActive } = useIntelStore()
const { show } = useToast()
const { ask } = useConfirm()

// ---------- 一覧・フィルタ ----------

const filterTheme = ref('')
const showArchived = ref(false)

const themeOptions = (Object.keys(INSIGHT_THEME_LABELS) as InsightTheme[])
  .map(t => ({ value: t, label: INSIGHT_THEME_LABELS[t] }))

const filtered = computed(() =>
  insights.value
    .filter(i => (showArchived.value ? true : i.active))
    .filter(i => !filterTheme.value || i.theme === filterTheme.value)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)))

const { page, pageSize, rows: pagedInsights, total } = useListView<IntelInsight>({ source: filtered })
watch([filterTheme, showArchived], () => { page.value = 1 })

// ---------- 生成モーダル ----------

const genOpen = ref(false)
const genTheme = ref<InsightTheme>('management')
const genTargetId = ref('')
const generating = ref(false)

const companyOptions = computed(() =>
  data.companies.value.filter(c => c.active && c.kind === 'customer').map(c => ({ value: c.id, label: c.name })))
const projectOptions = computed(() =>
  data.projects.value.filter(p => p.active).map(p => ({ value: p.id, label: p.name })))

watch(genTheme, () => { genTargetId.value = '' })

/** 参照するデータの事前プレビュー（RAG 入力の透明化） */
const genPreview = computed(() => [
  { label: '日報', count: data.daily.value.filter(r => r.status === 'submitted').length },
  { label: '週報 / 月報', count: data.weekly.value.length + data.monthly.value.length },
  { label: 'サポート活動', count: data.support.value.filter(r => r.active !== false).length },
  { label: '営業活動', count: data.sales.value.filter(r => r.active !== false).length },
  { label: 'BP 活動', count: data.partner.value.filter(r => r.active !== false).length },
  { label: '顧客活動', count: data.customerLogs.value.filter(r => r.active !== false).length },
  { label: '月次売上', count: data.salesMonthly.value.length },
])

/** 反映対象の過去アクション（同テーマ・同対象。プレビュー表示用） */
const genFeedbackPreview = computed(() =>
  actions.value.filter(a =>
    a.active && a.theme === genTheme.value
    && (genTheme.value === 'management' || a.targetId === genTargetId.value)))

function openGenerate(): void {
  genTheme.value = 'management'
  genTargetId.value = ''
  genOpen.value = true
}

async function runGenerate(): Promise<void> {
  if (generating.value) return
  if (genTheme.value !== 'management' && !genTargetId.value) {
    show('分析対象を選択してください', 'warn')
    return
  }
  generating.value = true
  try {
    const engineData: EngineData = {
      daily: data.daily.value,
      weekly: data.weekly.value,
      monthly: data.monthly.value,
      support: data.support.value,
      sales: data.sales.value,
      partner: data.partner.value,
      customerLogs: data.customerLogs.value,
      salesMonthly: data.salesMonthly.value,
      companies: data.companies.value,
      projects: data.projects.value,
      members: data.members.value,
    }
    const draft = generateInsightDraft(engineData, {
      theme: genTheme.value,
      targetId: genTheme.value === 'management' ? null : genTargetId.value,
      today: todayJst(),
      pastActions: actions.value.filter(a => a.active),
    })
    if (!draft.ok) {
      show(`${draft.error.code}: ${draft.error.message}`, 'warn')
      return
    }
    const res = recordGeneration({
      theme: genTheme.value,
      targetId: genTheme.value === 'management' ? null : genTargetId.value,
      targetName: draft.targetName,
      title: draft.title,
      summary: draft.summary,
      findings: draft.findings,
      evidence: draft.evidence,
      proposals: draft.proposals,
      confidence: draft.confidence,
      feedbackConsidered: draft.feedbackConsidered,
    })
    if (!res.ok) {
      show(`${res.error.code}: ${res.error.message}`, 'warn')
      return
    }
    genOpen.value = false
    filterTheme.value = ''
    showArchived.value = false
    page.value = 1
    show(
      draft.feedbackConsidered.length > 0
        ? `インサイトを生成しました（過去アクションのフィードバック ${draft.feedbackConsidered.length} 件を反映）`
        : 'インサイトを生成しました',
      'ok',
      { label: 'サイクル履歴を見る', to: '/cycles' },
    )
  } finally {
    generating.value = false
  }
}

// ---------- アクション化 ----------

const actOpen = ref(false)
const actInsight = ref<IntelInsight | null>(null)
const actProposalId = ref<string | null>(null)
const actForm = ref({ title: '', description: '', dueDate: '' })

const { addAction } = useIntelStore()

function openActionize(ins: IntelInsight, proposalId: string): void {
  const p = ins.proposals.find(x => x.id === proposalId)
  if (!p) return
  actInsight.value = ins
  actProposalId.value = proposalId
  actForm.value = { title: p.title, description: p.description, dueDate: '' }
  actOpen.value = true
}

async function submitActionize(): Promise<void> {
  if (!actInsight.value) return
  const res = addAction({
    insightId: actInsight.value.id,
    proposalId: actProposalId.value,
    theme: actInsight.value.theme,
    targetId: actInsight.value.targetId,
    targetName: actInsight.value.targetName,
    title: actForm.value.title,
    description: actForm.value.description,
    dueDate: actForm.value.dueDate || null,
  })
  if (!res.ok) {
    show(`${res.error.code}: ${res.error.message}`, 'warn')
    return
  }
  actOpen.value = false
  show('アクションに登録しました', 'ok', { label: 'アクションを見る', to: '/actions' })
}

/** この提案から作成済みのアクション（重複作成の抑止表示） */
function actionOf(insightId: string, proposalId: string) {
  return actions.value.find(a => a.active && a.insightId === insightId && a.proposalId === proposalId)
}

// ---------- アーカイブ / 復元（原則9.5） ----------

async function onArchive(ins: IntelInsight): Promise<void> {
  const ok = await ask('インサイトのアーカイブ', `「${ins.title}」をアーカイブしますか？（復元できます）`, { confirmLabel: 'アーカイブ' })
  if (!ok) return
  const res = setInsightActive(ins.id, false)
  show(res.ok ? 'アーカイブしました（「アーカイブも表示」で復元できます）' : res.error.message, res.ok ? 'ok' : 'warn')
}

function onRestore(ins: IntelInsight): void {
  const res = setInsightActive(ins.id, true)
  show(res.ok ? '復元しました' : res.error.message, res.ok ? 'ok' : 'warn')
}
</script>

<template>
  <div>
    <UiPageHeader title="インサイト" description="共通基盤のデータと過去アクションのフィードバックから分析・提案を生成します">
      <template #actions>
        <button type="button" class="btn btn-primary btn-sm" @click="openGenerate">
          <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
          分析を実行
        </button>
      </template>
    </UiPageHeader>

    <UiFilterBar>
      <UiSelect v-model="filterTheme" :options="themeOptions" empty-label="テーマ: すべて" aria-label="テーマで絞り込み" />
      <label class="flex items-center gap-1.5 text-xs text-sub">
        <input v-model="showArchived" type="checkbox"> アーカイブも表示
      </label>
      <template #trailing>
        <span class="num text-xs text-muted">{{ filtered.length }} 件</span>
      </template>
    </UiFilterBar>

    <UiEmptyState
      v-if="filtered.length === 0"
      icon="Lightbulb"
      title="インサイトがありません"
      hint="「分析を実行」からテーマを選んで生成してください"
    />

    <div class="grid gap-3">
      <UiSectionCard
        v-for="ins in pagedInsights"
        :key="ins.id"
        :title="ins.title"
        :description="`${fmtDateTime(ins.createdAt)} / 対象: ${ins.targetName}`"
      >
        <template #actions>
          <UiStatusBadge :label="INSIGHT_THEME_LABELS[ins.theme]" :tone="INSIGHT_THEME_TONES[ins.theme]" />
          <UiStatusBadge :label="CONFIDENCE_LABELS[ins.confidence]" :tone="CONFIDENCE_TONES[ins.confidence]" />
          <UiStatusBadge v-if="!ins.active" label="アーカイブ済み" tone="neutral" />
          <button v-if="ins.active" type="button" class="btn btn-ghost btn-sm" @click="onArchive(ins)">アーカイブ</button>
          <button v-else type="button" class="btn btn-sm" @click="onRestore(ins)">復元</button>
        </template>

        <p class="text-[13px]">{{ ins.summary }}</p>

        <div class="mt-3 grid gap-3 lg:grid-cols-2">
          <!-- 発見事項 -->
          <div>
            <p class="mb-1 text-[11px] font-bold text-muted">発見事項</p>
            <ul class="grid list-disc gap-1 pl-5 text-[13px]">
              <li v-for="(f, i) in ins.findings" :key="i">{{ f }}</li>
            </ul>
            <p class="mb-1 mt-3 text-[11px] font-bold text-muted">根拠（参照データ）</p>
            <ul class="flex flex-wrap gap-1.5">
              <li
                v-for="(e, i) in ins.evidence"
                :key="i"
                class="rounded-full border border-line bg-surface-soft px-2.5 py-0.5 text-[11px]"
              >
                {{ e.label }} <span class="num text-muted">{{ fmtInt(e.count) }}件</span>
              </li>
            </ul>
            <template v-if="ins.feedbackConsidered.length > 0">
              <p class="mb-1 mt-3 text-[11px] font-bold text-brand">反映したフィードバック（前回サイクルから）</p>
              <ul class="grid gap-1 text-[12px]">
                <li v-for="fb in ins.feedbackConsidered" :key="fb.actionId" class="rounded-lg bg-brand-soft/50 px-2.5 py-1.5">
                  <span class="font-medium">{{ fb.title }}</span>
                  <span v-if="fb.rating !== null" class="num text-muted">（評価 {{ fb.rating }}/5）</span>
                  <span class="block text-[11px] text-sub">{{ FEEDBACK_EFFECT_LABELS[fb.effect] }}</span>
                </li>
              </ul>
            </template>
          </div>

          <!-- 提案 -->
          <div>
            <p class="mb-1 text-[11px] font-bold text-muted">提案（アクション化できます）</p>
            <p v-if="ins.proposals.length === 0" class="text-[12px] text-muted">提案はありません</p>
            <ul class="grid gap-2">
              <li v-for="p in ins.proposals" :key="p.id" class="rounded-lg border border-line p-2.5">
                <div class="flex items-start gap-2">
                  <div class="min-w-0 flex-1">
                    <p class="text-[13px] font-semibold">{{ p.title }}</p>
                    <p class="mt-0.5 text-[12px] text-sub">{{ p.description }}</p>
                  </div>
                  <UiStatusBadge
                    :label="p.priority === 'high' ? '優先度高' : p.priority === 'mid' ? '優先度中' : '優先度低'"
                    :tone="p.priority === 'high' ? 'warn' : p.priority === 'mid' ? 'info' : 'neutral'"
                  />
                </div>
                <div class="mt-1.5">
                  <span v-if="actionOf(ins.id, p.id)" class="text-[11px] text-ok">
                    ✓ アクション化済み（{{ ACTION_STATUS_LABELS[actionOf(ins.id, p.id)!.status] }}）
                  </span>
                  <button v-else type="button" class="btn btn-sm" @click="openActionize(ins, p.id)">
                    <Plus class="h-3.5 w-3.5" aria-hidden="true" />
                    アクション化
                  </button>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </UiSectionCard>
    </div>
    <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />

    <!-- 生成モーダル -->
    <UiModal :open="genOpen" title="分析を実行" width="560px" @close="genOpen = false">
      <div class="grid gap-3">
        <UiFormField label="テーマ" required>
          <UiRadioCards
            :model-value="genTheme"
            :options="[
              { value: 'management', label: '経営', description: '全社の活動・売上・サポートを横断分析' },
              { value: 'customer', label: '顧客', description: '特定顧客との接点・商談・サポートを分析' },
              { value: 'project', label: '案件', description: '特定案件の工数・進捗・課題を分析' },
            ]"
            aria-label="分析テーマ"
            @update:model-value="v => genTheme = v as InsightTheme"
          />
        </UiFormField>
        <UiFormField v-if="genTheme === 'customer'" label="対象顧客" required>
          <UiSelect
            :model-value="genTargetId"
            :options="companyOptions"
            empty-label="顧客を選択"
            aria-label="対象顧客"
            @update:model-value="v => genTargetId = v"
          />
        </UiFormField>
        <UiFormField v-if="genTheme === 'project'" label="対象案件" required>
          <UiSelect
            :model-value="genTargetId"
            :options="projectOptions"
            empty-label="案件を選択"
            aria-label="対象案件"
            @update:model-value="v => genTargetId = v"
          />
        </UiFormField>

        <div class="rounded-lg bg-page p-3">
          <p class="text-[11px] font-bold text-muted">参照するデータ（RAG 入力）</p>
          <ul class="mt-1 flex flex-wrap gap-1.5">
            <li
              v-for="p in genPreview"
              :key="p.label"
              class="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[11px]"
            >
              {{ p.label }} <span class="num text-muted">{{ fmtInt(p.count) }}件</span>
            </li>
          </ul>
          <p v-if="genFeedbackPreview.length > 0" class="mt-2 text-[11px] text-brand">
            過去アクション {{ genFeedbackPreview.length }} 件（フィードバック含む）をループ入力として反映します
          </p>
          <p class="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
            <Globe class="h-3.5 w-3.5" aria-hidden="true" />
            Web 検索の併用は共通 API での本実装時に有効化されます（現在はモック分析エンジン）
          </p>
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn btn-ghost" @click="genOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" :disabled="generating" @click="runGenerate">
          <Sparkles class="h-4 w-4" aria-hidden="true" />
          {{ generating ? '分析中…' : '分析を実行' }}
        </button>
      </template>
    </UiModal>

    <!-- アクション化モーダル -->
    <UiModal :open="actOpen" title="提案をアクション化" @close="actOpen = false">
      <div class="grid gap-3">
        <UiFormField label="タイトル" required>
          <input v-model="actForm.title" type="text" class="input">
        </UiFormField>
        <UiFormField label="内容">
          <textarea v-model="actForm.description" class="textarea" rows="3" />
        </UiFormField>
        <UiFormField label="期日" hint="任意">
          <input v-model="actForm.dueDate" type="date" class="input w-auto">
        </UiFormField>
      </div>
      <template #footer>
        <button type="button" class="btn btn-ghost" @click="actOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" @click="submitActionize">登録</button>
      </template>
    </UiModal>
  </div>
</template>
