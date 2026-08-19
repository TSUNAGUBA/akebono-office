<script setup lang="ts">
/**
 * 要望の編集フォーム（本文 + タグ + 参考リンク + 画像。改修依頼 2026-08-19）。
 * 登録時に入力できる項目をすべて編集できるようにする（F-42-16 の本文のみ編集を拡張）。
 * /improvements の生要望ドロワーと ImprovementSubmit の送信直後修正で共用する（原則3）。
 * 添付の追加/削除 UI は ImprovementsAttachmentEditor に集約（投稿フォームと同一部品 = 原則3）。
 * 本文の文字数上限・タグの allowlist・リンク/画像の形式は保存時に呼び出し側が shared 検証で確定する。
 */
import {
  IMPROVEMENT_BODY_CAP, IMPROVEMENT_REQUEST_TAG_META, IMPROVEMENT_REQUEST_TAGS,
  type ImprovementRequestImage,
} from '~/types/improvement'

const props = withDefaults(defineProps<{
  /** 編集開始時の各項目（マウント時に取り込む。編集のたびに v-if で作り直す想定） */
  initialBody: string
  initialTags?: string[]
  initialLinks?: string[]
  initialImages?: ImprovementRequestImage[]
  /** 保存中（ボタン無効化・ラベル差し替え） */
  busy?: boolean
  /** ウィンドウ全体のドロップ抑止を有効にするか（表示中のみ true = AttachmentEditor へ委譲） */
  active?: boolean
}>(), { active: true })

const emit = defineEmits<{
  save: [payload: { body: string; tags: string[]; links: string[]; images: ImprovementRequestImage[] }]
  cancel: []
}>()

const body = ref(props.initialBody)
const tags = ref<string[]>([...(props.initialTags ?? [])])
const links = ref<string[]>([...(props.initialLinks ?? [])])
const images = ref<ImprovementRequestImage[]>([...(props.initialImages ?? [])])
/** 画像処理中は保存を止める（縮小中に確定して添付が漏れないように = AttachmentEditor から通知） */
const attachBusy = ref(false)

const TAG_OPTIONS = IMPROVEMENT_REQUEST_TAGS.map(t => ({ value: t, label: IMPROVEMENT_REQUEST_TAG_META[t].label }))

// 文字数はコードポイント基準（サーバー側 capCodePoints と同じ数え方）。textarea の maxlength は
// UTF-16 単位で絵文字等が半分しか入らないため使わず、超過は保存ボタン無効 + カウンタ強調で伝える
const length = computed(() => [...body.value].length)
const over = computed(() => length.value > IMPROVEMENT_BODY_CAP)

function onSave(): void {
  // 空リンク（未入力の追加行）は保存対象から除外（shared 検証と同じ扱い = 送信前にフォームで整える）
  emit('save', {
    body: body.value,
    tags: tags.value,
    links: links.value.map(l => l.trim()).filter(Boolean),
    images: images.value,
  })
}
</script>

<template>
  <div class="grid gap-3">
    <div class="grid gap-1">
      <textarea
        v-model="body"
        class="textarea"
        rows="6"
        aria-label="要望の本文を編集"
      />
      <p class="text-right text-[11px] num" :class="over ? 'font-semibold text-crit' : 'text-muted'">
        {{ length }} / {{ IMPROVEMENT_BODY_CAP }}<template v-if="over">（上限を超えています）</template>
      </p>
    </div>

    <!-- 任意タグ（壁打ち/お任せ = F-42-17。登録時と同じ選択肢・SoT = shared の TAG_META） -->
    <UiFormField
      label="タグ（任意）"
      hint="「壁打ち」= 壁打ち（対話での要件整理）を経て案件化したい意思表示。「お任せ」= 受け取った内容を開発側の解釈で進めてよい"
    >
      <UiChipSelect v-model="tags" :options="TAG_OPTIONS" aria-label="要望のタグ" />
    </UiFormField>

    <!-- 参考リンク・画像の編集（投稿フォームと同一部品 = 原則3） -->
    <ImprovementsAttachmentEditor
      v-model:links="links"
      v-model:images="images"
      v-model:busy="attachBusy"
      :active="active"
    />

    <div class="flex justify-end gap-2">
      <button type="button" class="btn btn-sm" :disabled="busy" @click="emit('cancel')">キャンセル</button>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="busy || attachBusy || over || !body.trim()"
        @click="onSave"
      >
        {{ busy ? '保存中…' : '保存' }}
      </button>
    </div>
  </div>
</template>
