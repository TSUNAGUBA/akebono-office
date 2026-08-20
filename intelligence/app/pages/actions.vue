<script setup lang="ts">
/**
 * アクション管理（FI-04）: 提案からのアクション化・手動登録・ステータス管理・
 * 結果の記録・フィードバック（5 段階 + コメント）。フィードバックは次サイクルの分析に反映される。
 */
import { Info, Plus } from 'lucide-vue-next'
import type { InsightTheme, IntelAction } from '~/types/intelligence'
import {
  ACTION_STATUS_LABELS, ACTION_STATUS_TONES, INSIGHT_THEME_LABELS, INSIGHT_THEME_TONES,
} from '~/utils/labels'
import { fmtDate, fmtDateTime } from '~/utils/format'

const data = useIntelligenceData()
const {
  actions, insights, addAction, updateAction, transitionAction, recordResult, recordFeedback, setActionActive,
} = useIntelStore()
const { show } = useToast()
const { ask } = useConfirm()

// ---------- 一覧・フィルタ ----------

const filterStatus = ref('')
const filterTheme = ref('')
const showArchived = ref(false)

const statusOptions = (Object.keys(ACTION_STATUS_LABELS) as IntelAction['status'][])
  .map(s => ({ value: s, label: ACTION_STATUS_LABELS[s] }))
const themeOptions = (Object.keys(INSIGHT_THEME_LABELS) as InsightTheme[])
  .map(t => ({ value: t, label: INSIGHT_THEME_LABELS[t] }))

const filtered = computed(() =>
  actions.value
    .filter(a => (showArchived.value ? true : a.active))
    .filter(a => !filterStatus.value || a.status === filterStatus.value)
    .filter(a => !filterTheme.value || a.theme === filterTheme.value)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))

const { page, pageSize, rows: pagedActions, total } = useListView<IntelAction>({ source: filtered })
watch([filterStatus, filterTheme, showArchived], () => { page.value = 1 })

// ---------- 手動登録 ----------

const createOpen = ref(false)
const createForm = ref({ theme: 'management' as InsightTheme, targetId: '', title: '', description: '', dueDate: '' })

const companyOptions = computed(() =>
  data.companies.value.filter(c => c.active && c.kind === 'customer').map(c => ({ value: c.id, label: c.name })))
const projectOptions = computed(() =>
  data.projects.value.filter(p => p.active).map(p => ({ value: p.id, label: p.name })))

watch(() => createForm.value.theme, () => { createForm.value.targetId = '' })

function openCreate(): void {
  createForm.value = { theme: 'management', targetId: '', title: '', description: '', dueDate: '' }
  createOpen.value = true
}

function targetNameOf(theme: InsightTheme, targetId: string): string {
  if (theme === 'management') return '全社'
  if (theme === 'customer') return data.companyName(targetId) || '未選択'
  return data.projectName(targetId) || '未選択'
}

function submitCreate(): void {
  if (createForm.value.theme !== 'management' && !createForm.value.targetId) {
    show('対象を選択してください', 'warn')
    return
  }
  const res = addAction({
    insightId: null,
    proposalId: null,
    theme: createForm.value.theme,
    targetId: createForm.value.theme === 'management' ? null : createForm.value.targetId,
    targetName: targetNameOf(createForm.value.theme, createForm.value.targetId),
    title: createForm.value.title,
    description: createForm.value.description,
    dueDate: createForm.value.dueDate || null,
  })
  if (!res.ok) {
    show(`${res.error.code}: ${res.error.message}`, 'warn')
    return
  }
  createOpen.value = false
  show('アクションを登録しました', 'ok')
}

// ---------- 詳細モーダル（編集・状態・結果・フィードバック） ----------

const detailId = ref<string | null>(null)
const detail = computed(() => (detailId.value ? actions.value.find(a => a.id === detailId.value) : undefined))
const originInsight = computed(() =>
  detail.value?.insightId ? insights.value.find(i => i.id === detail.value!.insightId) : undefined)

const editForm = ref({ title: '', description: '', dueDate: '' })
const resultText = ref('')
const fbForm = ref({ rating: 0, note: '', next: '' })

