<script setup lang="ts">
/**
 * 要望の添付表示（共通部品。F-42-11・改修依頼 2026-08-18 に R9 で共通化）。
 * 参考リンク（別タブで開く）+ 添付画像（押下で拡大 emit）を改修単位ドロワーの元要望と
 * 生要望ドロワーで共用する（原則3）。空のときは何も描画しない。
 */
import { ExternalLink } from 'lucide-vue-next'
import type { ImprovementRequestImage } from '~/types/improvement'

defineProps<{
  links?: string[]
  images?: ImprovementRequestImage[]
}>()

const emit = defineEmits<{ preview: [image: ImprovementRequestImage] }>()
</script>

<template>
  <ul v-if="(links ?? []).length > 0" class="mt-1.5 grid gap-1">
    <li v-for="l in links" :key="l" class="min-w-0">
      <a
        :href="l"
        target="_blank"
        rel="noopener noreferrer"
        class="link inline-flex max-w-full items-center gap-1 text-[12px]"
        :title="`${l}（別タブで開く）`"
      >
        <ExternalLink class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span class="truncate">{{ l }}</span>
      </a>
    </li>
  </ul>
  <!-- 添付画像（押下で拡大表示 = 親の topmost モーダル） -->
  <div v-if="(images ?? []).length > 0" class="mt-1.5 flex flex-wrap gap-1.5">
    <button
      v-for="(img, i) in images"
      :key="i"
      type="button"
      class="rounded-lg border border-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
      :aria-label="`画像「${img.filename}」を拡大表示`"
      :title="`${img.filename}（押下で拡大）`"
      @click="emit('preview', img)"
    >
      <img :src="img.dataUrl" :alt="img.filename" class="h-14 w-14 rounded-lg object-cover">
    </button>
  </div>
</template>
