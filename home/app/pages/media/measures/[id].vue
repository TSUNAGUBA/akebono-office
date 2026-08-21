<script setup lang="ts">
/**
 * 改善施策の詳細（/media/measures/:id。改善要望 2026-08-21・F-56）。
 * 上段 = 改善施策（施策名 / 背景・目的 / 実施内容 / 対象 / 期待する変化 / 担当 / 期限 / ステータス / 発生元）・
 * 下段 = 効果検証（実施日 / 実施内容 / 比較期間 / KPI 実施前 → 実施後 → 変化 → 目標 / AI評価 /
 * 人の最終評価 / 学び / Next Action）。詳細は AI（レポート・集計値）で生成しつつ全項目をユーザーが編集できる。
 * 担当・ステータス等の選択はオートコンプリート付きドロップダウン（UiCombobox）。取消/復元 = 原則9.5。
 */
import { ArrowLeft, RotateCcw, Sparkles, Trash2 } from 'lucide-vue-next'
import {
  MEDIA_MEASURE_EVALUATIONS, MEDIA_MEASURE_STATUSES, emptyVerification,
  type MediaMeasureVerification,
} from '../../../../../shared/domain/media-weekly-report'
import { MEDIA_MEASURE_STATUS_TONES } from '~/composables/useMediaReports'
import { fmtDateTime } from '~/utils/format'
import type { Member } from '~/types/domain'
import type { MediaChannel } from '~/types/media'

const route = useRoute()
const router = useRouter()
const mr = useMediaReports()
const { tbl } = useMockDb()
const { show } = useToast()
const confirm = useConfirm()

const measureId = computed(() => String(route.params.id ?? ''))
const fetched = ref<ReturnType<typeof mr.measureById>>(null)
const loading = ref(true)
// 一覧キャッシュ優先（編集の反映が即時に見える）。未ロード時は単件フェッチで補完（レポート詳細と同型）
const measure = computed(() => mr.measureById(measureId.value) ?? fetched.value)

watchEffect(async () => {
  const id = measureId.value
  if (!id) return
  loading.value = true
  fetched.value = await mr.fetchMeasure(id)
  loading.value = false
})

const channels = computed(() => tbl('mediaChannels').value as MediaChannel[])
const members = computed(() => (tbl('members').value as Member[]).filter(m => m.active !== false))
const memberOptions = computed(() => members.value.map(m => ({ value: m.id, label: m.name })))
const statusOptions = MEDIA_MEASURE_STATUSES.map(s => ({ value: s, label: s }))
const evaluationOptions = [{ value: '', label: '未評価' }, ...MEDIA_MEASURE_EVALUATIONS.map(e => ({ value: e, label: e }))]

function channelName(id: string): string {
  return channels.value.find(c => c.id === id)?.name ?? id
}

// ---------- 編集ドラフト（measure から初期化。保存で反映） ----------
const form = ref({
  name: '', background: '', content: '', target: '', expectedChange: '',
  assigneeMemberId: '', dueDate: '' as string, status: '実施予定',
})
const assigneeText = ref('')
const verification = ref<MediaMeasureVerification>(emptyVerification())
const initializedFor = ref('')

watchEffect(() => {
  const m = measure.value
  if (!m || initializedFor.value === m.id) return
  form.value = {
    name: m.name, background: m.background, content: m.content, target: m.target,
    expectedChange: m.expectedChange, assigneeMemberId: m.assigneeMemberId,
    dueDate: m.dueDate ?? '', status: m.status,
  }
  assigneeText.value = members.value.find(x => x.id === m.assigneeMemberId)?.name ?? ''
  verification.value = { ...emptyVerification(), ...m.verification }
  initializedFor.value = m.id
})

const saving = ref(false)

/** ドラフト全体の保存。成功で true（AI 評価の前段でも使う = 未保存の編集を黙って捨てない） */
async function persistDraft(): Promise<boolean> {
  if (!measure.value) return false
  if (!form.value.name.trim()) { show('施策名を入力してください', 'warn'); return false }
  const res = await mr.saveMeasure(measure.value.id, {
    name: form.value.name,
    background: form.value.background,
    content: form.value.content,
    target: form.value.target,
    expectedChange: form.value.expectedChange,
    assigneeMemberId: form.value.assigneeMemberId,
    dueDate: form.value.dueDate || null,
    status: form.value.status,
    verification: verification.value,
  })
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return false }
  return true
}

