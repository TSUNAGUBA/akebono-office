<script setup lang="ts">
/**
 * 要望本文の編集フォーム（共通部品。F-42-16・改修依頼 2026-08-18）。
 * /improvements の生要望ドロワーと ImprovementSubmit の送信直後修正で共用する（原則3）。
 * 文字数カウンタ・上限・空文字ガードを一箇所に集約。保存/キャンセルの実処理は呼び出し側（emit）。
 */
import { IMPROVEMENT_BODY_CAP } from '~/types/improvement'

const props = defineProps<{
  /** 編集開始時の本文（マウント時に取り込む。編集のたびに v-if で作り直す想定） */
  initial: string
  /** 保存中（ボタン無効化・ラベル差し替え） */
  busy?: boolean
}>()

const emit = defineEmits<{ save: [body: string]; cancel: [] }>()

const body = ref(props.initial)
// 文字数はコードポイント基準（サーバー側 capCodePoints と同じ数え方）。textarea の maxlength は
// UTF-16 単位で絵文字等が半分しか入らないため使わず、超過は保存ボタン無効 + カウンタ強調で伝える
const length = computed(() => [...body.value].length)
const over = computed(() => length.value > IMPROVEMENT_BODY_CAP)
</script>

<template>
  <div class="grid gap-2">
    <textarea
      v-model="body"
      class="textarea"
      rows="6"
      aria-label="要望の本文を編集"
    />
    <p class="text-right text-[11px] num" :class="over ? 'font-semibold text-crit' : 'text-muted'">
      {{ length }} / {{ IMPROVEMENT_BODY_CAP }}<template v-if="over">（上限を超えています）</template>
    </p>
    <div class="flex justify-end gap-2">
      <button type="button" class="btn btn-sm" :disabled="busy" @click="emit('cancel')">キャンセル</button>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="busy || over || !body.trim()"
        @click="emit('save', body)"
      >
        {{ busy ? '保存中…' : '保存' }}
      </button>
    </div>
  </div>
</template>
