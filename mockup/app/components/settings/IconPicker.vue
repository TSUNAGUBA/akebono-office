<script setup lang="ts">
/**
 * アイコンピッカー（設定 > 外部リンク。改善要望: プレビュー選択式 + 画像アップロード）。
 * - プリセット（LINK_ICON_CHOICES）をプレビュー付きグリッドから選択、または画像をアップロード。
 * - 画像は 160px へ縮小し data URI 化（IMAGE_MAX_CHARS 上限）。設定時は icon より優先して表示。
 * - 取消可能性（原則9.5）: 「アイコンに戻す」で画像を外し、選択式アイコン表示へ戻せる。
 * - segments.vue のインライン実装（appIcon/appIconImage）を共通コンポーネント化（原則3）。
 * v-model 規約は既存（NotifyRecipientsEditor 等）に合わせ defineProps/defineEmits で実装する。
 */
import * as icons from 'lucide-vue-next'
import { ImageUp, RotateCcw } from 'lucide-vue-next'
import { LINK_ICON_CHOICES } from '~/utils/link-icons'
import { IMAGE_MAX_CHARS, imageToDataUri } from '~/utils/thumb'

const props = defineProps<{
  /** 選択中の lucide アイコンキー（画像未使用時に表示） */
  icon: string
  /** アイコン画像（data URI。設定時は icon より優先。未設定 = null） */
  image: string | null
  /** 画像処理中フラグ（親が保存ボタンを無効化するために監視） */
  busy?: boolean
}>()
const emit = defineEmits<{
  'update:icon': [string]
  'update:image': [string | null]
  'update:busy': [boolean]
}>()

const toast = useToast()

function iconOf(name: string) {
  return (icons as Record<string, unknown>)[name] ?? icons.Link
}

/** アイコンを選ぶ（画像を使っていた場合はアイコン表示へ戻す = 二者択一） */
function pickIcon(key: string): void {
  emit('update:icon', key)
  emit('update:image', null)
}

async function onImageFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 同じファイルの再選択でも change を発火させる
  if (!file) return
  if (!file.type.startsWith('image/')) {
    toast.show('画像ファイルを選択してください', 'warn')
    return
  }
  emit('update:busy', true)
  try {
    // アイコンは小さく表示するため 160px へ縮小（localStorage 容量に配慮。segments と同値）
    const uri = await imageToDataUri(file, 160)
    if (uri.length > IMAGE_MAX_CHARS) {
      toast.show('画像を縮小しても大きすぎます。別の画像をお試しください', 'warn')
      return
    }
    emit('update:image', uri)
    toast.show('画像アイコンを設定しました', 'ok')
  } catch (e) {
    toast.show((e as Error).message, 'crit')
  } finally {
    emit('update:busy', false)
  }
}

/** 画像を外してアイコン表示に戻す（取消フロー・原則9.5） */
function clearImage(): void {
  emit('update:image', null)
}
</script>

<template>
  <div class="grid gap-2.5">
    <!-- プレビュー -->
    <div class="flex items-center gap-3 rounded-[10px] border border-line bg-surface-soft p-2.5">
      <UiIconGlyph :icon="props.icon" :image="props.image" :size="44" alt="アイコンプレビュー" fallback="Link" />
      <p class="text-[11px] text-muted">
        {{ props.image ? '画像アイコンを使用中' : 'プリセットから選ぶか、画像をアップロードします' }}
      </p>
    </div>

    <!-- 画像アップロード -->
    <div class="flex flex-wrap items-center gap-2">
      <label class="btn btn-sm cursor-pointer">
        <ImageUp class="h-3.5 w-3.5" aria-hidden="true" />
        画像をアップロード
        <input type="file" accept="image/*" class="hidden" aria-label="アイコン画像をアップロード" @change="onImageFile">
      </label>
      <button v-if="props.image" type="button" class="btn btn-sm" @click="clearImage">
        <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" />
        アイコンに戻す
      </button>
      <span v-if="props.busy" class="text-[11px] text-muted">画像を処理しています…</span>
    </div>

    <!-- プリセット選択（画像未使用時） -->
    <div v-if="!props.image" class="flex flex-wrap gap-1.5">
      <button
        v-for="key in LINK_ICON_CHOICES"
        :key="key"
        type="button"
        class="flex h-9 w-9 items-center justify-center rounded-lg border transition-colors"
        :class="props.icon === key ? 'border-brand bg-brand-soft text-brand' : 'border-line text-sub hover:border-muted'"
        :aria-label="`アイコン ${key}`"
        :aria-pressed="props.icon === key"
        @click="pickIcon(key)"
      >
        <component :is="iconOf(key)" :size="18" aria-hidden="true" />
      </button>
    </div>
    <p class="text-[11px] text-muted">
      画像は 160px に縮小して保存します（PNG は透過を保持）。未設定なら「{{ LINK_ICON_CHOICES[0] }}」アイコンで表示します。
    </p>
  </div>
</template>
