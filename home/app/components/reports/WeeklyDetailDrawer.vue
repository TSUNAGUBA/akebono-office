<script setup lang="ts">
/**
 * 週報詳細ドロワー（自分の週報の過去一覧 / 全員の週報で共用）。
 * 改修依頼 2026-08-20 第2バッチで reports.vue から /weekly-report ページ配下へ移設（実装の移動が主・挙動不変）。
 * - 他人の提出済み週報は開いた時点で既読（report_reads）にする（どの導線でも一貫）
 * - 「未読に戻す」で自動既読を取消できる（原則9.5）
 */
import type { WeeklyReport } from '~/types/domain'
import { REPORT_STATUS_LABELS } from '~/composables/useReports'
import { WEEKLY_TEAM_SHARE_DEFAULT } from '../../../../shared/domain/types'
import { weekRangeLabel } from '~/utils/report-weeks'

const props = defineProps<{
  /** 表示する週報 id（null = 閉じる） */
  reportId: string | null
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const reports = useReports()
const { currentUserId } = useCurrentUser()
const { show } = useToast()

const report = computed<WeeklyReport | null>(() =>
  props.reportId ? reports.weeklyById(props.reportId) ?? null : null)

// 詳細を開いたら既読にする（過去の週報一覧・全員の週報のどの導線でも一貫。
// 下書きは既読対象外 = 未読可視化は提出済みのみを扱う。自分の週報も対象外）
watch(() => props.reportId, (id) => {
  if (!id) return
  const w = reports.weeklyById(id)
  if (w && w.status === 'submitted' && w.memberId !== currentUserId.value) void reports.markReportRead('weekly', id)
})

/** 未読に戻す（週報。既読の取消フロー = 原則9.5）。あとで読み直すための導線 */
async function onMarkUnread(): Promise<void> {
  const w = report.value
  if (!w) return
  const res = await reports.markReportUnread('weekly', w.id)
  if (!res.ok) {
    show(res.error.message, 'warn')
    return
  }
  emit('close')
  show('未読に戻しました')
}
</script>

<template>
  <UiDrawer
    :open="!!report"
    :title="report ? `${report.memberId === currentUserId ? '' : `${reports.memberName(report.memberId)} の`}週報 ${weekRangeLabel(report.weekStart)}` : '週報'"
    @close="emit('close')"
  >
    <div v-if="report" class="grid gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <UiAvatar :name="reports.memberName(report.memberId)" size="sm" />
        <span class="text-[13px] font-bold">{{ reports.memberName(report.memberId) }}</span>
        <UiStatusBadge
          :tone="report.status === 'submitted' ? 'ok' : 'warn'"
          :label="REPORT_STATUS_LABELS[report.status]"
          dot
        />
        <!-- 未読に戻す（他人の提出済み週報のみ。開いた時点で既読になるため、その取消フロー = 原則9.5） -->
        <button
          v-if="report.memberId !== currentUserId && report.status === 'submitted' && reports.isReportRead('weekly', report.id)"
          type="button"
          class="btn btn-sm ml-auto"
          @click="onMarkUnread"
        >
          未読に戻す
        </button>
      </div>
      <div><p class="label">今週の成果・達成感</p><UiMarkdown v-if="report.goalReview" :source="report.goalReview" /><p v-else class="text-[13px]">—</p></div>
      <div><p class="label">今週の主要業務</p><UiMarkdown v-if="report.mainWork" :source="report.mainWork" /><p v-else class="text-[13px]">—</p></div>
      <div><p class="label">今週の課題・原因仮説</p><UiMarkdown v-if="report.issues" :source="report.issues" /><p v-else class="text-[13px]">—</p></div>
      <div><p class="label">今週うまくいったこと・続けたいこと</p><UiMarkdown v-if="report.goodPoints" :source="report.goodPoints" /><p v-else class="text-[13px]">—</p></div>
      <div><p class="label">来週の最重要テーマ（最大3つ）</p><UiMarkdown v-if="report.nextWeek" :source="report.nextWeek" /><p v-else class="text-[13px]">—</p></div>
      <div><p class="label">チーム共有事項</p><p class="text-[13px]">{{ report.teamShareKind || WEEKLY_TEAM_SHARE_DEFAULT }}{{ report.teamShareNote ? `／${report.teamShareNote}` : '' }}</p></div>
    </div>
  </UiDrawer>
</template>
