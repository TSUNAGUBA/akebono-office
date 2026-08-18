<script setup lang="ts">
/**
 * 改善要望の投稿導線（F-42）。全ページ共通ヘッダーに置き、どの画面からでも
 * 「このページの改善・改修の要望」を送れる。投稿元ページのパス・表示名を自動で添付する。
 * 投稿は認証済み全員が可能（閲覧・管理は権限を持つ人のみ = 別ページ）。UiModal は body へ
 * テレポートするため、ボタンをヘッダーに 1 つ置くだけで全ページに導線が出る。
 * 送信後は同じモーダル内で「取り消す」導線を出す（投稿者本人の取消 = 原則9.5。誤送信で詰まない）。
 * 添付（改善要望 2026-08-17）: URL リンク（複数）と画像（複数。縮小 data URI = 商品画像と同型）を添付できる。
 * 画像はファイル選択に加え、ドロップエリアへのドラッグ&ドロップとクリップボード貼り付けでも添付できる
 * （改修依頼 2026-08-18。3 経路とも共通の addImageFiles で縮小・上限・種別チェックを通す = 原則3）。
 */
import { ImagePlus, Link2, MessageSquarePlus, Pencil, X } from 'lucide-vue-next'
import {
  IMPROVEMENT_BODY_CAP, IMPROVEMENT_IMAGE_MAX_CHARS, IMPROVEMENT_IMAGES_MAX, IMPROVEMENT_LINKS_MAX,
  IMPROVEMENT_REQUEST_TAG_META, IMPROVEMENT_REQUEST_TAGS,
  type ImprovementRequestImage, type ImprovementRequestTag, improvementLinksError,
} from '~/types/improvement'
import { listKnownPages, pageDisplay, resolvePageLabel } from '~/utils/page-label'
import { imageToDataUri } from '~/utils/thumb'

const route = useRoute()
const { submit, setRequestArchived, editRequest } = useImprovements()
const { show: showToast } = useToast()

const open = ref(false)
const body = ref('')
const busy = ref(false)

// ---------- 対象ページの選択（改善要望 2026-08-17。既定 = 開いているページ・全体/新設ページも選べる） ----------

/** 特別な対象（実ページ以外）。value はページ選択の内部値（送信時に pagePath/pageLabel へ変換） */
const TARGET_ALL = '__all__'
const TARGET_NEW = '__new__'

/** 対象ページの選択値（既定 = 現在のページ。モーダルを開くたびにリセット） */
const targetPage = ref('')

const targetOptions = computed(() => {
  const pages = listKnownPages().map(p => ({ value: p.path, label: pageDisplay(p.path) }))
  // 現在ページがカタログ外（動的ルート等）でも選択肢に含める（既定値が消えない）
  if (!pages.some(p => p.value === route.path)) {
    pages.unshift({ value: route.path, label: pageDisplay(route.path) })
  }
  return [
    { value: TARGET_ALL, label: '全体（すべてのページに波及する要望）' },
    { value: TARGET_NEW, label: '新設ページ（新しい画面がほしい要望）' },
    ...pages,
  ]
})

/** 送信時の対象（pagePath/pageLabel）。全体・新設ページはパスなし + ラベルで区別（表示側はラベル優先表示） */
const targetOf = computed<{ pagePath: string; pageLabel: string }>(() => {
  if (targetPage.value === TARGET_ALL) return { pagePath: '', pageLabel: '全体' }
  if (targetPage.value === TARGET_NEW) return { pagePath: '', pageLabel: '新設ページ' }
  return { pagePath: targetPage.value, pageLabel: resolvePageLabel(targetPage.value) }
})
/** 任意タグ（壁打ち/お任せ = F-42-17・改修依頼 2026-08-18）。選択肢・ラベルの SoT = shared の TAG_META */
const tags = ref<string[]>([])
const TAG_OPTIONS = IMPROVEMENT_REQUEST_TAGS.map(t => ({ value: t, label: IMPROVEMENT_REQUEST_TAG_META[t].label }))
/** 添付リンク入力欄（複数。空欄は送信時に除外） */
const links = ref<string[]>([])
/** 添付画像（縮小済み data URI。プレビュー表示 + 個別削除可） */
const images = ref<ImprovementRequestImage[]>([])
const imageBusy = ref(false)
const imageInput = ref<HTMLInputElement | null>(null)
/** 送信後の確認 + 取消状態（true = 送信済みビュー） */
const sent = ref(false)
const lastId = ref('')
const lastBody = ref('')

