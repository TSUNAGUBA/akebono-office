<script setup lang="ts">
/**
 * メディアチャンネル設定（F-40-4・管理者ゲート必須）— /media/settings。
 * 独立したメディアチャンネルごとに、GA 連携・連携先業態（任意）・AI 分析設定・外部投稿記事を
 * 「画面操作だけで」完結させる。
 * - GA 連携: MediaGaConnect（モック = 擬似 OAuth / API = Google OAuth 2.0 + GA4 プロパティ選択。
 *   OAuth 復帰はこのページへ ?ga=&channel= クエリで戻る）
 * - 連携先業態: 任意（未選択 = 単体チャンネル）。連携すると業務 × メディアの統合 PDCA が使える
 * - AI 分析設定: サイト名・URL・分析の目的・ターゲット読者・既定トーン・重点キーワード
 * - 外部投稿記事: 外部媒体へ投稿した記事の原文を保管（media インサイト生成の材料）。取消/復元可
 * 取消可能性（原則9.5）: チャンネル・外部記事は取消/復元でき、連携は解除でき、設定は再編集で上書きできる。
 */
import { Plus } from 'lucide-vue-next'
import { INDUSTRY_TYPE_LABELS } from '~/utils/akebono'
import { ARTICLE_TONE_OPTIONS, MEDIA_GOAL_OPTIONS } from '~/utils/media'
import type { ArticleTone } from '~/utils/media'
import type { MediaChannel, MediaExternalArticle, MediaGoal } from '~/types/media'

const { channels, settingFor, save, createChannel, archiveChannel, restoreChannel } = useMediaChannels()
const { activeSegments, segmentById } = useCurrentSegment()
const external = useMediaExternalArticles()
const { show } = useToast()
const confirm = useConfirm()
const route = useRoute()

const activeChannels = computed(() => (channels.value as MediaChannel[]).filter(c => c.active !== false))
const archivedChannels = computed(() => (channels.value as MediaChannel[]).filter(c => c.active === false))

// OAuth 復帰（?channel=）は対象チャンネルを選択して開く（MediaGaConnect の復帰処理と表示を一致させる）
const returnChannel = typeof route.query.channel === 'string' ? route.query.channel : ''
const selectedId = ref(returnChannel || activeChannels.value[0]?.id || '')
// チャンネルが後から届く（API 遅延ロード）場合、未選択なら先頭へ寄せる
watch(activeChannels, (list) => {
  if (!selectedId.value || !list.some(c => c.id === selectedId.value)) {
    selectedId.value = returnChannel && list.some(c => c.id === returnChannel) ? returnChannel : (list[0]?.id ?? '')
  }
}, { immediate: true })
const selectedChannel = computed(() => (channels.value as MediaChannel[]).find(c => c.id === selectedId.value) ?? null)

interface Form {
  name: string
  segmentId: string
  siteName: string
  siteUrl: string
  analysisGoal: MediaGoal
  targetAudience: string
  defaultTone: ArticleTone
  keywords: string
}
const form = ref<Form>({ name: '', segmentId: '', siteName: '', siteUrl: '', analysisGoal: 'awareness', targetAudience: '', defaultTone: 'formal', keywords: '' })

/** 選択チャンネルの保存済み設定をフォームへ読み込む */
function loadForm(): void {
  const s = settingFor(selectedId.value)
  if (!s) return
  form.value = {
    name: s.name,
    segmentId: s.segmentId ?? '',
    siteName: s.siteName,
    siteUrl: s.siteUrl,
    analysisGoal: s.analysisGoal,
    targetAudience: s.targetAudience,
    defaultTone: s.defaultTone,
    keywords: s.keywords.join('、'),
  }
}
watch(selectedId, loadForm, { immediate: true })
// API モード: 設定行は遅延ロードで後から届く。行の実体が変わったらフォームへ反映する（SoT を優先）
watch(
  () => {
    const s = settingFor(selectedId.value)
    return s ? [s.name, s.segmentId ?? '', s.siteName, s.siteUrl, s.analysisGoal, s.targetAudience, s.defaultTone, s.keywords.join('、')].join('|') : ''
  },
  loadForm,
)

