<script setup lang="ts">
/**
 * 改善要望の「内容 + 画像添付」の一体型入力（改修依頼 2026-08-19 第4弾。Claude ライクな操作感）。
 * テキストエリア枠内の左下に「+」ボタンを置き、押下で画像を添付できる。テキストエリアにカーソルがある
 * 状態での貼り付け（Ctrl+V / ⌘V）は、クリップボードに従いテキストは通常反映・画像は添付として扱う。
 * 従来の独立した画像添付フォーム（ドロップゾーン + 「画像を追加」ボタン）は廃止し、この一体型に統合した。
 * 投稿フォーム（ImprovementSubmit）と要望編集（ImprovementsRequestEditForm）で共用する（原則3）。
 *
 * 本文は v-model、画像は v-model:images、画像処理中は v-model:busy で親と同期する。文字数カウンタ・
 * 上限チェックは親が担う（textarea は maxlength を使わず = 絵文字等のコードポイント数え違いを避ける）。
 */
import { ImagePlus, X } from 'lucide-vue-next'
import {
  IMPROVEMENT_IMAGE_MAX_CHARS, IMPROVEMENT_IMAGES_MAX,
  type ImprovementRequestImage,
} from '~/types/improvement'
import { imageToDataUri } from '~/utils/thumb'

// モジュールレベルの「アクティブなインスタンス」スタック（複数同時マウント時も window レベルのドロップ抑止を
// 処理するのは最前面 1 つだけにする）。誤ってドロップエリア外へ落とした画像でページ遷移し入力が消える事故を防ぐ。
// SPA（ssr:false）のためクライアント限定。
let bodyImageInputUidSeq = 0
const bodyImageInputActiveStack: number[] = []

const props = withDefaults(defineProps<{
  /** 本文（v-model） */
  modelValue: string
  /** 添付画像（v-model:images） */
  images: ImprovementRequestImage[]
  /** テキストエリアの行数 */
  rows?: number
  /** プレースホルダ */
  placeholder?: string
  /** 本文テキストエリアの aria-label */
  bodyAriaLabel?: string
  /** 画像の添付を許可するか（既定 true）。API モードで既存画像の遅延ロードに失敗した編集では false =
   *  画像 UI を隠し現行添付を保持する（追加の無言喪失を防ぐ = レビュー R2 の踏襲） */
  imagesEditable?: boolean
  /** window レベルのドロップ抑止を有効にするか（表示中のみ true。既定 true） */
  active?: boolean
}>(), { rows: 5, placeholder: '', bodyAriaLabel: '要望の内容', imagesEditable: true, active: true })

const emit = defineEmits<{
  'update:modelValue': [v: string]
  'update:images': [v: ImprovementRequestImage[]]
  /** 画像処理中フラグ（親の送信/保存ボタンを処理中は無効化するため。v-model:busy で受ける） */
  'update:busy': [v: boolean]
}>()

const { show: showToast } = useToast()

const imageBusy = ref(false)
const imageInput = ref<HTMLInputElement | null>(null)
const dragActive = ref(false)
watch(imageBusy, v => emit('update:busy', v))

/** 画像ファイル群を縮小して添付する（+ ボタン・貼り付け・ドロップの共通経路 = 原則3） */
async function addImageFiles(files: File[]): Promise<void> {
  // 画像編集不可（遅延ロード失敗の編集）では貼り付け/ドロップも受け付けない（追加の無言喪失を全経路で防ぐ）
  if (!props.imagesEditable || files.length === 0) return
  if (imageBusy.value) {
    showToast('画像を処理中です。完了してからもう一度お試しください', 'warn')
    return
  }
  imageBusy.value = true
  try {
    const next = [...props.images]
    for (const file of files) {
      if (next.length >= IMPROVEMENT_IMAGES_MAX) {
        showToast(`画像は ${IMPROVEMENT_IMAGES_MAX} 件までです`, 'warn')
        break
      }
      if (!file.type.startsWith('image/')) {
        showToast(`画像以外のファイルは添付できません（${file.name}）`, 'warn')
        continue
      }
      try {
        const uri = await imageToDataUri(file)
        if (uri.length > IMPROVEMENT_IMAGE_MAX_CHARS) {
          showToast(`画像を縮小しても大きすぎます（${file.name}）。別の画像をお試しください`, 'warn')
          continue
        }
        const mime = uri.slice('data:'.length, uri.indexOf(';'))
        next.push({ filename: file.name, mime, dataUrl: uri })
      } catch (e) {
        showToast((e as Error).message, 'crit')
      }
    }
    emit('update:images', next)
  } finally {
    imageBusy.value = false
  }
}

async function onImagePick(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = '' // 同一ファイル再選択を許可
  await addImageFiles(files)
}
function removeImage(i: number): void {
  emit('update:images', props.images.filter((_, idx) => idx !== i))
}

function imageFilesOf(items: DataTransferItemList | null | undefined): File[] {
  return Array.from(items ?? [])
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((f): f is File => !!f)
}

