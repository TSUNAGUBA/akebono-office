<script setup lang="ts">
/**
 * 改善要望の参考リンク（複数 URL）の編集フォーム（共通部品）。投稿（ImprovementSubmit）と
 * 要望編集（ImprovementsRequestEditForm）で共用する（原則3）。リンクの追加/削除/編集を一箇所に集約する。
 * 画像添付は本文一体型の ImprovementsBodyImageInput へ移したため、本部品はリンクのみを扱う
 * （改修依頼 2026-08-19 第4弾: 独立した画像添付フォームを廃止 → 旧 AttachmentEditor から画像機能を分離）。
 * リンクの形式検証（http(s)・件数）は保存時に親が shared の improvementLinksError で行う（本部品は入力のみ）。
 */
import { Link2, X } from 'lucide-vue-next'
import { IMPROVEMENT_LINKS_MAX } from '~/types/improvement'

const props = defineProps<{
  links: string[]
}>()

const emit = defineEmits<{
  'update:links': [v: string[]]
}>()

function addLink(): void {
  if (props.links.length >= IMPROVEMENT_LINKS_MAX) return
  emit('update:links', [...props.links, ''])
}
function updateLink(i: number, value: string): void {
  emit('update:links', props.links.map((l, idx) => (idx === i ? value : l)))
}
function removeLink(i: number): void {
  emit('update:links', props.links.filter((_, idx) => idx !== i))
}
</script>

<template>
  <div class="grid gap-1.5">
    <div class="flex items-center justify-between">
      <p class="label">参考リンク（{{ IMPROVEMENT_LINKS_MAX }} 件まで）</p>
      <button
        v-if="links.length < IMPROVEMENT_LINKS_MAX"
        type="button" class="btn btn-ghost btn-sm" @click="addLink"
      >
        <Link2 class="h-4 w-4" aria-hidden="true" /> リンクを追加
      </button>
    </div>
    <div v-for="(link, i) in links" :key="i" class="flex items-center gap-1.5">
      <input
        :value="link"
        class="input flex-1"
        type="url"
        inputmode="url"
        placeholder="https://example.com/..."
        :aria-label="`参考リンク ${i + 1}`"
        @input="updateLink(i, ($event.target as HTMLInputElement).value)"
      >
      <button type="button" class="btn btn-ghost btn-sm shrink-0" :aria-label="`参考リンク ${i + 1} を削除`" @click="removeLink(i)">
        <X class="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
    <p v-if="links.length > 0" class="text-[11px] text-muted">http(s):// で始まる URL を入力してください。参照時は別タブで開きます。</p>
  </div>
</template>