const connected = computed(() => settingFor(selectedId.value)?.gaConnected === true)
const linkedSegment = computed(() => {
  const sid = selectedChannel.value?.segmentId
  return sid ? segmentById(sid) : null
})

function splitKeywords(text: string): string[] {
  return text.split(/[,、]/).map(s => s.trim()).filter(s => s.length > 0)
}

const segmentOptions = computed(() => [
  { value: '', label: '連携しない（単体チャンネル）' },
  ...activeSegments.value.map(s => ({ value: s.id, label: `${s.name}（${INDUSTRY_TYPE_LABELS[s.industryType]}）` })),
])

const saving = ref(false)

async function saveForm(): Promise<void> {
  if (saving.value) return
  if (!form.value.name.trim()) { show('チャンネル名を入力してください', 'warn'); return }
  saving.value = true
  try {
    const res = await save(selectedId.value, {
      name: form.value.name.trim(),
      segmentId: form.value.segmentId || null,
      siteName: form.value.siteName.trim() || form.value.name.trim(),
      siteUrl: form.value.siteUrl.trim(),
      analysisGoal: form.value.analysisGoal,
      targetAudience: form.value.targetAudience.trim(),
      defaultTone: form.value.defaultTone,
      keywords: splitKeywords(form.value.keywords),
    })
    if (!res.ok) { show(`${res.error?.code}: ${res.error?.message}`, 'crit'); return }
    show('チャンネル設定を保存しました', 'ok')
  } finally { saving.value = false }
}

// ---------- チャンネル追加 ----------
const createOpen = ref(false)
const createForm = ref<{ name: string; segmentId: string }>({ name: '', segmentId: '' })
const creating = ref(false)
function openCreate(): void {
  createForm.value = { name: '', segmentId: '' }
  createOpen.value = true
}
async function submitCreate(): Promise<void> {
  if (creating.value) return
  if (!createForm.value.name.trim()) { show('チャンネル名を入力してください', 'warn'); return }
  creating.value = true
  try {
    const res = await createChannel({ name: createForm.value.name.trim(), segmentId: createForm.value.segmentId || null })
    if (!res.ok || !res.channel) { show(`${res.error?.code}: ${res.error?.message}`, 'crit'); return }
    createOpen.value = false
    selectedId.value = res.channel.id
    show('メディアチャンネルを作成しました', 'ok')
  } finally { creating.value = false }
}

// ---------- チャンネルの取消/復元 ----------
async function doArchiveChannel(): Promise<void> {
  const ch = selectedChannel.value
  if (!ch) return
  const ok = await confirm.ask('チャンネルの取消', `「${ch.name}」を取り消します（後で復元できます）。記事・設定・連携は残ります。`, { confirmLabel: '取り消す', danger: true })
  if (!ok) return
  const res = await archiveChannel(ch.id)
  if (!res.ok) { show(`${res.error?.code}: ${res.error?.message}`, 'crit'); return }
  show('チャンネルを取り消しました（復元できます）', 'warn')
  selectedId.value = activeChannels.value[0]?.id ?? ''
}
async function doRestoreChannel(id: string): Promise<void> {
  const res = await restoreChannel(id)
  if (!res.ok) { show(`${res.error?.code}: ${res.error?.message}`, 'crit'); return }
  show('チャンネルを復元しました', 'ok')
  selectedId.value = id
}

// ---------- 外部投稿記事 ----------
const showInactiveExt = ref(false)
const extList = computed(() => external.listFor(selectedId.value, showInactiveExt.value))
// 一覧のページング（1 ページ 20 件 = 改修依頼 2026-08-18。クライアントページング）
const { page: extPage, pageSize: extPageSize, rows: pagedExtList, total: extTotal } = useListView<MediaExternalArticle>({ source: extList })
watch([selectedId, showInactiveExt], () => { extPage.value = 1 })
const extOpen = ref(false)
const extSaving = ref(false)
const extEditId = ref<string | null>(null)
interface ExtForm { title: string; url: string; source: string; publishedAt: string; body: string; notes: string }
const extForm = ref<ExtForm>({ title: '', url: '', source: '', publishedAt: '', body: '', notes: '' })

