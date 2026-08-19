<script setup lang="ts">
/**
 * 改善要望の添付（参考リンク + 画像）の編集フォーム（共通部品。改修依頼 2026-08-19）。
 * 投稿（ImprovementSubmit）と要望詳細の編集（RequestEditForm）で共用する（原則3）。
 * リンクの追加/削除/編集・画像の追加（ファイル選択 / ドラッグ&ドロップ / クリップボード貼り付けの 3 経路）/
 * 削除を一箇所に集約し、縮小・種別・上限チェックを共通化する。値は links / images の v-model で親と同期。
 * リンクの形式検証（http(s)・件数）は保存時に親が shared の improvementLinksError で行う（本部品は入力のみ）。
 */
import { ImagePlus, Link2, X } from 'lucide-vue-next'
import {
  IMPROVEMENT_IMAGE_MAX_CHARS, IMPROVEMENT_IMAGES_MAX, IMPROVEMENT_LINKS_MAX,
  type ImprovementRequestImage,
} from '~/types/improvement'
import { imageToDataUri } from '~/utils/thumb'

// モジュールレベルの「アクティブなインスタンス」スタック（レビュー R1 MINOR）。
// AttachmentEditor が複数同時マウントされても（投稿モーダル + 要望編集ドロワー等）、window レベルの
// ドロップ/貼り付けを処理するのは最前面（最後に active になった）1 つだけにする。両方が active な瞬間に
// 貼り付け画像が両フォームへ二重添付されるのを防ぐ。SPA（ssr:false）のためモジュール状態はクライアント限定。
let attachmentEditorUidSeq = 0
const attachmentEditorActiveStack: number[] = []

const props = withDefaults(defineProps<{
  links: string[]
  images: ImprovementRequestImage[]
  /** ウィンドウ全体のファイルドロップ抑止を有効にするか（表示中のみ true。既定 true） */
  active?: boolean
  /** 画像の編集（追加/削除）を許可するか（既定 true）。API モードで既存画像の遅延ロードに失敗した
   *  編集では false = 画像編集 UI を出さず現行添付を保持する（追加が無言で捨てられる事故の防止 = レビュー R2 MINOR） */
  imagesEditable?: boolean
}>(), { active: true, imagesEditable: true })

const emit = defineEmits<{
  'update:links': [v: string[]]
  'update:images': [v: ImprovementRequestImage[]]
  /** 画像処理中フラグ（親の送信/保存ボタンを処理中は無効化するため。v-model:busy で受ける） */
  'update:busy': [v: boolean]
}>()

const { show: showToast } = useToast()

const imageBusy = ref(false)
const imageInput = ref<HTMLInputElement | null>(null)
const dragActive = ref(false)
// 画像処理中は親の送信/保存を止められるよう busy を通知する（縮小中に確定して添付が漏れる事故の防止）
watch(imageBusy, v => emit('update:busy', v))

// ---------- 参考リンク（複数。参照時は別タブで開く） ----------

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

// ---------- 添付画像（複数。参照時は押下で拡大） ----------