// 画面遷移したら閉じる（開いたまま別ページを覆わない）
watch(() => route.path, () => { open.value = false })

function openModal(): void {
  body.value = ''
  tags.value = []
  links.value = []
  images.value = []
  targetPage.value = route.path // 既定 = 開いているページ（選び直し可 = 改善要望 2026-08-17）
  sent.value = false
  lastId.value = ''
  lastBody.value = ''
  editingSent.value = false
  open.value = true
}

// ---------- 添付リンク（複数。参照時は別タブで開く） ----------

function addLink(): void {
  if (links.value.length >= IMPROVEMENT_LINKS_MAX) return
  links.value = [...links.value, '']
}
function removeLink(i: number): void {
  links.value = links.value.filter((_, idx) => idx !== i)
}

// ---------- 添付画像（複数。参照時は押下で拡大） ----------

/** 画像ファイル群を縮小して添付する（ファイル選択・ドラッグ&ドロップ・貼り付けの共通経路 = 原則3） */
async function addImageFiles(files: File[]): Promise<void> {
  if (files.length === 0) return
  if (imageBusy.value) {
    // 貼り付け・ドロップは連続入力が容易なため、黙って捨てずに理由を伝える（X-1 = 全操作が反応する）
    showToast('画像を処理中です。完了してからもう一度お試しください', 'warn')
    return
  }
  imageBusy.value = true
  try {
    for (const file of files) {
      if (images.value.length >= IMPROVEMENT_IMAGES_MAX) {
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
        images.value = [...images.value, { filename: file.name, mime, dataUrl: uri }]
      } catch (e) {
        showToast((e as Error).message, 'crit')
      }
    }
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
  images.value = images.value.filter((_, idx) => idx !== i)
}

// ---------- ドラッグ&ドロップ / クリップボード貼り付け（改修依頼 2026-08-18） ----------

/** ドロップエリアの強調表示（ドラッグ中） */
const dragActive = ref(false)

async function onImageDrop(ev: DragEvent): Promise<void> {
  dragActive.value = false
  await addImageFiles(Array.from(ev.dataTransfer?.files ?? []))
}

/**
 * モーダル入力中はウィンドウ全体でファイルドロップの既定動作（画像ファイルへのページ遷移 =
 * 入力途中のフォームが失われる）を抑止し、ドロップエリア外に落とした画像も添付として受ける（レビュー指摘）。
 * ファイル以外のドラッグ（テキスト選択の D&D 等）は既定動作のまま = types に 'Files' を含むときだけ介入する。
 * ドロップエリア上のドロップは要素側ハンドラが処理し stopPropagation する（二重添付防止）。
 */
function hasFileDrag(ev: DragEvent): boolean {
  return !!ev.dataTransfer && Array.from(ev.dataTransfer.types).includes('Files')
}
function onWindowDragOver(ev: DragEvent): void {
  if (!open.value || !hasFileDrag(ev)) return
  ev.preventDefault()
}
function onWindowDrop(ev: DragEvent): void {
  if (!open.value || !hasFileDrag(ev)) return
  // 送信後ビュー（取消導線の表示中）でもページ遷移は抑止する（誤ドロップで SPA ごと失わない）。
  // 添付の追加は入力ビューのみ（送信後は受け取らない）
  ev.preventDefault()
  if (sent.value) return
  dragActive.value = false
  void addImageFiles(Array.from(ev.dataTransfer?.files ?? []))
}
onMounted(() => {
  window.addEventListener('dragover', onWindowDragOver)
  window.addEventListener('drop', onWindowDrop)
})
onBeforeUnmount(() => {
  window.removeEventListener('dragover', onWindowDragOver)
  window.removeEventListener('drop', onWindowDrop)
})

/**
 * クリップボードからの画像貼り付け（入力ビュー全体で受ける = テキスト欄にフォーカスしたままでも貼れる）。
 * 画像を含まない貼り付け（テキスト等）は既定動作のまま = preventDefault しない。
 */
async function onPaste(ev: ClipboardEvent): Promise<void> {
  const files = Array.from(ev.clipboardData?.items ?? [])
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((f): f is File => !!f)
  if (files.length === 0) return
  ev.preventDefault() // 画像はテキストとして貼り込まず添付として扱う
  await addImageFiles(files)
}

async function send(): Promise<void> {
  if (busy.value || !body.value.trim()) return
  // リンクの形式は送信前に検証してフォーム内で指摘（shared の共有検証 = API と同一判定）
  const trimmedLinks = links.value.map(l => l.trim()).filter(Boolean)
  const linksMsg = improvementLinksError(trimmedLinks)
  if (linksMsg) {
    showToast(linksMsg, 'crit')
    return
  }
  busy.value = true
  const res = await submit({
    body: body.value, pagePath: targetOf.value.pagePath, pageLabel: targetOf.value.pageLabel,
    links: trimmedLinks, images: images.value, tags: tags.value as ImprovementRequestTag[],
  })
  busy.value = false
  if (res.ok) {
    if (res.persisted === false) {
      // モックの localStorage 容量超過: 当セッションでは送信済み扱いだが再読込で失われる可能性を明示（商品画像と同型）
      showToast('要望を送信しましたが、保存容量が上限に達したため再読込時に失われる可能性があります。画像を減らしてお試しください', 'warn')
    }
    lastId.value = res.id ?? ''
    lastBody.value = body.value.trim()
    body.value = ''
    sent.value = true // モーダル内に「送信しました」+ 取消導線を表示（原則9.5）
  } else {
    showToast(`${res.error.code}: ${res.error.message}`, 'crit')
  }
}

/** 続けて別の要望を送る（入力状態へ戻す。修正フォームの残留状態も破棄 = 次の送信確認画面を汚さない） */
function again(): void {
  sent.value = false
  lastId.value = ''
  body.value = ''
  tags.value = []
  links.value = []
  images.value = []
  editingSent.value = false
}

// ---------- 送信直後の本文修正（F-42-16。投稿者本人の編集権をここで行使できる = 改修依頼 2026-08-18） ----------
// フォームは /improvements の生要望編集と共通部品 ImprovementsBodyEditForm を共用（原則3）

const editingSent = ref(false)
const editBusy = ref(false)

async function saveEditSent(body: string): Promise<void> {
  if (!lastId.value || editBusy.value) return
  editBusy.value = true
  try {
    const res = await editRequest(lastId.value, body)
    if (res.ok) {
      lastBody.value = body.trim()
      editingSent.value = false
      if (res.persisted === false) {
        // mock の localStorage 容量超過（submit と同型の警告 = 消える編集を黙認しない）
        showToast('本文を修正しましたが、保存容量が上限に達したため再読込時に失われる可能性があります', 'warn')
      } else {
        showToast('送信した要望の本文を修正しました', 'ok')
      }
    } else {
      showToast(`${res.error.code}: ${res.error.message}`, 'crit')
    }
  } finally {
    editBusy.value = false
  }
}

/** 送信した要望を取り消す（投稿者本人の取消。API/mock とも本人可） */
async function undo(): Promise<void> {
  if (!lastId.value) { open.value = false; return }
  const res = await setRequestArchived(lastId.value, true)
  if (res.ok) { showToast('送信した要望を取り消しました', 'ok'); open.value = false }
  else showToast(`${res.error.code}: ${res.error.message}`, 'crit')
}
</script>

<template>
  <button type="button" class="btn btn-ghost btn-sm" aria-label="このページの改善要望を送る" @click="openModal">
    <MessageSquarePlus class="h-4 w-4" aria-hidden="true" />
    <span class="hidden sm:inline">要望</span>
  </button>

  <UiModal :open="open" :title="sent ? '送信しました' : '要望を送る'" width="520px" @close="open = false">
    <!-- 入力（@paste = 画像のクリップボード貼り付けをビュー全体で受ける。テキスト貼り付けは既定動作のまま） -->
    <div v-if="!sent" class="grid gap-3" @paste="onPaste">
      <p class="text-[13px] text-sub">
        改善・改修の要望を送れます。内容は権限を持つ担当者が AI で整理し、改修の検討に活用します。
      </p>
      <!-- 対象ページ（既定 = 開いているページ。全体・新設ページ・他ページへ選び直せる = 改善要望 2026-08-17） -->
      <UiFormField label="対象ページ" hint="既定は今開いているページです。すべてのページに波及する要望は「全体」、新しい画面の要望は「新設ページ」を選んでください">
        <UiSelect v-model="targetPage" :options="targetOptions" aria-label="要望の対象ページ" class="!w-full" />
      </UiFormField>
      <UiFormField label="要望の内容" required>
        <textarea
          v-model="body"
          class="textarea"
          rows="5"
          :maxlength="IMPROVEMENT_BODY_CAP"
          placeholder="例）売上一覧で合計金額をもっと大きく表示してほしい。締め作業で一番見る数字なので。"
        />
      </UiFormField>
      <p class="text-right text-[11px] text-muted num">{{ [...body].length }} / {{ IMPROVEMENT_BODY_CAP }}</p>

      <!-- 任意タグ（壁打ち/お任せ = F-42-17・改修依頼 2026-08-18。進め方の意思表示） -->
      <UiFormField
        label="タグ（任意）"
        hint="「壁打ち」= 壁打ち（対話での要件整理）を経て案件化したい意思表示。「お任せ」= 受け取った内容を開発側の解釈で進めてよい"
      >
        <UiChipSelect v-model="tags" :options="TAG_OPTIONS" aria-label="要望のタグ" />
      </UiFormField>

      <!-- 添付リンク（複数。参照時は別タブで開く） -->
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
        <div v-for="(_, i) in links" :key="i" class="flex items-center gap-1.5">
          <input
            v-model="links[i]"
            class="input flex-1"
            type="url"
            inputmode="url"
            placeholder="https://example.com/..."
            :aria-label="`参考リンク ${i + 1}`"
          >
          <button type="button" class="btn btn-ghost btn-sm shrink-0" :aria-label="`参考リンク ${i + 1} を削除`" @click="removeLink(i)">
            <X class="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p v-if="links.length > 0" class="text-[11px] text-muted">http(s):// で始まる URL を入力してください。参照時は別タブで開きます。</p>
      </div>

      <!-- 添付画像（複数。参照時は押下で拡大） -->
      <div class="grid gap-1.5">
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
        <!-- ドロップエリア（ドラッグ&ドロップ / クリック選択 / 貼り付け。改修依頼 2026-08-18）。
             上限到達時は「画像を追加」ボタンと同じく非表示（プレビューと削除だけ残す） -->
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
          <!-- pointer-events-none: 子要素上の dragleave ちらつき防止 -->
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

    <!-- 送信後（取消導線 + 本文の修正 = F-42-16。投稿者本人の編集） -->
    <div v-else class="grid gap-3">
      <p class="text-[13px] text-ink">
        要望を送信しました。ありがとうございます。権限を持つ担当者が AI で整理し、改修の検討に活用します。
      </p>
      <template v-if="!editingSent">
        <p class="card whitespace-pre-wrap p-3 text-[13px] text-sub">{{ lastBody }}</p>
        <div>
          <button type="button" class="btn btn-sm" @click="editingSent = true">
            <Pencil class="h-3.5 w-3.5" aria-hidden="true" /> 内容を修正する
          </button>
        </div>
      </template>
      <ImprovementsBodyEditForm
        v-else
        :initial="lastBody"
        :busy="editBusy"
        @save="saveEditSent"
        @cancel="editingSent = false"
      />
      <p class="text-[12px] text-muted">誤って送った場合は「取り消す」で取り消せます（あとから管理画面でも取消・復元できます）。</p>
    </div>

    <template #footer>
      <template v-if="!sent">
        <button type="button" class="btn btn-ghost" @click="open = false">キャンセル</button>
        <button type="button" class="btn btn-primary" :disabled="busy || imageBusy || !body.trim()" @click="send">
          {{ busy ? '送信中…' : '送信する' }}
        </button>
      </template>
      <template v-else>
        <button type="button" class="btn btn-ghost" @click="undo">取り消す</button>
        <button type="button" class="btn btn-ghost" @click="again">続けて送る</button>
        <button type="button" class="btn btn-primary" @click="open = false">閉じる</button>
      </template>
    </template>
  </UiModal>
</template>
