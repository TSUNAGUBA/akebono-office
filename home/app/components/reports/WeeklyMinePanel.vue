<script setup lang="ts">
/**
 * 自分の週報パネル（週選択 + エディタ + 過去の週報一覧）。
 * 改修依頼 2026-08-20 第2バッチ: 週報のトップレベル独立（/weekly-report）に伴い
 * reports.vue のインライン実装から移設（実装の移動が主・挙動は不変）。
 * - 参照 = 基本ビュー・入力は「週報を書く」ボタン押下で表示（バッチ7h ④ を踏襲）
 * - 例文挿入は入力済みなら上書き確認（原則9.5）。例文の SoT = utils/weekly-report-templates.ts
 */
import { ChevronLeft, ChevronRight, Eye, FileText, Pencil, Send, Sparkles } from 'lucide-vue-next'
import type { WeeklyReport } from '~/types/domain'
import { WEEKLY_TEAM_SHARE_DEFAULT, WEEKLY_TEAM_SHARE_KINDS } from '../../../../shared/domain/types'
import { REPORT_STATUS_LABELS } from '~/composables/useReports'
import { addDays, todayJst } from '~/utils/format'
import { weekRangeLabel } from '~/utils/report-weeks'
import { isRealDateKey } from '../../../../shared/domain/jst'
import { WEEKLY_REPORT_EXAMPLE } from '~/utils/weekly-report-templates'

const reports = useReports()
const { currentUserId } = useCurrentUser()
const { show } = useToast()
const { ask } = useConfirm()
const { isRunning, run } = useAsyncAction()

// 参照する週を選択できる（オペレーター指示 2026-07-21 #2）。既定 = 今週（月曜始まり）。
// 通知ディープリンクの `?week=`（週報リマインド F-48-3）は実在日なら weekStartOf で正規化して初期選択
const qWeek = (() => { const q = useRoute().query.week; return typeof q === 'string' ? q : '' })()
const selWeekStart = ref(reports.weekStartOf(isRealDateKey(qWeek) ? qWeek : todayJst()))
const selWeekly = computed(() => reports.myWeeklyOn(selWeekStart.value))
const isThisWeek = computed(() => selWeekStart.value === reports.weekStartOf(todayJst()))

function moveWeeklyWeek(delta: number): void {
  selWeekStart.value = addDays(selWeekStart.value, delta * 7)
}

const wkGoal = ref('')
const wkMain = ref('')
const wkIssues = ref('')
const wkNext = ref('')
/** うまくいったこと・続けたいこと（オペレーター指示 2026-08-03） */
const wkGoodPoints = ref('')
/** チーム共有事項の種別（既定 '特になし'）と自由入力 */
const wkTeamShareKind = ref<string>(WEEKLY_TEAM_SHARE_DEFAULT)
const wkTeamShareNote = ref('')
/** チーム共有事項の種別チップ（値=ラベル） */
const teamShareKindOptions = WEEKLY_TEAM_SHARE_KINDS.map(k => ({ value: k, label: k }))
// フリー入力欄のマークダウンプレビュー（バッチ7e。入力はプレーンな textarea のまま = 記法をそのまま保存）
const wkMdPreview = ref(false)

function loadWeeklyEditor(): void {
  const r = selWeekly.value
  if (r && r.status === 'draft') {
    wkGoal.value = r.goalReview
    wkMain.value = r.mainWork
    wkIssues.value = r.issues
    wkNext.value = r.nextWeek
    wkGoodPoints.value = r.goodPoints ?? ''
    // 旧下書きは種別未設定 → 既定「特になし」で表示する（原則7）
    wkTeamShareKind.value = r.teamShareKind || WEEKLY_TEAM_SHARE_DEFAULT
    wkTeamShareNote.value = r.teamShareNote ?? ''
  } else {
    // 下書き以外（未作成・提出済み）は全クリア。週送りで別週へ入力内容が残留し、
    // 誤った週へ提出される事故を防ぐ（提出済みはエディタ非表示だが残留も断つ）
    wkGoal.value = ''
    wkMain.value = ''
    wkIssues.value = ''
    wkNext.value = ''
    wkGoodPoints.value = ''
    wkTeamShareKind.value = WEEKLY_TEAM_SHARE_DEFAULT
    wkTeamShareNote.value = ''
  }
}
// selWeekStart も監視: 未作成週→未作成週の移動では selWeekly が undefined→undefined で
// 参照変化せず watcher が発火しないため、週初め自体を復元トリガに含める（入力残留の防止）。
// selWeekly も監視: API モードでは週報データが非同期に届くため到着後に下書きを復元する
watch([currentUserId, selWeekStart, selWeekly], loadWeeklyEditor, { immediate: true })

