<script setup lang="ts">
/**
 * 活動ログ: AI 社員の活動タイムライン（フィルタ・ページング・tokens/コスト表示）。
 */
const { employeesAll, tasks, logs } = useAiCompany()
</script>

<template>
  <div>
    <UiPageHeader title="活動ログ" description="AI 社員の活動を時系列で記録します（tokens / コストは現状モック値）" />
    <UiSectionCard>
      <!-- 名前解決は無効化済み AI 社員も含む（過去ログの担当名を生 id にしない） -->
      <OfficeActivityTimeline :logs="logs" :employees="employeesAll" :tasks="tasks" />
    </UiSectionCard>
  </div>
</template>
