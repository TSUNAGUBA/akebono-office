<script setup lang="ts">
/**
 * AI 記事生成スタジオ（F-40-3）。目的・記事の質・雰囲気を指定して記事を生成する。
 * 過去の分析結果（保管済みメディアインサイト）からお題を提案し、成果に近いテーマの記事も作れる。
 * 生成物はプレビューでき、サイトのコンテンツ資産へ「採用」して分析対象に加えられる。
 * 生成: モック = 決定的テンプレート合成 / API = Vertex AI → 失敗時は同じ決定的合成へサーバー側フォールバック
 * （llm フラグで「Vertex AI / 自動生成」を表示 = 週次インサイトと同じ流儀）。
 * 取消可能性（原則9.5）: 生成記事は取消（論理削除）・復元でき、採用も取り消せる。
 */
import { Lightbulb, PenLine, RotateCcw, Sparkles } from 'lucide-vue-next'
import { fmtDateTime } from '~/utils/format'
import {
  ARTICLE_PURPOSE_OPTIONS, ARTICLE_QUALITY_OPTIONS, ARTICLE_TONE_OPTIONS,
  MEDIA_SECTION_CHOICES, articlePurposeLabel, articleQualityLabel, articleToneLabel,
  type ArticlePurpose, type ArticleQuality, type ArticleTone,
} from '~/utils/media'
import type { GeneratedArticle } from '~/types/media'

const { effectiveChannelId, currentChannel } = useCurrentChannel()
const { settingFor } = useMediaChannels()
const articles = useMediaArticles()
const { show } = useToast()
const confirm = useConfirm()

const setting = computed(() => settingFor(effectiveChannelId.value))

interface Form {
  topic: string
  keyword: string
  purpose: ArticlePurpose
  quality: ArticleQuality
  tone: ArticleTone
  audience: string
  fromInsightId: string | null
}
const form = ref<Form>({
  topic: '', keyword: '', purpose: 'seo', quality: 'standard', tone: 'formal', audience: '', fromInsightId: null,
})

// preview は applyDefaults が参照するため、immediate な watch より前に宣言する
// （宣言前だと TDZ でページ全体が 500 になる実障害 = UnitI 検出 2026-08-20。PR #85 由来）
const preview = ref<GeneratedArticle | null>(null)

/** セグメント切替時にフォーム既定を設定から流し込む（未入力欄のみ・入力中は保持しない=リセット） */
function applyDefaults(): void {
  const s = setting.value
  form.value = {
    topic: '', keyword: s?.keywords[0] ?? '',
    purpose: s?.analysisGoal === 'conversion' ? 'conversion' : s?.analysisGoal === 'leadgen' ? 'leadgen' : 'seo',
    quality: 'standard',
    tone: (s?.defaultTone ?? 'formal') as ArticleTone,
    audience: s?.targetAudience ?? '',
    fromInsightId: null,
  }
  preview.value = null
}
watch(effectiveChannelId, applyDefaults, { immediate: true })

const generating = ref(false)
const adoptSection = ref<string>('ブログ')
const sectionOptions = MEDIA_SECTION_CHOICES.map(s => ({ value: s, label: s }))

const suggestion = computed(() => articles.suggestionFromInsight(effectiveChannelId.value))

/** 過去の分析からお題を提案（保管済みインサイトが必要） */
function applySuggestion(): void {
  const s = suggestion.value
  if (!s) {
    show('先にメディア分析の AI インサイトを生成してください', 'warn')
    return
  }
  form.value.topic = s.topic
  if (s.keyword) form.value.keyword = s.keyword
  form.value.purpose = s.purpose
  form.value.fromInsightId = s.fromInsightId
  show('過去の分析からお題を反映しました（生成すると分析の示唆を踏まえた記事になります）', 'ok')
}

async function doGenerate(): Promise<void> {
  if (generating.value) return
  generating.value = true
  try {
    // API モードは Vertex AI 生成（失敗時はサーバー側で決定的生成へフォールバック）
    const res = await articles.generate(effectiveChannelId.value, {
      topic: form.value.topic, keyword: form.value.keyword,
      purpose: form.value.purpose, quality: form.value.quality, tone: form.value.tone,
      audience: form.value.audience, fromInsightId: form.value.fromInsightId,
    })
    if (!res.ok || !res.article) { show(`${res.error?.code}: ${res.error?.message}`, 'crit'); return }
    preview.value = res.article
    show('記事を生成しました', 'ok')
  } finally { generating.value = false }
}