function openDetail(a: IntelAction): void {
  detailId.value = a.id
  editForm.value = { title: a.title, description: a.description, dueDate: a.dueDate ?? '' }
  resultText.value = a.result
  fbForm.value = { rating: a.feedbackRating ?? 0, note: a.feedbackNote, next: a.feedbackNext }
}

function saveEdit(): void {
  if (!detailId.value) return
  const res = updateAction(detailId.value, {
    title: editForm.value.title,
    description: editForm.value.description,
    dueDate: editForm.value.dueDate || null,
  })
  show(res.ok ? '基本情報を保存しました' : `${res.error.code}: ${res.error.message}`, res.ok ? 'ok' : 'warn')
}

/** 現在の状態から遷移できる候補（完了・中止の取消も含む = 原則9.5） */
const TRANSITIONS: Record<IntelAction['status'], { to: IntelAction['status']; label: string }[]> = {
  planned: [{ to: 'in_progress', label: '実行開始' }, { to: 'cancelled', label: '中止' }],
  in_progress: [{ to: 'done', label: '完了にする' }, { to: 'planned', label: '計画へ戻す' }, { to: 'cancelled', label: '中止' }],
  done: [{ to: 'in_progress', label: '完了を取り消す（実行中へ戻す）' }],
  cancelled: [{ to: 'planned', label: '中止を取り消す（計画へ戻す）' }],
}

function onTransition(next: IntelAction['status']): void {
  if (!detailId.value) return
  const res = transitionAction(detailId.value, next)
  if (!res.ok) {
    show(`${res.error.code}: ${res.error.message}`, 'warn')
    return
  }
  show(`ステータスを「${ACTION_STATUS_LABELS[next]}」へ変更しました`, 'ok')
  if (next === 'done') {
    show('結果とフィードバックを記録すると、次回の分析に反映されます', 'info')
  }
}

function saveResult(): void {
  if (!detailId.value) return
  const res = recordResult(detailId.value, resultText.value)
  show(res.ok ? '結果を記録しました（再記録で上書きできます）' : `${res.error.code}: ${res.error.message}`, res.ok ? 'ok' : 'warn')
}

function saveFeedback(): void {
  if (!detailId.value) return
  if (!fbForm.value.rating) {
    show('評価（1〜5）を選択してください', 'warn')
    return
  }
  const res = recordFeedback(detailId.value, fbForm.value.rating, fbForm.value.note, fbForm.value.next)
  if (!res.ok) {
    show(`${res.error.code}: ${res.error.message}`, 'warn')
    return
  }
  show('フィードバックを記録しました。次回の分析（同テーマ・同対象）に反映されます', 'ok', { label: 'ループ履歴', to: '/cycles' })
}

async function onArchive(a: IntelAction): Promise<void> {
  const ok = await ask('アクションのアーカイブ', `「${a.title}」をアーカイブしますか？（復元できます）`, { confirmLabel: 'アーカイブ' })
  if (!ok) return
  const res = setActionActive(a.id, false)
  if (res.ok) detailId.value = null
  show(res.ok ? 'アーカイブしました（「アーカイブも表示」で復元できます）' : res.error.message, res.ok ? 'ok' : 'warn')
}

function onRestore(a: IntelAction): void {
  const res = setActionActive(a.id, true)
  show(res.ok ? '復元しました' : res.error.message, res.ok ? 'ok' : 'warn')
}
</script>

