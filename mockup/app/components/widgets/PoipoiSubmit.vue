<script setup lang="ts">
/**
 * 改善のタネの投稿導線（改修依頼 2026-08-20）。アプリヘッダーの「改善のタネ」ボタンを、
 * /poipoi ページへの遷移ではなく、この場で登録フォーム（モーダル）を開く導線に変える。
 * 改善要望の投稿（WidgetsImprovementSubmit）と同じ「ヘッダーのボタン → モーダルで即投稿」の操作感に統一し、
 * どの画面からでも気づき・改善アイデアをすぐ投げ込めるようにする。
 *
 * 実データ経路は /poipoi と共通の useNotes('poipoi')（原則3）。本文 + 任意の紐付け（プロジェクト/顧客/
 * 業務種別）を登録できる。送信後は同じモーダル内に「取り消す」導線を出す（投稿者本人の取消 = 原則9.5）。
 * ファイル取込・マークダウンプレビュー・Meet 連携など /poipoi の高度な機能はページ側に残す（quick 投稿に特化）。
 */
import { RotateCcw, Send, Sprout } from 'lucide-vue-next'
import type { Company, Project, WorkCategory } from '~/types/domain'

const notes = useNotes('poipoi')
const { tbl } = useMockDb()
const { show: showToast } = useToast()
const route = useRoute()

const projects = computed(() => (tbl('projects').value as Project[]).filter(p => p.active))
const companies = computed(() => (tbl('companies').value as Company[]).filter(c => c.active))
const workCategories = computed(() =>
  [...(tbl('workCategories').value as WorkCategory[])].filter(w => w.active)
    .sort((a, b) => a.displayOrder - b.displayOrder))

const open = ref(false)
const busy = ref(false)
const form = ref({ body: '', projectId: '', companyId: '', workCategoryId: '' })
/** 送信後の確認 + 取消状態（true = 送信済みビュー） */
const sent = ref(false)
const lastId = ref('')
const lastBody = ref('')

const bodyHasContent = computed(() => form.value.body.trim() !== '')

// プロジェクト選択で顧客を補完（/poipoi と同じ挙動。Project.companyId が SoT。手動変更は妨げない）
watch(() => form.value.projectId, (pid) => {
  if (!pid) return
  const proj = projects.value.find(p => p.id === pid)
  if (proj?.companyId) form.value.companyId = proj.companyId
})

// 画面遷移したら閉じる（開いたまま別ページを覆わない）
watch(() => route.path, () => { open.value = false })

function openModal(): void {
  form.value = { body: '', projectId: '', companyId: '', workCategoryId: '' }
  sent.value = false
  lastId.value = ''
  lastBody.value = ''
  open.value = true
}

async function send(): Promise<void> {
  if (busy.value || !bodyHasContent.value) return
  busy.value = true
  try {
    const res = await notes.add({
      title: '',
      body: form.value.body,
      projectId: form.value.projectId || null,
      companyId: form.value.companyId || null,
      workCategoryId: form.value.workCategoryId || null,
    })
    if (!res.ok) {
      showToast(`${res.error.code}: ${res.error.message}`, 'crit')
      return
    }
    lastId.value = res.id ?? ''
    lastBody.value = form.value.body.trim()
    sent.value = true // モーダル内に「登録しました」+ 取消導線を表示（原則9.5）
  } finally {
    busy.value = false
  }
}

/** 続けて別のタネを投げ込む（入力状態へ戻す） */
function again(): void {
  form.value = { body: '', projectId: '', companyId: '', workCategoryId: '' }
  sent.value = false
  lastId.value = ''
  lastBody.value = ''
}

/** 登録したタネを取り消す（投稿者本人の取消。原則9.5） */
async function undo(): Promise<void> {
  if (!lastId.value) { open.value = false; return }
  const res = await notes.archive(lastId.value)
  if (res.ok) { showToast('投げ込んだタネを取り消しました', 'ok'); open.value = false }
  else showToast(`${res.error.code}: ${res.error.message}`, 'crit')
}
</script>

<template>
  <!-- クイックアクセスの一般リンク（hidden md:inline-flex）と表示条件を揃える = 従来の導線位置を保つ。
       label は lg 以上で併記（task 5 の統一方針。狭幅は他のクイックアクセスと同様アイコンのみ） -->
  <button
    type="button"
    class="btn btn-ghost btn-sm hidden md:inline-flex"
    aria-label="改善のタネを投げ込む"
    @click="openModal"
  >
    <Sprout class="h-4 w-4" aria-hidden="true" />
    <span class="hidden lg:inline">改善のタネ</span>
  </button>

  <UiModal :open="open" :title="sent ? '投げ込みました' : 'タネを投げ込む'" width="560px" @close="open = false">
    <div v-if="!sent" class="grid gap-3">
      <p class="text-[13px] text-sub">
        思いついたこと・気づき・改善アイデアをそのまま投げ込めます。日報ドラフトの材料になり、AI の参照対象（自分のみ）になります。
      </p>
      <!-- 紐付け（任意。/poipoi と同じ項目。プロジェクト選択で顧客を補完） -->
      <div class="flex flex-wrap items-center gap-2">
        <UiSelect v-model="form.projectId" :options="projects.map(p => ({ value: p.id, label: p.name }))" empty-label="プロジェクト（任意）" aria-label="プロジェクト" class="w-auto" />
        <UiSelect v-model="form.companyId" :options="companies.map(c => ({ value: c.id, label: c.name }))" empty-label="顧客（任意）" aria-label="顧客" class="w-auto" />
        <UiSelect v-model="form.workCategoryId" :options="workCategories.map(w => ({ value: w.id, label: w.name }))" empty-label="業務種別（任意）" aria-label="業務種別" class="w-auto" />
      </div>
      <UiFormField label="内容" required>
        <textarea
          v-model="form.body"
          class="textarea min-h-28 w-full"
          placeholder="例）A社の見積、明日までに単価見直しが必要そう"
          aria-label="タネ本文"
        />
      </UiFormField>
      <p class="text-[11px] text-muted">本文はマークダウン記法に対応（表示時に描画されます）。詳しい登録（ファイル取込・プレビュー等）は改善のタネページで行えます。</p>
    </div>

    <div v-else class="grid gap-3">
      <p class="text-[13px] text-ink">改善のタネを投げ込みました。ありがとうございます。</p>
      <p class="card whitespace-pre-wrap p-3 text-[13px] text-sub">{{ lastBody }}</p>
      <p class="text-[12px] text-muted">誤って投げ込んだ場合は「取り消す」で取り消せます（改善のタネページからも復元できます）。</p>
    </div>

    <template #footer>
      <template v-if="!sent">
        <button type="button" class="btn btn-ghost" @click="open = false">キャンセル</button>
        <button type="button" class="btn btn-primary" :disabled="busy || !bodyHasContent" @click="send">
          <Send class="h-4 w-4" aria-hidden="true" />
          {{ busy ? '投げ込み中…' : '投げ込む' }}
        </button>
      </template>
      <template v-else>
        <button type="button" class="btn btn-ghost" @click="undo">
          <RotateCcw class="h-4 w-4" aria-hidden="true" />
          取り消す
        </button>
        <button type="button" class="btn btn-ghost" @click="again">続けて投げ込む</button>
        <button type="button" class="btn btn-primary" @click="open = false">閉じる</button>
      </template>
    </template>
  </UiModal>
</template>