async function save(): Promise<void> {
  if (saving.value || !measure.value) return
  saving.value = true
  try {
    if (!(await persistDraft())) return
    show('改善施策を保存しました')
    initializedFor.value = '' // 最新値でドラフトを再初期化
  } finally { saving.value = false }
}

const evaluating = ref(false)

/** 効果検証の AI 評価（実施日前後の週次比較。生成後も編集可）。
 *  先にドラフト全体を保存してから評価する（未保存の編集を確認なしに破棄しない = レビュー R1 m-6） */
async function aiEvaluate(): Promise<void> {
  if (evaluating.value || !measure.value) return
  evaluating.value = true
  try {
    if (!(await persistDraft())) return
    const res = await mr.aiEvaluate(measure.value.id)
    if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
    show('AI 評価を生成しました（内容は編集できます）')
    initializedFor.value = '' // 生成結果でドラフトを再初期化
  } finally { evaluating.value = false }
}

async function onArchive(): Promise<void> {
  if (!measure.value) return
  const ok = await confirm.ask('改善施策の取消', `「${measure.value.name}」を取り消しますか？（一覧の取消済みから復元できます）`,
    { danger: true, confirmLabel: '取り消す' })
  if (!ok) return
  const res = await mr.archiveMeasure(measure.value.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  show('取り消しました', 'warn')
  void router.push('/media/measures')
}

async function onRestore(): Promise<void> {
  if (!measure.value) return
  const res = await mr.restoreMeasure(measure.value.id)
  if (!res.ok) { show(`${res.error.code}: ${res.error.message}`, 'crit'); return }
  show('復元しました')
}
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <UiPageHeader
      :title="measure ? measure.name : '改善施策'"
      :description="measure ? `${channelName(measure.channelId)}・発生元：${measure.sourceLabel || '手動起票'}` : ''"
    >
      <template #actions>
        <NuxtLink to="/media/measures" class="btn btn-sm">
          <ArrowLeft class="h-3.5 w-3.5" aria-hidden="true" />
          一覧へ
        </NuxtLink>
      </template>
    </UiPageHeader>

    <UiEmptyState
      v-if="!measure && !loading"
      icon="ClipboardCheck"
      title="改善施策が見つかりません"
      hint="取り消された施策は一覧の「取消済み」から復元できます"
    >
      <template #action>
        <NuxtLink to="/media/measures" class="btn btn-primary btn-sm">改善施策一覧へ戻る</NuxtLink>
      </template>
    </UiEmptyState>
    <p v-else-if="!measure" class="py-10 text-center text-[13px] text-muted" aria-live="polite" aria-busy="true">
      改善施策を読み込み中…
    </p>

    <div v-else class="grid gap-4">
      <div class="flex flex-wrap items-center gap-2">
        <UiStatusBadge :label="measure.status" :tone="MEDIA_MEASURE_STATUS_TONES[measure.status] ?? 'neutral'" dot />
        <UiStatusBadge v-if="measure.active === false" label="取消済み" tone="crit" />
        <span class="text-[11px] text-muted">起票 {{ fmtDateTime(measure.createdAt) }}</span>
        <span class="ml-auto flex items-center gap-1.5">
          <button v-if="measure.active === false" type="button" class="btn btn-sm" @click="onRestore">
            <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
            元に戻す
          </button>
          <button v-else type="button" class="btn btn-ghost btn-sm" aria-label="この施策を取り消す" @click="onArchive">
            <Trash2 class="h-3.5 w-3.5 text-crit" aria-hidden="true" />
          </button>
          <button type="button" class="btn btn-primary btn-sm" :disabled="saving || measure.active === false" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </span>
      </div>

      <!-- ──────────── 改善施策 ──────────── -->
      <UiSectionCard title="改善施策" description="AI が起票した内容をベースに、全項目を編集できます">
        <div class="grid gap-3">
          <UiFormField label="施策名" required>
            <input v-model="form.name" type="text" class="input" aria-label="施策名">
          </UiFormField>
          <UiFormField label="背景・目的">
            <textarea v-model="form.background" class="textarea min-h-16" aria-label="背景・目的" />
          </UiFormField>
          <UiFormField label="実施内容">
            <textarea v-model="form.content" class="textarea min-h-16" aria-label="実施内容" />
          </UiFormField>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <UiFormField label="対象" hint="記事・セクション・導線など">
              <input v-model="form.target" type="text" class="input" aria-label="対象">
            </UiFormField>
            <UiFormField label="期待する変化">
              <input v-model="form.expectedChange" type="text" class="input" aria-label="期待する変化">
            </UiFormField>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <UiFormField label="担当">
              <UiCombobox
                v-model="form.assigneeMemberId" v-model:text="assigneeText" :options="memberOptions"
                :allow-create="false" :show-value="false" placeholder="担当者名で検索" aria-label="担当"
              />
            </UiFormField>
            <UiFormField label="期限">
              <input v-model="form.dueDate" type="date" class="input" aria-label="期限">
            </UiFormField>
            <UiFormField label="ステータス">
              <UiSelect v-model="form.status" :options="statusOptions" aria-label="ステータス" />
            </UiFormField>
          </div>
          <p class="text-[11px] text-muted">発生元：{{ measure.sourceLabel || '手動起票' }}
            <NuxtLink v-if="measure.sourceReportId" :to="`/media/reports/${measure.sourceReportId}`" class="link ml-1">レポートを開く</NuxtLink>
          </p>
        </div>
      </UiSectionCard>

      <!-- ──────────── 効果検証 ──────────── -->
      <UiSectionCard
        title="効果検証"
        description="実施前後の KPI を比較して効果を検証します。「AIで評価」は実施日前後の週次比較から自動生成し、内容は編集できます"
      >
        <template #actions>
          <button type="button" class="btn btn-sm" :disabled="evaluating || measure.active === false" @click="aiEvaluate">
            <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
            {{ evaluating ? '評価中…' : 'AIで評価' }}
          </button>
        </template>
        <div class="grid gap-3">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <UiFormField label="実施日">
              <input
                :value="verification.implementedOn ?? ''"
                type="date" class="input" aria-label="実施日"
                @input="verification.implementedOn = ($event.target as HTMLInputElement).value || null"
              >
            </UiFormField>
            <UiFormField label="比較期間">
              <input v-model="verification.comparePeriod" type="text" class="input" placeholder="例）実施日前後の各 7 日間" aria-label="比較期間">
            </UiFormField>
          </div>
          <UiFormField label="実施内容（実際に行ったこと）">
            <textarea v-model="verification.implementedNote" class="textarea min-h-16" aria-label="実施内容（実際に行ったこと）" />
          </UiFormField>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <UiFormField label="KPI">
              <input v-model="verification.kpiName" type="text" class="input" placeholder="例）セッション" aria-label="KPI">
            </UiFormField>
            <UiFormField label="実施前">
              <input v-model="verification.beforeValue" type="text" class="input num" aria-label="実施前">
            </UiFormField>
            <UiFormField label="実施後">
              <input v-model="verification.afterValue" type="text" class="input num" aria-label="実施後">
            </UiFormField>
            <UiFormField label="変化 → 目標">
              <div class="flex items-center gap-1">
                <input v-model="verification.change" type="text" class="input num min-w-0" aria-label="変化">
                <span class="shrink-0 text-[11px] text-muted">→</span>
                <input v-model="verification.goal" type="text" class="input num min-w-0" aria-label="目標">
              </div>
            </UiFormField>
          </div>
          <UiFormField label="AI評価" hint="「AIで評価」で自動生成し、編集できます">
            <textarea v-model="verification.aiEvaluation" class="textarea min-h-16" aria-label="AI評価" />
          </UiFormField>
          <UiFormField label="人の最終評価">
            <UiSelect v-model="verification.humanEvaluation" :options="evaluationOptions" aria-label="人の最終評価" class="sm:w-56" />
          </UiFormField>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <UiFormField label="学び">
              <textarea v-model="verification.learning" class="textarea min-h-16" aria-label="学び" />
            </UiFormField>
            <UiFormField label="Next Action">
              <textarea v-model="verification.nextAction" class="textarea min-h-16" aria-label="Next Action" />
            </UiFormField>
          </div>
          <div class="flex justify-end">
            <button type="button" class="btn btn-primary" :disabled="saving || measure.active === false" @click="save">
              {{ saving ? '保存中…' : '施策と効果検証を保存' }}
            </button>
          </div>
        </div>
      </UiSectionCard>
    </div>
  </div>
</template>