function openExtAdd(): void {
  extEditId.value = null
  extForm.value = { title: '', url: '', source: '', publishedAt: '', body: '', notes: '' }
  extOpen.value = true
}
function openExtEdit(x: MediaExternalArticle): void {
  extEditId.value = x.id
  extForm.value = { title: x.title, url: x.url, source: x.source, publishedAt: x.publishedAt ?? '', body: x.body, notes: x.notes }
  extOpen.value = true
}
async function submitExt(): Promise<void> {
  if (extSaving.value) return
  extSaving.value = true
  try {
    const input = {
      title: extForm.value.title, url: extForm.value.url, source: extForm.value.source,
      publishedAt: extForm.value.publishedAt || null, body: extForm.value.body, notes: extForm.value.notes,
    }
    const res = extEditId.value
      ? await external.update(extEditId.value, input)
      : await external.add(selectedId.value, input)
    if (!res.ok) { show(`${res.error?.code}: ${res.error?.message}`, 'crit'); return }
    extOpen.value = false
    show(extEditId.value ? '外部投稿記事を更新しました' : '外部投稿記事を登録しました（AI インサイトの材料になります）', 'ok')
  } finally { extSaving.value = false }
}
async function archiveExt(id: string): Promise<void> {
  const ok = await confirm.ask('外部投稿記事の取消', 'この外部投稿記事を取り消します（後で復元できます）。', { confirmLabel: '取り消す' })
  if (!ok) return
  const res = await external.archive(id)
  if (!res.ok) { show(`${res.error?.code}: ${res.error?.message}`, 'warn'); return }
  show('外部投稿記事を取り消しました（復元できます）', 'warn')
}
async function restoreExt(id: string): Promise<void> {
  const res = await external.restore(id)
  if (!res.ok) { show(`${res.error?.code}: ${res.error?.message}`, 'warn'); return }
  show('外部投稿記事を復元しました', 'ok')
}
</script>