async function generateFromDailies(): Promise<void> {
  await run('wk-generate', async () => {
    const d = await reports.draftFromDailies(selWeekStart.value)
    if (!d.mainWork && !d.issues) {
      show('この週の日報がまだありません', 'warn')
      return
    }
    if (d.mainWork) wkMain.value = d.mainWork
    if (d.issues) wkIssues.value = d.issues
    show('日報から下書きを生成しました')
  }, { message: '日報から下書きを生成しています…' })
}

/**
 * 例文を各欄へ挿入する（改修9。SoT = utils/weekly-report-templates.ts の WEEKLY_REPORT_EXAMPLE）。
 * 稟議テンプレ（workflow.vue applyTemplate）と同様、挿入対象の欄に入力があれば上書き確認（誤操作で入力を
 * 失わない = 原則9.5）。全て空なら確認なしで挿入する。挿入対象は例文を持つ 4 欄のみ（主要業務・
 * チーム共有事項は書き手固有のため触らない）。
 */
async function insertWeeklyExample(): Promise<void> {
  const filled = [wkGoal.value, wkIssues.value, wkGoodPoints.value, wkNext.value].some(v => v.trim())
  if (filled) {
    const ok = await ask('例文の挿入', '入力済みの欄を例文で置き換えます。よろしいですか？', { confirmLabel: '置き換える' })
    if (!ok) return
  }
  wkGoal.value = WEEKLY_REPORT_EXAMPLE.goalReview
  wkIssues.value = WEEKLY_REPORT_EXAMPLE.issues
  wkGoodPoints.value = WEEKLY_REPORT_EXAMPLE.goodPoints
  wkNext.value = WEEKLY_REPORT_EXAMPLE.nextWeek
  show('例文を挿入しました')
}

async function onSaveWeekly(submitNow: boolean): Promise<void> {
  await run(submitNow ? 'wk-submit' : 'wk-draft', async () => {
    const res = await reports.saveWeekly({
      weekStart: selWeekStart.value,
      goalReview: wkGoal.value,
      mainWork: wkMain.value,
      issues: wkIssues.value,
      nextWeek: wkNext.value,
      goodPoints: wkGoodPoints.value,
      teamShareKind: wkTeamShareKind.value,
      teamShareNote: wkTeamShareNote.value,
    }, submitNow)
    if (!res.ok) {
      show(res.error.message, 'warn')
      return
    }
    show(submitNow ? '週報を提出しました' : '下書きを保存しました')
  }, { message: submitNow ? '週報を提出しています…' : '下書きを保存しています…' })
}

/** 週報詳細ドロワー（過去の週報一覧から。表示・既読・未読取消は ReportsWeeklyDetailDrawer） */
const weeklyDrawerId = ref<string | null>(null)

/** 週報も参照 = 基本ビュー・入力はボタン押下（バッチ7h ④）。提出・週切替・ユーザー切替で参照へ戻す */
const weeklyEditing = ref(false)
watch([currentUserId, selWeekStart], () => { weeklyEditing.value = false })

async function onSaveWeeklyAndClose(submitNow: boolean): Promise<void> {
  await onSaveWeekly(submitNow)
  if (submitNow && reports.myWeeklyOn(selWeekStart.value)?.status === 'submitted') {
    weeklyEditing.value = false
  }
}

// 過去の週報一覧のページング（1 ページ 20 件 = 改修依頼 2026-08-18。クライアントページング。
// タブ切替時は本パネルごと unmount されるため、リセットトリガはユーザー切替のみで足りる）
const { page: mwPage, pageSize: mwPageSize, rows: pagedMyWeeklies, total: mwTotal } = useListView<WeeklyReport>({ source: reports.myWeeklies })
watch(currentUserId, () => { mwPage.value = 1 })
</script>