/** 画像ファイル群を縮小して添付する（ファイル選択・ドラッグ&ドロップ・貼り付けの共通経路 = 原則3） */
async function addImageFiles(files: File[]): Promise<void> {
  // 画像編集不可（遅延ロード失敗の編集）では window レベルの貼り付け/ドロップも受け付けない
  // （UI は隠しているが window ハンドラは生きているため = 追加の無言喪失を全経路で防ぐ。レビュー R2 MINOR）
  if (!props.imagesEditable || files.length === 0) return
  if (imageBusy.value) {
    // 連続入力（貼り付け・ドロップ）でも黙って捨てず理由を伝える（X-1 = 全操作が反応する）
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
        // mime は縮小後の data URI から導出（imageToDataUri は PNG/JPEG へ再エンコードするため file.type とずれうる）
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

async function onImageDrop(ev: DragEvent): Promise<void> {
  dragActive.value = false
  await addImageFiles(Array.from(ev.dataTransfer?.files ?? []))
}

// ---------- ウィンドウ全体のファイルドロップ抑止 + 貼り付け（active な間のみ） ----------
// ドロップエリア外に落とした画像ファイルへのページ遷移（入力途中のフォーム喪失）を防ぐ。
// ファイル以外のドラッグ（テキスト選択の D&D 等）は既定動作のまま = types に 'Files' を含むときだけ介入。

// 自インスタンスが window イベントを処理する権利を持つか（active かつスタック最前面）
const uid = ++attachmentEditorUidSeq
function isTopActive(): boolean {
  return attachmentEditorActiveStack.length > 0
    && attachmentEditorActiveStack[attachmentEditorActiveStack.length - 1] === uid
}
// active の切替でスタックを更新（true = 最前面へ / false = 除去）。immediate で初期状態も反映
watch(() => props.active, (v) => {
  const i = attachmentEditorActiveStack.indexOf(uid)
  if (v) { if (i === -1) attachmentEditorActiveStack.push(uid) }
  else if (i !== -1) attachmentEditorActiveStack.splice(i, 1)
}, { immediate: true })

function hasFileDrag(ev: DragEvent): boolean {
  return !!ev.dataTransfer && Array.from(ev.dataTransfer.types).includes('Files')
}
function onWindowDragOver(ev: DragEvent): void {
  if (!isTopActive() || !hasFileDrag(ev)) return
  ev.preventDefault()
}
function onWindowDrop(ev: DragEvent): void {
  if (!isTopActive() || !hasFileDrag(ev)) return
  ev.preventDefault() // 誤ドロップで SPA ごとページ遷移しない
  dragActive.value = false
  void addImageFiles(Array.from(ev.dataTransfer?.files ?? []))
}
async function onWindowPaste(ev: ClipboardEvent): Promise<void> {
  if (!isTopActive()) return
  const files = Array.from(ev.clipboardData?.items ?? [])
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((f): f is File => !!f)
  if (files.length === 0) return
  ev.preventDefault() // 画像はテキストとして貼り込まず添付として扱う
  await addImageFiles(files)
}

onMounted(() => {
  window.addEventListener('dragover', onWindowDragOver)
  window.addEventListener('drop', onWindowDrop)
  window.addEventListener('paste', onWindowPaste)
})
onBeforeUnmount(() => {
  window.removeEventListener('dragover', onWindowDragOver)
  window.removeEventListener('drop', onWindowDrop)
  window.removeEventListener('paste', onWindowPaste)
  const i = attachmentEditorActiveStack.indexOf(uid)
  if (i !== -1) attachmentEditorActiveStack.splice(i, 1)
})
</script>

<template>
  <div class="grid gap-3">
    <!-- 参考リンク（複数。参照時は別タブで開く） -->
    <div class="grid gap-1.5">
      <div class="flex items-center justify-between">
        <p class="label">参考リンク（任意・{{ IMPROVEMENT_LINKS_MAX }} 件まで）</p>
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

    <!-- 画像を読み込めなかった編集（imagesEditable=false）: 追加が無言で捨てられないよう画像編集 UI を出さず、
         現行添付が保持される旨を明示する（レビュー R2 MINOR。本文・タグ・リンクは通常どおり編集可） -->
    <div v-if="!imagesEditable" class="rounded-[10px] border border-line bg-surface-soft px-3 py-2 text-[12px] text-sub">
      画像を読み込めなかったため、この編集では画像を変更できません（現在の添付はそのまま保持されます）。画像を編集したい場合は一度閉じて開き直してください。
    </div>

    <!-- 添付画像（複数。参照時は押下で拡大） -->
    <div v-else class="grid gap-1.5">
      <div class="flex items-center justify-between">
        <p class="label">画像（任意・{{ IMPROVEMENT_IMAGES_MAX }} 件まで）</p>
        <button
          v-if="images.length < IMPROVEMENT_IMAGES_MAX"
          type="button" class="btn btn-ghost btn-sm" :disabled="imageBusy" @click="imageInput?.click()"
        >
          <ImagePlus class="h-4 w-4" aria-hidden="true" /> {{ imageBusy ? '読込中…' : '画像を追加' }}
        </button>
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
      <div
        v-if="images.length < IMPROVEMENT_IMAGES_MAX"
        class="grid min-h-16 cursor-pointer place-items-center rounded-xl border-2 border-dashed px-3 py-2.5 text-center transition-colors"
        :class="dragActive ? 'border-brand bg-brand-soft' : 'border-line hover:border-line-strong'"
        role="button"
        tabindex="0"
        aria-label="画像をドラッグ&ドロップ、クリックで選択、または貼り付けで添付"
        @click="imageInput?.click()"
        @keydown.enter.prevent="imageInput?.click()"
        @keydown.space.prevent="imageInput?.click()"
        @dragover.prevent="dragActive = true"
        @dragleave="dragActive = false"
        @drop.prevent.stop="onImageDrop"
      >
        <span class="pointer-events-none grid place-items-center gap-0.5 text-[12px] text-muted">
          <ImagePlus class="h-5 w-5" aria-hidden="true" />
          <span>{{ imageBusy ? '読込中…' : 'ここに画像をドラッグ&ドロップ（クリックで選択）' }}</span>
          <span class="text-[11px]">スクリーンショットはコピーしてそのまま貼り付け（Ctrl+V / ⌘V）もできます</span>
        </span>
      </div>
      <div v-if="images.length > 0" class="flex flex-wrap gap-2">
        <div v-for="(img, i) in images" :key="i" class="relative">
          <img
            :src="img.dataUrl"
            :alt="img.filename"
            :title="img.filename"
            class="h-16 w-16 rounded-lg border border-line object-cover"
          >
          <button
            type="button"
            class="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-line bg-surface text-muted shadow-sm hover:text-crit"
            :aria-label="`画像「${img.filename}」を削除`"
            @click="removeImage(i)"
          >
            <X class="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      </div>
      <p class="text-[11px] text-muted">スクリーンショット等を添付できます（ドラッグ&ドロップ・貼り付け対応。自動で縮小されます）。参照時は押下で拡大表示されます。</p>
    </div>
  </div>
</template>
