<script setup lang="ts">
const { state, answer } = useConfirm()
</script>

<template>
  <!-- topmost: モーダル内の操作からの確認でも、呼び出し元モーダルに隠れないようにする -->
  <UiModal :open="state.open" :title="state.title" width="420px" topmost @close="answer(false)">
    <p class="text-[13px] text-sub">{{ state.message }}</p>
    <template #footer>
      <button type="button" class="btn" @click="answer(false)">キャンセル</button>
      <button
        type="button"
        class="btn"
        :class="state.danger ? 'btn-danger' : 'btn-primary'"
        @click="answer(true)"
      >
        {{ state.confirmLabel }}
      </button>
    </template>
  </UiModal>
</template>
