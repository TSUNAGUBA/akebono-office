<script setup lang="ts">
/**
 * 改善要望の投稿導線（F-42）。全ページ共通ヘッダーに置き、どの画面からでも
 * 「このページの改善・改修の要望」を送れる。投稿元ページのパス・表示名を自動で添付する。
 * 投稿は認証済み全員が可能（閲覧・管理は権限を持つ人のみ = 別ページ）。UiModal は body へ
 * テレポートするため、ボタンをヘッダーに 1 つ置くだけで全ページに導線が出る。
 * 送信後は同じモーダル内で「取り消す」導線を出す（投稿者本人の取消 = 原則9.5。誤送信で詰まない）。
 */
import { MessageSquarePlus } from 'lucide-vue-next'
import { isActivePath, NAV_GROUPS } from '~/utils/navigation'
import { IMPROVEMENT_BODY_CAP } from '~/types/improvement'

const route = useRoute()
const { submit, setRequestArchived } = useImprovements()
const { show: showToast } = useToast()

const open = ref(false)
const body = ref('')
const busy = ref(false)
/** 送信後の確認 + 取消状態（true = 送信済みビュー） */
const sent = ref(false)
const lastId = ref('')
const lastBody = ref('')

/** 投稿元ページの表示名（ナビ定義から解決・無ければパス） */
const pageLabel = computed(() => {
  for (const g of NAV_GROUPS) {
    for (const i of g.items) {
      if (isActivePath(route.path, i)) return i.label
    }
  }
  return route.path
})

// 画面遷移したら閉じる（開いたまま別ページを覆わない）
watch(() => route.path, () => { open.value = false })

function openModal(): void {
  body.value = ''
  sent.value = false
  lastId.value = ''
  lastBody.value = ''
  open.value = true
}

async function send(): Promise<void> {
  if (busy.value || !body.value.trim()) return
  busy.value = true
  const res = await submit({ body: body.value, pagePath: route.path, pageLabel: pageLabel.value })
  busy.value = false
  if (res.ok) {
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
        <button type="button" class="btn btn-primary" :disabled="busy || !body.trim()" @click="send">
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