<template>
  <div class="grid gap-3">
    <UiFilterBar>
      <div class="flex items-center gap-1.5">
        <button type="button" class="btn btn-sm" aria-label="前の週へ" @click="moveWeeklyWeek(-1)">
          <ChevronLeft class="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" class="btn btn-sm" :disabled="isThisWeek" @click="selWeekStart = reports.weekStartOf(todayJst())">今週</button>
        <button type="button" class="btn btn-sm" aria-label="次の週へ" @click="moveWeeklyWeek(1)">
          <ChevronRight class="h-4 w-4" aria-hidden="true" />
        </button>
        <span class="num ml-1 whitespace-nowrap text-xs font-semibold">{{ weekRangeLabel(selWeekStart) }}</span>
        <UiStatusBadge v-if="isThisWeek" label="今週" tone="brand" />
      </div>
      <template #trailing>
        <UiStatusBadge
          :tone="selWeekly?.status === 'submitted' ? 'ok' : selWeekly ? 'warn' : 'neutral'"
          :label="selWeekly ? REPORT_STATUS_LABELS[selWeekly.status] : '未作成'"
          dot
        />
      </template>
    </UiFilterBar>

    <!-- 選択した週の週報（参照 = 基本ビュー・入力は「週報を書く」から = バッチ7h ④） -->
    <UiSectionCard
      :title="`${isThisWeek ? '今週' : '選択週'}の週報（${weekRangeLabel(selWeekStart)}）`"
      :description="selWeekly?.status === 'submitted'
        ? '提出済みです'
        : weeklyEditing ? '日報から下書きを生成できます' : '「週報を書く」から入力できます'"
    >
      <template v-if="selWeekly?.status !== 'submitted'" #actions>
        <button v-if="!weeklyEditing" type="button" class="btn btn-primary btn-sm" @click="weeklyEditing = true">
          <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
          週報を書く
        </button>
        <UiButton v-else size="sm" :loading="isRunning('wk-generate')" @click="generateFromDailies">
          <template #icon><Sparkles class="h-3.5 w-3.5" aria-hidden="true" /></template>
          日報から下書き生成
        </UiButton>
      </template>

      <!-- 提出済み: 読み取り表示 -->
      <div v-if="selWeekly && selWeekly.status === 'submitted'" class="grid gap-3">
        <UiStatusBadge tone="ok" :label="REPORT_STATUS_LABELS.submitted" dot class="justify-self-start" />
        <div class="grid gap-3 md:grid-cols-2">
          <div><p class="label">今週の成果・達成感</p><UiMarkdown v-if="selWeekly.goalReview" :source="selWeekly.goalReview" /><p v-else class="text-[13px]">—</p></div>
          <div><p class="label">今週の主要業務</p><UiMarkdown v-if="selWeekly.mainWork" :source="selWeekly.mainWork" /><p v-else class="text-[13px]">—</p></div>
          <div><p class="label">今週の課題・原因仮説</p><UiMarkdown v-if="selWeekly.issues" :source="selWeekly.issues" /><p v-else class="text-[13px]">—</p></div>
          <div><p class="label">今週うまくいったこと・続けたいこと</p><UiMarkdown v-if="selWeekly.goodPoints" :source="selWeekly.goodPoints" /><p v-else class="text-[13px]">—</p></div>
          <div><p class="label">来週の最重要テーマ（最大3つ）</p><UiMarkdown v-if="selWeekly.nextWeek" :source="selWeekly.nextWeek" /><p v-else class="text-[13px]">—</p></div>
          <div><p class="label">チーム共有事項</p><p class="text-[13px]">{{ selWeekly.teamShareKind || WEEKLY_TEAM_SHARE_DEFAULT }}{{ selWeekly.teamShareNote ? `／${selWeekly.teamShareNote}` : '' }}</p></div>
        </div>
      </div>

      <!-- 参照ビュー（未提出・未編集: 状態表示のみ） -->
      <div v-else-if="!weeklyEditing" class="flex flex-wrap items-center gap-2">
        <UiStatusBadge
          :tone="selWeekly ? 'warn' : 'neutral'"
          :label="selWeekly ? REPORT_STATUS_LABELS.draft : '未作成'"
          dot
        />
        <span class="text-xs text-muted">
          {{ selWeekly ? '下書きが保存されています。「週報を書く」から続きを編集できます' : `${isThisWeek ? '今週' : 'この週'}の週報はまだ作成されていません` }}
        </span>
      </div>

      <!-- エディタ -->
      <div v-else class="grid gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <!-- 例文を挿入（改修9。入力済みなら上書き確認 = 原則9.5。SoT = utils/weekly-report-templates.ts） -->
          <button type="button" class="btn btn-sm" @click="insertWeeklyExample">
            <FileText class="h-3.5 w-3.5" aria-hidden="true" />
            例文を挿入
          </button>
          <button type="button" class="btn btn-sm" :aria-pressed="wkMdPreview" @click="wkMdPreview = !wkMdPreview">
            <component :is="wkMdPreview ? Pencil : Eye" class="h-3.5 w-3.5" aria-hidden="true" />
            {{ wkMdPreview ? '編集に戻る' : 'プレビュー' }}
          </button>
        </div>
        <div class="grid gap-3 md:grid-cols-2">
          <UiFormField label="今週の成果・達成感">
            <div v-if="wkMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="wkGoal" /></div>
            <textarea v-else v-model="wkGoal" class="textarea" placeholder="例）顧客マスタの登録作業を完了することができた。" />
          </UiFormField>
          <UiFormField label="今週の主要業務" required>
            <div v-if="wkMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="wkMain" /></div>
            <textarea v-else v-model="wkMain" class="textarea" placeholder="今週の主な業務" />
          </UiFormField>
          <UiFormField label="今週の課題・原因仮説">
            <div v-if="wkMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="wkIssues" /></div>
            <textarea v-else v-model="wkIssues" class="textarea" placeholder="例）マスタ設定の確認に時間がかかった。設定手順が複数箇所に分散していることが原因だと思う。" />
          </UiFormField>
          <UiFormField label="今週うまくいったこと・続けたいこと">
            <div v-if="wkMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="wkGoodPoints" /></div>
            <textarea v-else v-model="wkGoodPoints" class="textarea" placeholder="例）作業前に確認項目を一覧化したことで、入力ミスを減らせた。今後も作業開始前にチェックリストを作成する。" />
          </UiFormField>
          <UiFormField label="来週の最重要テーマ（最大3つ）">
            <div v-if="wkMdPreview" class="min-h-[72px] rounded-lg border border-line p-2.5"><UiMarkdown :source="wkNext" /></div>
            <textarea v-else v-model="wkNext" class="textarea" placeholder="例）クライアントのシステム稼働に向けた事前準備。主観で進めないようにメンバーとも壁打ちをしながら実施する。" />
          </UiFormField>
        </div>

        <!-- チーム共有事項（種別を選択して自由入力。オペレーター指示 2026-08-03） -->
        <UiFormField label="チーム共有事項">
          <div class="grid gap-1.5">
            <UiChipTabs
              :model-value="wkTeamShareKind"
              :options="teamShareKindOptions"
              aria-label="チーム共有事項の種別"
              @update:model-value="(v: string) => { wkTeamShareKind = v }"
            />
            <textarea v-model="wkTeamShareNote" class="textarea" placeholder="共有したい内容" aria-label="チーム共有事項の内容" />
          </div>
        </UiFormField>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <button type="button" class="btn" @click="weeklyEditing = false">閉じる</button>
          <UiButton :loading="isRunning('wk-draft')" @click="onSaveWeekly(false)">下書き保存</UiButton>
          <UiButton variant="primary" :loading="isRunning('wk-submit')" @click="onSaveWeeklyAndClose(true)">
            <template #icon><Send class="h-3.5 w-3.5" aria-hidden="true" /></template>
            提出
          </UiButton>
        </div>
      </div>
    </UiSectionCard>

    <!-- 過去の週報 -->
    <UiSectionCard title="過去の週報" flush>
      <UiEmptyState v-if="reports.myWeeklies.value.length === 0" title="週報がまだありません" hint="今週の週報を作成すると一覧に表示されます" />
      <ul v-else class="divide-y divide-line">
        <li v-for="w in pagedMyWeeklies" :key="w.id">
          <button
            type="button"
            class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-brand-soft"
            @click="weeklyDrawerId = w.id"
          >
            <span class="num flex-1 text-[13px] font-semibold">{{ weekRangeLabel(w.weekStart) }}</span>
            <UiStatusBadge :tone="w.status === 'submitted' ? 'ok' : 'warn'" :label="REPORT_STATUS_LABELS[w.status]" />
          </button>
        </li>
      </ul>
      <UiPagination v-model:page="mwPage" v-model:page-size="mwPageSize" :total="mwTotal" />
    </UiSectionCard>

    <!-- 週報詳細ドロワー（過去の週報一覧から） -->
    <ReportsWeeklyDetailDrawer :report-id="weeklyDrawerId" @close="weeklyDrawerId = null" />
  </div>
</template>
