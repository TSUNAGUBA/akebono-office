<script setup lang="ts">
/**
 * 改善要望の投稿導線（F-42）。全ページ共通ヘッダーに置き、どの画面からでも
 * 「このページの改善・改修の要望」を送れる。投稿元ページのパス・表示名を自動で添付する。
 * 投稿は認証済み全員が可能（閲覧・管理は権限を持つ人のみ = 別ページ）。UiModal は body へ
 * テレポートするため、ボタンをヘッダーに 1 つ置くだけで全ページに導線が出る。
 * 送信後は同じモーダル内で「取り消す」導線 + 修正フォームを出す（投稿者本人の取消/修正 = 原則9.5。誤送信で詰まない）。
 * 添付（改善要望 2026-08-17）: URL リンク（複数）と画像（複数。縮小 data URI = 商品画像と同型。ファイル選択・
 * ドラッグ&ドロップ・貼り付けの 3 経路）は共通部品 ImprovementsAttachmentEditor に集約し、要望編集
 * （ImprovementsRequestEditForm）と共用する（改修依頼 2026-08-19 = 原則3）。
 */
import { MessageSquarePlus, Pencil } from 'lucide-vue-next'
import {
  IMPROVEMENT_BODY_CAP,
  IMPROVEMENT_REQUEST_TAG_META, IMPROVEMENT_REQUEST_TAGS,
  type ImprovementRequestImage, type ImprovementRequestTag, improvementLinksError,
} from '~/types/improvement'
import { listKnownPages, pageDisplay, resolvePageLabel } from '~/utils/page-label'

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

// ---------- 送信直後の修正（F-42-16。投稿者本人の編集権をここで行使できる = 改修依頼 2026-08-18） ----------
// フォームは /improvements の生要望編集と共通部品 ImprovementsRequestEditForm を共用（原則3）。
// 改修依頼 2026-08-19: 本文だけでなくタグ・リンク・画像も修正できる（editRequest は全項目の上書き）。

const editingSent = ref(false)
const editBusy = ref(false)

async function saveEditSent(payload: { body: string; tags: string[]; links: string[]; images: ImprovementRequestImage[] }): Promise<void> {
  if (!lastId.value || editBusy.value) return
  editBusy.value = true
  try {
    const res = await editRequest(lastId.value, payload)
    if (res.ok) {
      // 送信済みビューの表示・再編集の初期値を最新化する（editRequest は全項目を上書きするため refs も揃える）
      lastBody.value = payload.body.trim()
      tags.value = payload.tags
      links.value = payload.links
      images.value = payload.images
      editingSent.value = false
      if (res.persisted === false) {
        // mock の localStorage 容量超過（submit と同型の警告 = 消える編集を黙認しない）
        showToast('要望を修正しましたが、保存容量が上限に達したため再読込時に失われる可能性があります', 'warn')
      } else {
        showToast('送信した要望を修正しました', 'ok')
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
    <!-- 入力（画像のクリップボード貼り付け・ドロップは AttachmentEditor が window で受ける） -->
    <div v-if="!sent" class="grid gap-3">
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

      <!-- 添付（参考リンク + 画像）。追加/削除・縮小・貼り付け/ドロップは共通部品 = 要望編集と共用（原則3） -->
      <ImprovementsAttachmentEditor
        v-model:links="links"
        v-model:images="images"
        v-model:busy="imageBusy"
        :active="open && !sent"
      />
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
      <ImprovementsRequestEditForm
        v-else
        :initial-body="lastBody"
        :initial-tags="tags"
        :initial-links="links"
        :initial-images="images"
        :busy="editBusy"
        :active="editingSent"
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
