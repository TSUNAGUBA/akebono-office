<script setup lang="ts">
/**
 * 要望タグ（壁打ち/お任せ = F-42-17）のバッジ列。ラベル・トーン・意味の SoT = shared の
 * IMPROVEMENT_REQUEST_TAG_META。hover/長押し（title）で意味を表示する。
 * 受付箱一覧・要望詳細ドロワー・改修単位ドロワーの元要望カードで共用（原則3・レビュー R6）。
 * タグ無し（undefined/空）は何も描画しない。表示前に normalize（allowlist）を通す:
 * tags 列は DB の CHECK ではなくアプリ層担保のため、未知値の混入で描画を落とさない（buildCodingPrompt と同じ姿勢）。
 * 空判定・normalize は本部品が持つ（呼び出し側に二重の normalize を置かない = レビュー R20）。
 * wrapperClass = タグがあるときだけ描画する外枠のクラス（受付箱の行内レイアウト用。未指定 = contents = 素通し）。
 */
import { normalizeImprovementTags, type ImprovementRequestTag, IMPROVEMENT_REQUEST_TAG_META } from '~/types/improvement'

const props = defineProps<{ tags?: ImprovementRequestTag[] | null; wrapperClass?: string }>()
const safeTags = computed(() => normalizeImprovementTags(props.tags))
</script>

<template>
  <span v-if="safeTags.length > 0" :class="wrapperClass ?? 'contents'">
    <span
      v-for="t in safeTags"
      :key="t"
      :title="IMPROVEMENT_REQUEST_TAG_META[t].description"
    >
      <UiStatusBadge :tone="IMPROVEMENT_REQUEST_TAG_META[t].tone" :label="IMPROVEMENT_REQUEST_TAG_META[t].label" />
    </span>
  </span>
</template>