async function doAdopt(id: string): Promise<void> {
  const res = await articles.adopt(id, adoptSection.value)
  if (!res.ok) { show(`${res.error?.code}: ${res.error?.message}`, 'warn'); return }
  // 二重採用の no-op 等の警告は握りつぶさず通知する（原則4 の「報告」）
  if (res.warning) show(res.warning, 'warn')
  else show(`「${adoptSection.value}」に採用しました（分析の対象に加わります）`, 'ok')
  syncPreview(id)
}

async function doDiscard(id: string): Promise<void> {
  const ok = await confirm.ask('生成記事の取消', 'この生成記事を取り消します（後で復元できます）。', { confirmLabel: '取り消す' })
  if (!ok) return
  const res = await articles.remove(id)
  if (!res.ok) { show(`${res.error?.code}: ${res.error?.message}`, 'warn'); return }
  if (preview.value?.id === id) preview.value = null
  show('生成記事を取り消しました（復元できます）', 'warn')
}

/** プレビュー表示中の記事なら最新状態へ差し替える（採用バッジ等の反映） */
function syncPreview(id: string): void {
  if (preview.value?.id === id) {
    preview.value = articles.generatedFor(effectiveChannelId.value, true).find(g => g.id === id) ?? null
  }
}

async function doRestore(id: string): Promise<void> {
  const res = await articles.restore(id)
  if (!res.ok) { show(`${res.error?.code}: ${res.error?.message}`, 'warn'); return }
  syncPreview(id)
  show('生成記事を復元しました', 'ok')
}

async function doUnadopt(id: string): Promise<void> {
  const res = await articles.unadopt(id)
  if (!res.ok) { show(`${res.error?.code}: ${res.error?.message}`, 'warn'); return }
  syncPreview(id)
  show('採用を取り消しました', 'warn')
}

// ---------- 一覧 ----------
const showInactive = ref(false)
const list = computed(() => articles.generatedFor(effectiveChannelId.value, showInactive.value))
const detail = ref<GeneratedArticle | null>(null)

// 一覧のページング（1 ページ 20 件 = 改修依頼 2026-08-18。クライアントページング）
const { page, pageSize, rows: pagedList, total } = useListView<GeneratedArticle>({ source: list })
watch([effectiveChannelId, showInactive], () => { page.value = 1 })