// テキストエリアの貼り付け: クリップボードに従い、テキストは通常反映（介入しない）・画像は添付。
// 画像ファイルがあるときだけ preventDefault（= 画像をテキストとして貼り込まない）。テキストのみの貼り付けは素通し。
async function onPaste(ev: ClipboardEvent): Promise<void> {
  if (!props.imagesEditable) return
  const files = imageFilesOf(ev.clipboardData?.items)
  if (files.length === 0) return // テキスト等 = 既定動作で textarea に反映
  ev.preventDefault()
  await addImageFiles(files)
}

// テキストエリアへのドラッグ&ドロップでも添付できる（枠内に落とす = 直感的）
function onDrop(ev: DragEvent): void {
  dragActive.value = false
  const files = Array.from(ev.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'))
  if (files.length === 0) return
  ev.preventDefault()
  void addImageFiles(files)
}

// ---------- window 全体のファイルドロップ抑止（最前面インスタンスのみ・active な間だけ） ----------
const uid = ++bodyImageInputUidSeq
function isTopActive(): boolean {
  return bodyImageInputActiveStack.length > 0
    && bodyImageInputActiveStack[bodyImageInputActiveStack.length - 1] === uid
}
watch(() => props.active, (v) => {
  const i = bodyImageInputActiveStack.indexOf(uid)
  if (v) { if (i === -1) bodyImageInputActiveStack.push(uid) }
  else if (i !== -1) bodyImageInputActiveStack.splice(i, 1)
}, { immediate: true })

function hasFileDrag(ev: DragEvent): boolean {
  return !!ev.dataTransfer && Array.from(ev.dataTransfer.types).includes('Files')
}
function onWindowDragOver(ev: DragEvent): void {
  if (!isTopActive() || !hasFileDrag(ev)) return
  ev.preventDefault() // 誤ドロップで SPA ごとページ遷移しない
}
function onWindowDrop(ev: DragEvent): void {
  if (!isTopActive() || !hasFileDrag(ev)) return
  ev.preventDefault()
  dragActive.value = false
}

onMounted(() => {
  window.addEventListener('dragover', onWindowDragOver)
  window.addEventListener('drop', onWindowDrop)
})
onBeforeUnmount(() => {
  window.removeEventListener('dragover', onWindowDragOver)
  window.removeEventListener('drop', onWindowDrop)
  const i = bodyImageInputActiveStack.indexOf(uid)
  if (i !== -1) bodyImageInputActiveStack.splice(i, 1)
})
</script>

<template>
  <div class="grid gap-2">
    <div
      class="relative"
      :class="dragActive ? 'rounded-xl ring-2 ring-brand' : ''"
      @dragover.prevent="dragActive = imagesEditable"
      @dragleave="dragActive = false"
      @drop="onDrop"
    >
      <textarea
        :value="modelValue"
        class="textarea w-full"
        :class="imagesEditable ? 'pb-11' : ''"
        :rows="rows"
        :aria-label="bodyAriaLabel"
        :placeholder="placeholder"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @paste="onPaste"
      />
      <!-- 枠内左下の「+」ボタン（画像添付。Claude ライク）。textarea に下部パディングを取り重ならないようにする -->
      <div v-if="imagesEditable" class="absolute bottom-2 left-2 flex items-center gap-2">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="imageBusy || images.length >= IMPROVEMENT_IMAGES_MAX"
          :aria-label="images.length >= IMPROVEMENT_IMAGES_MAX ? '画像は上限に達しています' : '画像を添付'"
          @click="imageInput?.click()"
        >
          <ImagePlus class="h-4 w-4" aria-hidden="true" />
          <span class="text-[12px]">{{ imageBusy ? '読込中…' : '画像' }}</span>
        </button>
        <span class="text-[11px] text-muted">貼り付け（Ctrl+V / ⌘V）でも添付できます</span>
      </div>
      <input
        ref="imageInput"
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        aria-label="添付画像を選択"
        @change="onImagePick"
      >
    </div>

    <!-- 画像を読み込めなかった編集（imagesEditable=false）: 追加が無言で捨てられないよう UI を出さず保持を明示 -->
    <p v-if="!imagesEditable" class="rounded-[10px] border border-line bg-surface-soft px-3 py-2 text-[12px] text-sub">
      画像を読み込めなかったため、この編集では画像を変更できません（現在の添付はそのまま保持されます）。画像を編集したい場合は一度閉じて開き直してください。
    </p>

    <!-- 添付済みサムネイル（参照時は押下で拡大 = AttachmentList 相当。ここでは編集用に削除ボタン付き） -->
    <div v-if="images.length > 0" class="flex flex-wrap gap-2">
      <div v-for="(img, i) in images" :key="i" class="relative">
        <img
          :src="img.dataUrl"
          :alt="img.filename"
          :title="img.filename"
          class="h-16 w-16 rounded-lg border border-line object-cover"
        >
        <button
          v-if="imagesEditable"
          type="button"
          class="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-line bg-surface text-muted shadow-sm hover:text-crit"
          :aria-label="`画像「${img.filename}」を削除`"
          @click="removeImage(i)"
        >
          <X class="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  </div>
</template>