<template>
  <div>
    <UiPageHeader title="アクション" description="提案から実行したアクションと結果・フィードバックを記録します（次サイクルの分析に反映）">
      <template #actions>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" aria-hidden="true" />
          アクションを登録
        </button>
      </template>
    </UiPageHeader>

    <!-- モック境界の明示（N-4。R1 監査指摘: 記録の保存先と制約を画面で伝える） -->
    <div class="mb-3 flex items-start gap-2 rounded-lg border border-info/40 bg-info-soft p-3 text-xs leading-relaxed">
      <Info class="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
      <p class="text-sub">
        アクション・結果・フィードバックの記録は
        <span class="font-semibold">このブラウザに保存されます（端末間同期なし。ブラウザデータの消去で失われます）。</span>
        共通 API での本実装（サーバー保存）までの暫定機能です。
      </p>
    </div>

    <UiFilterBar>
      <UiSelect v-model="filterStatus" :options="statusOptions" empty-label="ステータス: すべて" aria-label="ステータスで絞り込み" />
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
      icon="ListChecks"
      title="アクションがありません"
      hint="インサイトの提案から「アクション化」するか、手動で登録してください"
    />

    <ul class="grid gap-2">
      <li v-for="a in pagedActions" :key="a.id">
        <button
          type="button"
          class="card w-full px-3 py-2.5 text-left transition-colors hover:border-brand"
          @click="openDetail(a)"
        >
          <div class="flex flex-wrap items-center gap-1.5">
            <UiStatusBadge :label="ACTION_STATUS_LABELS[a.status]" :tone="ACTION_STATUS_TONES[a.status]" dot />
            <UiStatusBadge :label="INSIGHT_THEME_LABELS[a.theme]" :tone="INSIGHT_THEME_TONES[a.theme]" />
            <span class="text-[11px] text-muted">{{ a.targetName }}</span>
            <UiStatusBadge v-if="!a.active" label="アーカイブ済み" tone="neutral" />
            <span v-if="a.feedbackRating !== null" class="num ml-auto text-[11px] text-brand">評価 {{ a.feedbackRating }}/5</span>
          </div>
          <p class="mt-1 text-[13px] font-semibold">{{ a.title }}</p>
          <p class="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
            <span v-if="a.dueDate" class="num" :class="a.dueDate < todayJst() && (a.status === 'planned' || a.status === 'in_progress') ? 'font-semibold text-crit' : ''">期日 {{ fmtDate(a.dueDate) }}</span>
            <span>担当 {{ data.memberName(a.ownerId) }}</span>
            <span class="num">更新 {{ fmtDateTime(a.updatedAt) }}</span>
          </p>
        </button>
      </li>
    </ul>
    <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />

    <!-- 手動登録モーダル -->
    <UiModal :open="createOpen" title="アクションを登録" @close="createOpen = false">
      <div class="grid gap-3">
        <UiFormField label="テーマ" required>
          <UiSelect
            :model-value="createForm.theme"
            :options="themeOptions"
            aria-label="テーマ"
            @update:model-value="v => createForm.theme = v as InsightTheme"
          />
        </UiFormField>
        <UiFormField v-if="createForm.theme === 'customer'" label="対象顧客" required>
          <UiSelect
            :model-value="createForm.targetId"
            :options="companyOptions"
            empty-label="顧客を選択"
            aria-label="対象顧客"
            @update:model-value="v => createForm.targetId = v"
          />
        </UiFormField>
        <UiFormField v-if="createForm.theme === 'project'" label="対象案件" required>
          <UiSelect
            :model-value="createForm.targetId"
            :options="projectOptions"
            empty-label="案件を選択"
            aria-label="対象案件"
            @update:model-value="v => createForm.targetId = v"
          />
        </UiFormField>
        <UiFormField label="タイトル" required>
          <input v-model="createForm.title" type="text" class="input" placeholder="例: 主要顧客のフォローアップ定例の設定">
        </UiFormField>
        <UiFormField label="内容">
          <textarea v-model="createForm.description" class="textarea" rows="3" />
        </UiFormField>
        <UiFormField label="期日" hint="任意">
          <input v-model="createForm.dueDate" type="date" class="input w-auto">
        </UiFormField>
      </div>
      <template #footer>
        <button type="button" class="btn btn-ghost" @click="createOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" @click="submitCreate">登録</button>
      </template>
    </UiModal>

    <!-- 詳細モーダル -->
    <UiModal :open="!!detail" :title="detail?.title ?? ''" width="680px" @close="detailId = null">
      <div v-if="detail" class="grid gap-4">
        <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          <UiStatusBadge :label="ACTION_STATUS_LABELS[detail.status]" :tone="ACTION_STATUS_TONES[detail.status]" dot />
          <UiStatusBadge :label="INSIGHT_THEME_LABELS[detail.theme]" :tone="INSIGHT_THEME_TONES[detail.theme]" />
          <span>対象: {{ detail.targetName }}</span>
          <span>担当: {{ data.memberName(detail.ownerId) }}</span>
          <NuxtLink v-if="originInsight" to="/insights" class="link">由来インサイト: {{ originInsight.title }}</NuxtLink>
        </div>

        <!-- ステータス遷移 -->
        <div class="flex flex-wrap gap-2">
          <button
            v-for="t in TRANSITIONS[detail.status]"
            :key="t.to"
            type="button"
            class="btn btn-sm"
            :class="t.to === 'done' ? 'btn-primary' : t.to === 'cancelled' ? 'btn-danger' : ''"
            @click="onTransition(t.to)"
          >
            {{ t.label }}
          </button>
          <template v-if="detail.active">
            <button type="button" class="btn btn-ghost btn-sm ml-auto" @click="onArchive(detail)">アーカイブ</button>
          </template>
          <button v-else type="button" class="btn btn-sm ml-auto" @click="onRestore(detail)">復元</button>
        </div>

        <!-- 基本情報の編集 -->
        <details class="rounded-lg border border-line">
          <summary class="cursor-pointer px-3 py-2 text-[13px] font-semibold hover:bg-brand-soft">基本情報の編集</summary>
          <div class="grid gap-3 border-t border-line p-3">
            <UiFormField label="タイトル" required>
              <input v-model="editForm.title" type="text" class="input">
            </UiFormField>
            <UiFormField label="内容">
              <textarea v-model="editForm.description" class="textarea" rows="3" />
            </UiFormField>
            <UiFormField label="期日">
              <input v-model="editForm.dueDate" type="date" class="input w-auto">
            </UiFormField>
            <div>
              <button type="button" class="btn btn-primary btn-sm" @click="saveEdit">保存</button>
            </div>
          </div>
        </details>

        <div v-if="detail.description" class="rounded-lg bg-page p-3">
          <p class="text-[11px] font-bold text-muted">内容</p>
          <p class="mt-0.5 whitespace-pre-wrap text-[13px]">{{ detail.description }}</p>
        </div>

        <!-- 結果の記録 -->
        <div class="grid gap-2">
          <p class="text-[11px] font-bold text-muted">実施内容・結果の記録</p>
          <textarea
            v-model="resultText"
            class="textarea min-h-20"
            placeholder="実施した内容と結果を記録（再記録で上書きできます）"
            aria-label="実施内容・結果"
          />
          <div>
            <button type="button" class="btn btn-sm" @click="saveResult">結果を保存</button>
          </div>
        </div>

        <!-- フィードバック -->
        <div class="grid gap-2 rounded-lg border border-brand/40 bg-brand-soft/30 p-3">
          <p class="text-[11px] font-bold text-brand">フィードバック（次回の分析に反映されます）</p>
          <UiFormField label="評価（5 段階）" required>
            <div class="flex gap-1.5" role="radiogroup" aria-label="評価">
              <button
                v-for="r in [1, 2, 3, 4, 5]"
                :key="r"
                type="button"
                class="btn btn-sm num min-w-9"
                :class="fbForm.rating === r ? 'btn-primary' : ''"
                role="radio"
                :aria-checked="fbForm.rating === r"
                @click="fbForm.rating = r"
              >
                {{ r }}
              </button>
            </div>
          </UiFormField>
          <UiFormField label="効果・所感">
            <textarea v-model="fbForm.note" class="textarea" rows="2" placeholder="施策の効果、うまくいった点・いかなかった点" />
          </UiFormField>
          <UiFormField label="次回に活かす点">
            <textarea v-model="fbForm.next" class="textarea" rows="2" placeholder="次のサイクルで試したいこと・変えたいこと" />
          </UiFormField>
          <div>
            <button type="button" class="btn btn-primary btn-sm" @click="saveFeedback">フィードバックを保存</button>
          </div>
        </div>
      </div>
    </UiModal>
  </div>
</template>