function scoreTone(score: number): 'ok' | 'info' | 'warn' {
  return score >= 85 ? 'ok' : score >= 70 ? 'info' : 'warn'
}
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <UiPageHeader title="AI 記事生成スタジオ" :description="`${currentChannel?.name ?? ''} のメディア向けに、目的・質・雰囲気を指定して記事を生成します`" />

    <div class="grid gap-4">
      <MediaChannelBar />

      <!-- 生成フォーム -->
      <UiSectionCard title="記事を生成" description="目的・記事の質・雰囲気を指定します。過去の分析からお題を提案することもできます">
        <template #actions>
          <button type="button" class="btn btn-sm" :disabled="!suggestion" @click="applySuggestion">
            <Lightbulb class="h-3.5 w-3.5" aria-hidden="true" /> 分析からお題を提案
          </button>
        </template>

        <div class="grid gap-3">
          <div v-if="form.fromInsightId" class="flex items-center gap-2 rounded-lg border border-brand/40 bg-brand-soft px-3 py-1.5 text-[12px] text-brand">
            <Lightbulb class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            過去の分析結果を踏まえて生成します
            <button type="button" class="link ml-auto text-[11px]" @click="form.fromInsightId = null">解除</button>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <UiFormField label="お題（テーマ）" hint="空ならキーワードから補完します">
              <input v-model="form.topic" type="text" class="input" placeholder="例）作家ものの器の選び方" aria-label="お題">
            </UiFormField>
            <UiFormField label="重点キーワード">
              <input v-model="form.keyword" type="text" class="input" placeholder="例）陶磁器 選び方" aria-label="キーワード">
            </UiFormField>
          </div>

          <div class="grid gap-3 sm:grid-cols-3">
            <UiFormField label="目的">
              <UiSelect v-model="form.purpose" :options="ARTICLE_PURPOSE_OPTIONS" aria-label="目的" />
            </UiFormField>
            <UiFormField label="記事の質">
              <UiSelect v-model="form.quality" :options="ARTICLE_QUALITY_OPTIONS" aria-label="記事の質" />
            </UiFormField>
            <UiFormField label="雰囲気（トーン）">
              <UiSelect v-model="form.tone" :options="ARTICLE_TONE_OPTIONS" aria-label="雰囲気" />
            </UiFormField>
          </div>

          <UiFormField label="ターゲット読者" hint="メディア設定の既定を初期表示します">
            <input v-model="form.audience" type="text" class="input" placeholder="例）手仕事の器に関心のある 30〜50 代" aria-label="ターゲット読者">
          </UiFormField>

          <div class="flex justify-end">
            <button type="button" class="btn btn-primary" :disabled="generating" @click="doGenerate">
              <PenLine class="h-4 w-4" aria-hidden="true" /> {{ generating ? '生成中…' : '記事を生成' }}
            </button>
          </div>
        </div>
      </UiSectionCard>

      <!-- プレビュー -->
      <UiSectionCard v-if="preview" title="生成プレビュー" :description="`${articlePurposeLabel(preview.purpose)}・${articleQualityLabel(preview.quality)}・${articleToneLabel(preview.tone)}・${preview.llm ? 'Vertex AI' : '自動生成'}`">
        <template #actions>
          <UiStatusBadge :label="`品質スコア ${preview.qualityScore}`" :tone="scoreTone(preview.qualityScore)" />
        </template>
        <div class="grid gap-3">
          <div>
            <p class="text-[15px] font-bold">{{ preview.title }}</p>
            <p class="mt-1 text-[12px] text-sub">{{ preview.metaDescription }}</p>
            <div class="mt-1.5 flex flex-wrap gap-1">
              <span v-for="(k, i) in preview.suggestedKeywords" :key="i" class="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">{{ k }}</span>
            </div>
            <p class="mt-1 text-[11px] text-muted">推定 {{ preview.estWordCount }} 文字</p>
          </div>
          <div class="rounded-lg border border-line bg-surface-soft p-3">
            <UiMarkdown :source="preview.body" />
          </div>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <span class="text-[11px] text-muted">採用先セクション</span>
            <UiSelect v-model="adoptSection" :options="sectionOptions" aria-label="採用先セクション" />
            <button type="button" class="btn" @click="doDiscard(preview.id)">
              <RotateCcw class="h-3.5 w-3.5" aria-hidden="true" /> 取消
            </button>
            <button v-if="!preview.adoptedArticleId" type="button" class="btn btn-primary" @click="doAdopt(preview.id)">採用（サイトへ登録）</button>
            <UiStatusBadge v-else label="採用済み" tone="ok" />
          </div>
        </div>
      </UiSectionCard>

      <!-- 生成履歴 -->
      <UiSectionCard title="生成した記事" :description="`${currentChannel?.name ?? ''} の生成履歴`" flush>
        <template #actions>
          <label class="flex items-center gap-1.5 text-[11px] text-sub">
            <input v-model="showInactive" type="checkbox"> 取消済みも表示
          </label>
        </template>
        <UiEmptyState v-if="list.length === 0" icon="PenLine" title="まだ生成した記事はありません" hint="上のフォームから目的・質・雰囲気を指定して生成します" />
        <ul v-else class="divide-y divide-line">
          <li v-for="g in pagedList" :key="g.id" class="flex flex-wrap items-center gap-2 px-3 py-2.5" :class="g.active === false ? 'opacity-60' : ''">
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px] font-bold">{{ g.title }}</p>
              <div class="mt-0.5 flex flex-wrap items-center gap-1">
                <UiStatusBadge :label="articlePurposeLabel(g.purpose)" tone="info" />
                <UiStatusBadge :label="articleQualityLabel(g.quality)" tone="neutral" />
                <UiStatusBadge :label="articleToneLabel(g.tone)" tone="neutral" />
                <UiStatusBadge v-if="g.adoptedArticleId" label="採用済み" tone="ok" />
                <UiStatusBadge v-if="g.active === false" label="取消済み" tone="warn" />
                <span class="text-[10px] text-muted">{{ fmtDateTime(g.createdAt) }}</span>
              </div>
            </div>
            <div class="flex shrink-0 flex-wrap gap-1">
              <button type="button" class="btn btn-sm" @click="detail = g">プレビュー</button>
              <template v-if="g.active !== false">
                <button v-if="!g.adoptedArticleId" type="button" class="btn btn-sm btn-primary" @click="doAdopt(g.id)">採用</button>
                <button v-else type="button" class="btn btn-sm" @click="doUnadopt(g.id)">採用取消</button>
                <button type="button" class="btn btn-sm" @click="doDiscard(g.id)">取消</button>
              </template>
              <button v-else type="button" class="btn btn-sm" @click="doRestore(g.id)">復元</button>
            </div>
          </li>
        </ul>
        <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="total" />
      </UiSectionCard>
    </div>

    <!-- プレビュー詳細モーダル -->
    <UiModal :open="!!detail" :title="detail?.title ?? ''" width="640px" @close="detail = null">
      <div v-if="detail" class="grid gap-3">
        <p class="text-[12px] text-sub">{{ detail.metaDescription }}</p>
        <div class="rounded-lg border border-line bg-surface-soft p-3">
          <UiMarkdown :source="detail.body" />
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn" @click="detail = null">閉じる</button>
      </template>
    </UiModal>
  </div>
</template>
