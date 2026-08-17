<script setup lang="ts">
/**
 * 改善要望の投稿導線（F-42）。全ページ共通ヘッダーに置き、どの画面からでも
 * 「このページの改善・改修の要望」を送れる。投稿元ページのパス・表示名を自動で添付する。
 * 投稿は認証済み全員が可能（閲覧・管理は権限を持つ人のみ = 別ページ）。UiModal は body へ
 * テレポートするため、ボタンをヘッダーに 1 つ置くだけで全ページに導線が出る。
 * 送信後は同じモーダル内で「取り消す」導線を出す（投稿者本人の取消 = 原則9.5。誤送信で詰まない）。
 * 添付（改善要望 2026-08-17）: URL リンク（複数）と画像（複数。縮小 data URI = 商品画像と同型）を添付できる。
 */
import { ImagePlus, Link2, MessageSquarePlus, X } from 'lucide-vue-next'
import {
  IMPROVEMENT_BODY_CAP, IMPROVEMENT_IMAGE_MAX_CHARS, IMPROVEMENT_IMAGES_MAX, IMPROVEMENT_LINKS_MAX,
  type ImprovementRequestImage, improvementLinksError,
} from '~/types/improvement'
import { resolvePageLabel } from '~/utils/page-label'
import { imageToDataUri } from '~/utils/thumb'

const route = useRoute()
const { submit, setRequestArchived } = useImprovements()
const { show: showToast } = useToast()

const open = ref(false)
const body = ref('')
const busy = ref(false)
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

/** 投稿元ページの表示名（ナビ/カードメニュー定義から解決・サブページは前方一致・無ければパス） */
const pageLabel = computed(() => resolvePageLabel(route.path))

// 画面遷移したら閉じる（開いたまま別ページを覆わない）
watch(() => route.path, () => { open.value = false })

function openModal(): void {
  body.value = ''
  links.value = []
  images.value = []
  sent.value = false
  lastId.value = ''
  lastBody.value = ''
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

async function onImagePick(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = '' // 同一ファイル再選択を許可
  if (files.length === 0 || imageBusy.value) return
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
function removeImage(i: number): void {
  images.value = images.value.filter((_, idx) => idx !== i)
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
    body: body.value, pagePath: route.path, pageLabel: pageLabel.value,
    links: trimmedLinks, images: images.value,
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

/** 続けて別の要望を送る（入力状態へ戻す） */
function again(): void {
  sent.value = false
  lastId.value = ''
  body.value = ''
  links.value = []
  images.value = []
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
    <!-- 入力 -->
    <div v-if="!sent" class="grid gap-3">
      <p class="text-[13px] text-sub">
        このページ「<span class="font-semibold text-ink">{{ pageLabel }}</span>」について、改善・改修の要望を送れます。
        内容は権限を持つ担当者が AI で整理し、改修の検討に活用します。
      </p>
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
        <p class="text-[11px] text-muted">スクリーンショット等を添付できます（自動で縮小されます）。参照時は押下で拡大表示されます。</p>
      </div>
    </div>

    <!-- 送信後（取消導線） -->
    <div v-else class="grid gap-3">
      <p class="text-[13px] text-ink">
        要望を送信しました。ありがとうございます。権限を持つ担当者が AI で整理し、改修の検討に活用します。
      </p>
      <p class="card whitespace-pre-wrap p-3 text-[13px] text-sub">{{ lastBody }}</p>
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