<template>
  <MastersMasterShell
    title="メディアチャンネル設定"
    description="メディアチャンネルごとに GA 連携・連携先業態（任意）・AI 分析設定・外部投稿記事を管理します。連携・設定は画面操作だけで完結します。"
  >
    <div class="grid gap-4">
      <!-- チャンネルセレクタ -->
      <UiSectionCard title="設定するチャンネル" description="メディア分析は独立したチャンネル単位。任意で業態と連携できます">
        <template #actions>
          <button type="button" class="btn btn-sm btn-primary" @click="openCreate">
            <Plus class="h-3.5 w-3.5" aria-hidden="true" /> チャンネルを追加
          </button>
        </template>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="c in activeChannels"
            :key="c.id"
            type="button"
            class="rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors"
            :class="c.id === selectedId ? 'border-brand bg-brand-soft text-brand' : 'border-line hover:border-muted'"
            :aria-pressed="c.id === selectedId"
            @click="selectedId = c.id"
          >
            {{ c.name }}<span class="ml-1 text-[10px] text-muted">{{ c.segmentId ? '連携' : '単体' }}</span>
          </button>
        </div>
        <UiEmptyState v-if="activeChannels.length === 0" icon="Radio" title="チャンネルがありません" hint="「チャンネルを追加」から作成してください" />
        <!-- 取消済みチャンネルの復元 -->
        <div v-if="archivedChannels.length > 0" class="mt-3 border-t border-line pt-2">
          <p class="label mb-1">取消済みチャンネル</p>
          <ul class="grid gap-1">
            <li v-for="c in archivedChannels" :key="c.id" class="flex items-center gap-2 text-[12px] text-muted">
              <span class="truncate">{{ c.name }}</span>
              <button type="button" class="link ml-auto text-[11px]" @click="doRestoreChannel(c.id)">復元</button>
            </li>
          </ul>
        </div>
      </UiSectionCard>

      <template v-if="selectedChannel">
        <!-- GA 連携 -->
        <UiSectionCard title="Google Analytics 連携" :description="`「${selectedChannel.name}」のアクセス解析データを取得します`">
          <MediaGaConnect :channel-id="selectedId" variant="gate" />
        </UiSectionCard>

        <!-- 基本設定・連携先・AI 分析設定 -->
        <UiSectionCard title="チャンネル設定" description="チャンネル名・連携先業態（任意）・サイト・AI 分析設定">
          <div class="grid gap-3">
            <div class="grid gap-3 sm:grid-cols-2">
              <UiFormField label="チャンネル名" hint="必須">
                <input v-model="form.name" type="text" class="input" placeholder="例）暮らしの器マガジン" aria-label="チャンネル名">
              </UiFormField>
              <UiFormField label="連携する Akebono 業務アプリ（業態）" hint="任意。連携すると売上との統合 PDCA が使えます">
                <UiSelect v-model="form.segmentId" :options="segmentOptions" aria-label="連携する業態" />
              </UiFormField>
            </div>
            <p v-if="linkedSegment" class="text-[11px] text-info">
              「{{ linkedSegment.name }}」と連携済み。業務 × メディア PDCA（売上 × 流入）が利用できます。
            </p>
            <p v-else class="text-[11px] text-muted">
              業態未連携（単体チャンネル）。分析・記事生成・単体 AI インサイトは利用できます。統合 PDCA は連携すると使えます。
            </p>
            <div class="grid gap-3 sm:grid-cols-2">
              <UiFormField label="サイト名">
                <input v-model="form.siteName" type="text" class="input" :placeholder="form.name" aria-label="サイト名">
              </UiFormField>
              <UiFormField label="サイト URL">
                <input v-model="form.siteUrl" type="url" class="input" placeholder="https://example.com" aria-label="サイト URL">
              </UiFormField>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <UiFormField label="分析の目的">
                <UiSelect v-model="form.analysisGoal" :options="MEDIA_GOAL_OPTIONS" aria-label="分析の目的" />
              </UiFormField>
              <UiFormField label="既定の記事トーン" hint="記事生成フォームの初期値になります">
                <UiSelect v-model="form.defaultTone" :options="ARTICLE_TONE_OPTIONS" aria-label="既定の記事トーン" />
              </UiFormField>
            </div>
            <UiFormField label="ターゲット読者" hint="記事生成・インサイトの前提">
              <input v-model="form.targetAudience" type="text" class="input" placeholder="例）手仕事の器に関心のある 30〜50 代" aria-label="ターゲット読者">
            </UiFormField>
            <UiFormField label="重点キーワード・テーマ" hint="カンマ・読点区切りで複数指定できます">
              <input v-model="form.keywords" type="text" class="input" placeholder="例）作家もの 器, 陶磁器 選び方" aria-label="重点キーワード">
            </UiFormField>
            <div class="flex items-center justify-between gap-2">
              <p class="text-[11px] text-muted">
                {{ connected ? 'GA 連携済み。分析・記事生成が利用できます' : 'GA 連携すると分析が利用できます（記事生成は連携なしでも可）' }}
              </p>
              <button type="button" class="btn btn-primary" :disabled="saving" @click="saveForm">{{ saving ? '保存中…' : '保存' }}</button>
            </div>
          </div>
        </UiSectionCard>

        <!-- 外部投稿記事（AI インサイトの材料） -->
        <UiSectionCard title="外部投稿記事" description="外部媒体・SNS へ投稿した記事の原文を保管します。メディア AI インサイトの生成材料になります" flush>
          <template #actions>
            <label class="flex items-center gap-1.5 text-[11px] text-sub">
              <input v-model="showInactiveExt" type="checkbox"> 取消済みも表示
            </label>
            <button type="button" class="btn btn-sm btn-primary" @click="openExtAdd">
              <Plus class="h-3.5 w-3.5" aria-hidden="true" /> 追加
            </button>
          </template>
          <UiEmptyState v-if="extList.length === 0" icon="FileText" title="外部投稿記事はまだありません" hint="外部媒体へ投稿した記事の原文を登録すると、AI インサイト生成の材料になります" />
          <ul v-else class="divide-y divide-line">
            <li v-for="x in pagedExtList" :key="x.id" class="flex flex-wrap items-center gap-2 px-3 py-2.5" :class="x.active === false ? 'opacity-60' : ''">
              <div class="min-w-0 flex-1">
                <p class="truncate text-[13px] font-bold">{{ x.title }}</p>
                <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                  <span v-if="x.source">{{ x.source }}</span>
                  <span v-if="x.publishedAt">{{ x.publishedAt }}</span>
                  <a v-if="x.url" :href="x.url" target="_blank" rel="noopener" class="link">投稿先</a>
                  <UiStatusBadge v-if="x.active === false" label="取消済み" tone="warn" />
                </div>
              </div>
              <div class="flex shrink-0 flex-wrap gap-1">
                <template v-if="x.active !== false">
                  <button type="button" class="btn btn-sm" @click="openExtEdit(x)">編集</button>
                  <button type="button" class="btn btn-sm" @click="archiveExt(x.id)">取消</button>
                </template>
                <button v-else type="button" class="btn btn-sm" @click="restoreExt(x.id)">復元</button>
              </div>
            </li>
          </ul>
          <UiPagination v-model:page="extPage" v-model:page-size="extPageSize" :total="extTotal" />
        </UiSectionCard>

        <!-- チャンネルの取消 -->
        <UiSectionCard title="チャンネルの取消" description="このチャンネルを一覧から取り消します（後で復元できます）">
          <button type="button" class="btn btn-danger btn-sm" @click="doArchiveChannel">このチャンネルを取り消す</button>
        </UiSectionCard>
      </template>
    </div>

    <!-- チャンネル追加モーダル -->
    <UiModal :open="createOpen" title="メディアチャンネルを追加" width="460px" @close="createOpen = false">
      <div class="grid gap-3">
        <UiFormField label="チャンネル名" hint="必須">
          <input v-model="createForm.name" type="text" class="input" placeholder="例）暮らしの器マガジン" aria-label="チャンネル名">
        </UiFormField>
        <UiFormField label="連携する Akebono 業務アプリ（業態）" hint="任意">
          <UiSelect v-model="createForm.segmentId" :options="segmentOptions" aria-label="連携する業態" />
        </UiFormField>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="createOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" :disabled="creating || !createForm.name.trim()" @click="submitCreate">
          {{ creating ? '作成中…' : '作成する' }}
        </button>
      </template>
    </UiModal>

    <!-- 外部投稿記事の追加・編集モーダル -->
    <UiModal :open="extOpen" :title="extEditId ? '外部投稿記事を編集' : '外部投稿記事を追加'" width="600px" @close="extOpen = false">
      <div class="grid gap-3">
        <UiFormField label="タイトル" hint="必須">
          <input v-model="extForm.title" type="text" class="input" placeholder="例）和食器の季節の楽しみ方" aria-label="タイトル">
        </UiFormField>
        <div class="grid gap-3 sm:grid-cols-2">
          <UiFormField label="媒体名" hint="任意">
            <input v-model="extForm.source" type="text" class="input" placeholder="例）暮らしメディア / note" aria-label="媒体名">
          </UiFormField>
          <UiFormField label="公開日" hint="任意">
            <input v-model="extForm.publishedAt" type="date" class="input" aria-label="公開日">
          </UiFormField>
        </div>
        <UiFormField label="投稿先 URL" hint="任意">
          <input v-model="extForm.url" type="url" class="input" placeholder="https://example.com/article" aria-label="投稿先 URL">
        </UiFormField>
        <UiFormField label="原文（本文）" hint="必須。AI 分析の材料になります">
          <textarea v-model="extForm.body" rows="8" class="input" placeholder="投稿した記事の本文を貼り付けます" aria-label="原文"></textarea>
        </UiFormField>
        <UiFormField label="メモ" hint="任意">
          <input v-model="extForm.notes" type="text" class="input" placeholder="例）反応が良かったので自社ブログへ再構成予定" aria-label="メモ">
        </UiFormField>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="extOpen = false">キャンセル</button>
        <button type="button" class="btn btn-primary" :disabled="extSaving || !extForm.title.trim() || !extForm.body.trim()" @click="submitExt">
          {{ extSaving ? '保存中…' : extEditId ? '更新' : '登録' }}
        </button>
      </template>
    </UiModal>
  </MastersMasterShell>
</template>
