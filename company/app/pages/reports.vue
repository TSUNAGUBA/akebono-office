<script setup lang="ts">
/**
 * AI 日次報告: 活動ログを AI 社員ごとに集約して日次報告を生成・閲覧する。
 * 生成は冪等 UPSERT（既存分はスキップ = 記録系保護）。
 */
const { employeeById, aiReportsOn, generateDailyReports } = useAiCompany()
const { show } = useToast()

const reportDate = ref(todayJst())
const aiReports = computed(() => aiReportsOn(reportDate.value))
/** 生成中フラグ（二重押下防止。サーバー側は部分一意 + ON CONFLICT で冪等だが UI でも抑止する） */
const generating = ref(false)

async function onGenerateReports(): Promise<void> {
  if (generating.value) return
  generating.value = true
  try {
    const { created, skipped } = await generateDailyReports(reportDate.value)
    if (created === 0 && skipped === 0) {
      show('この日の AI 活動ログがないため、生成対象がありません', 'warn')
      return
    }
    show(`日次報告を ${created} 件生成しました（既存 ${skipped} 件はスキップ）`, 'ok')
  } finally {
    generating.value = false
  }
}
</script>

<template>
  <div>
    <UiPageHeader title="AI 日次報告" description="活動ログを AI 社員ごとに集約した日次報告です" />

    <div class="grid gap-3">
      <UiSectionCard title="日次活動報告の生成" description="活動ログを AI 社員ごとに集約します。生成済みの日はスキップされます（冪等）">
        <div class="flex flex-wrap items-center gap-2">
          <input
            v-model="reportDate"
            type="date"
            class="input w-auto"
            aria-label="報告対象日"
          >
          <button type="button" class="btn btn-primary" :disabled="generating" @click="onGenerateReports">
            {{ generating ? '生成中…' : 'この日の報告を生成' }}
          </button>
        </div>
      </UiSectionCard>

      <UiEmptyState
        v-if="aiReports.length === 0"
        icon="FileText"
        title="この日の AI 日次報告はまだありません"
        hint="「この日の報告を生成」を押すと活動ログから作成されます"
      />
      <UiSectionCard
        v-for="r in aiReports"
        :key="r.id"
        :title="`${employeeById(r.aiEmployeeId ?? '')?.name ?? 'AI社員'} の日次報告`"
        :description="`${r.date} / 提出済み`"
      >
        <template #actions>
          <UiAvatar :name="employeeById(r.aiEmployeeId ?? '')?.name ?? 'AI'" kind="ai" size="sm" />
        </template>
        <ul class="grid gap-1.5">
          <li v-for="(e, i) in r.entries" :key="i" class="flex flex-wrap items-baseline gap-x-2 text-[13px]">
            <span class="font-medium">{{ e.task }}</span>
            <span class="num text-[11px] text-muted">{{ e.hours }}h / 進捗 {{ e.progress }}%</span>
          </li>
        </ul>
        <dl class="mt-2 grid gap-1 border-t border-line pt-2 text-xs">
          <div class="flex gap-2">
            <dt class="shrink-0 font-semibold text-muted">所感</dt>
            <dd class="text-sub">{{ r.reflection }}</dd>
          </div>
          <div v-if="r.issues" class="flex gap-2">
            <dt class="shrink-0 font-semibold text-warn">課題</dt>
            <dd class="text-sub">{{ r.issues }}</dd>
          </div>
          <div class="flex gap-2">
            <dt class="shrink-0 font-semibold text-muted">明日</dt>
            <dd class="text-sub">{{ r.tomorrow }}</dd>
          </div>
        </dl>
      </UiSectionCard>
    </div>
  </div>
</template>
