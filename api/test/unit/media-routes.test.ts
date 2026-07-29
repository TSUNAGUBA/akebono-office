/**
 * メディアルートの純粋関数（routes/media.ts エクスポート）の単体テスト。
 * - settingsPatchOf: 部分更新は「body に実在するキーのみ」（Object.hasOwn。CLAUDE.md の Zod v4 注意への回帰テスト =
 *   送っていないフィールドが更新対象に**含まれない**ことをアサートする）
 * - normalize*: LLM 出力の欠落・型崩れの防御（null = ヒューリスティックへフォールバック）
 * - 旧 normalizeIntegratedMetrics / applyServerMediaAxis（M2 = クライアント合成の受領検証）は
 *   Phase C のサーバー組み立て化（buildIntegratedMetrics）で撤去 = テストも削除
 *   （組み立ての検証は shared/domain の akebono-integrated.test + 統合テストが担う）
 * - insightHintsOf: 保管済みインサイトからのヒント抽出（mockup hintsFromInsight と同一挙動）
 */
import { describe, expect, it } from 'vitest'
import {
  gaErrorDetailOf, gaFailReasonOf, insightHintsOf, normalizeArticleDraft,
  normalizeIntegratedInsight, normalizeMediaInsight, settingsPatchOf, shouldFanOut,
} from '../../src/routes/media'
import type { ArticleGenInput } from '../../../shared/domain/media-article'
import { heuristicIntegratedInsight, type IntegratedMetrics } from '../../../shared/domain/media-integrated'

describe('settingsPatchOf（部分更新のキーフィルタ）', () => {
  it('body に実在するキーのみを返す = 送っていないフィールドは更新対象に含まれない', () => {
    const patch = settingsPatchOf({ siteName: '新サイト名' })
    expect(patch).toEqual({ siteName: '新サイト名' })
    // 未送信フィールドがキーとして存在しないこと（既定値の注入がない = Zod .partial() 事故の防止）
    expect(Object.hasOwn(patch, 'siteUrl')).toBe(false)
    expect(Object.hasOwn(patch, 'analysisGoal')).toBe(false)
    expect(Object.hasOwn(patch, 'keywords')).toBe(false)
    expect(Object.hasOwn(patch, 'active')).toBe(false)
  })

  it('空文字への更新は「明示的な空」として通す（キー存在ベースの判定）', () => {
    expect(settingsPatchOf({ targetAudience: '' })).toEqual({ targetAudience: '' })
  })

  it('keywords は文字列配列へ正規化（空要素除去・件数上限）', () => {
    const patch = settingsPatchOf({ keywords: [' 器 ', '', 42, '選び方'] })
    expect(patch.keywords).toEqual(['器', '42', '選び方'])
  })

  it('不正な analysisGoal / defaultTone / keywords 型は AKO-GEN-001', () => {
    expect(() => settingsPatchOf({ analysisGoal: 'hack' })).toThrowError(/analysisGoal/)
    expect(() => settingsPatchOf({ defaultTone: 'aggressive' })).toThrowError(/defaultTone/)
    expect(() => settingsPatchOf({ keywords: 'not-array' })).toThrowError(/keywords/)
  })

  it('有効な区分値は通る', () => {
    expect(settingsPatchOf({ analysisGoal: 'leadgen', defaultTone: 'expert' }))
      .toEqual({ analysisGoal: 'leadgen', defaultTone: 'expert' })
  })
})

describe('insightHintsOf（保管済みインサイトからのヒント抽出）', () => {
  const insight = {
    executiveSummary: 'サマリー',
    siteStructure: [
      { kind: 'win', title: '構成は良好', detail: '' },
      { kind: 'opportunity', title: 'サービスの CVR が高い', detail: '' },
    ],
    articles: [
      { kind: 'issue', title: '下降記事あり', detail: '' },
      { kind: 'opportunity', title: '伸びしろ記事', detail: '' },
    ],
  }

  it('opportunity / issue の title を articles → siteStructure の順で最大 3 件', () => {
    expect(insightHintsOf(insight)).toEqual(['下降記事あり', '伸びしろ記事', 'サービスの CVR が高い'])
  })

  it('型崩れ・欠落は空配列（クラッシュしない）', () => {
    expect(insightHintsOf(null)).toEqual([])
    expect(insightHintsOf({})).toEqual([])
    expect(insightHintsOf({ articles: 'broken' })).toEqual([])
  })
})

describe('normalizeMediaInsight（LLM 出力の防御）', () => {
  it('executiveSummary 欠落は null（ヒューリスティックへフォールバック）', () => {
    expect(normalizeMediaInsight(null)).toBeNull()
    expect(normalizeMediaInsight({})).toBeNull()
    expect(normalizeMediaInsight({ executiveSummary: '  ' })).toBeNull()
  })

  it('kind / priority の不正値は既定値へ丸める', () => {
    const res = normalizeMediaInsight({
      executiveSummary: '要約',
      siteStructure: [{ kind: 'invalid', title: 'T1', detail: 'D1' }],
      articles: [{ kind: 'win', title: 'T2', detail: 'D2' }],
      actions: [{ title: 'A1', detail: 'AD1', priority: 'urgent' }],
    })!
    expect(res.siteStructure[0]!.kind).toBe('opportunity')
    expect(res.articles[0]!.kind).toBe('win')
    expect(res.actions[0]!.priority).toBe('mid')
  })

  it('title 空の項目は除外・配列でない場合は空配列', () => {
    const res = normalizeMediaInsight({
      executiveSummary: '要約',
      siteStructure: [{ kind: 'win', title: '', detail: 'x' }],
      articles: 'broken',
      actions: null,
    })!
    expect(res.siteStructure).toEqual([])
    expect(res.articles).toEqual([])
    expect(res.actions).toEqual([])
  })
})

describe('normalizeIntegratedInsight（LLM 出力の防御）', () => {
  it('pdca の欠落象限は空配列・severity 不正は mid', () => {
    const res = normalizeIntegratedInsight({
      executiveSummary: '統合要約',
      correlation: ['相関あり'],
      pdca: { plan: ['P'] },
      actions: [],
      risks: [{ title: 'R', severity: 'critical', mitigation: 'M' }],
    })!
    expect(res.pdca.plan).toEqual(['P'])
    expect(res.pdca.do).toEqual([])
    expect(res.pdca.check).toEqual([])
    expect(res.risks[0]!.severity).toBe('mid')
  })

  it('executiveSummary 欠落は null', () => {
    expect(normalizeIntegratedInsight({ pdca: {} })).toBeNull()
  })
})

describe('normalizeArticleDraft（LLM 出力の防御）', () => {
  const input: ArticleGenInput = {
    topic: 'テスト', keyword: 'kw', purpose: 'seo', quality: 'standard', tone: 'formal',
    audience: '読者', siteName: 'サイト', segmentName: 'セグメント',
  }

  it('title / body 欠落は null（決定的生成へフォールバック）', () => {
    expect(normalizeArticleDraft(null, input)).toBeNull()
    expect(normalizeArticleDraft({ title: 'T' }, input)).toBeNull()
    expect(normalizeArticleDraft({ body: 'B' }, input)).toBeNull()
  })

  it('purpose/quality/tone/qualityScore は入力から決定的に付与（LLM の自己申告に依存しない）', () => {
    const res = normalizeArticleDraft({
      title: 'タイトル', body: '# 本文', metaDescription: 'meta',
      outline: [{ heading: '見出し', points: ['要点'] }],
      suggestedKeywords: ['kw', ''],
      estWordCount: 1800.4,
      purpose: 'branding', quality: 'premium', tone: 'casual', qualityScore: 999,
    }, input)!
    expect(res.purpose).toBe('seo')
    expect(res.quality).toBe('standard')
    expect(res.tone).toBe('formal')
    expect(res.qualityScore).toBeLessThanOrEqual(100)
    expect(res.estWordCount).toBe(1800)
    expect(res.suggestedKeywords).toEqual(['kw'])
  })

  it('estWordCount 不正時は本文長で補完・outline の型崩れは除外', () => {
    const res = normalizeArticleDraft({
      title: 'T', body: 'あいうえお', estWordCount: 'many',
      outline: [{ heading: '', points: [] }, 'broken', { heading: 'H', points: 'x' }],
    }, input)!
    expect(res.estWordCount).toBe(5)
    expect(res.outline).toEqual([{ heading: 'H', points: [] }])
  })
})

describe('gaErrorDetailOf（GA 実エラー理由の抽出 = 本番障害 2026-07-29 の画面診断対策）', () => {
  it('GA の JSON エラーボディからは error.message を抽出する', () => {
    const body = JSON.stringify({
      error: { code: 400, message: 'Please remove entrances to make the request compatible.', status: 'INVALID_ARGUMENT' },
    })
    expect(gaErrorDetailOf(body)).toBe('Please remove entrances to make the request compatible.')
  })

  it('JSON でないボディ（HTML エラーページ等）は空白正規化した先頭を使う', () => {
    expect(gaErrorDetailOf('<html>\n  <body>Quota\n exceeded</body></html>'))
      .toBe('<html> <body>Quota exceeded</body></html>')
  })

  it('150 コードポイントで切り詰める（warning の肥大防止）', () => {
    const long = JSON.stringify({ error: { message: 'x'.repeat(500) } })
    expect([...gaErrorDetailOf(long)].length).toBe(150)
  })

  it('壊れた入力でもクラッシュしない', () => {
    expect(gaErrorDetailOf('')).toBe('')
    expect(gaErrorDetailOf('{"error":{}}')).toBe('{"error":{}}')
  })
})

describe('gaFailReasonOf / shouldFanOut（P2: クォータ・確定的失敗ではファンアウトしない）', () => {
  it('429 / RESOURCE_EXHAUSTED / Quota exceeded は quota', () => {
    expect(gaFailReasonOf(429, '')).toBe('quota')
    expect(gaFailReasonOf(403, '{"error":{"status":"RESOURCE_EXHAUSTED"}}')).toBe('quota')
    expect(gaFailReasonOf(500, 'Quota exceeded for property')).toBe('quota')
  })

  it('403 は理由コードで api-disabled / permission を分類', () => {
    expect(gaFailReasonOf(403, 'accessNotConfigured')).toBe('api-disabled')
    expect(gaFailReasonOf(403, 'PERMISSION_DENIED')).toBe('permission')
  })

  it('タイムアウト・5xx・その他 400 は other = per-report で切り分け可能', () => {
    expect(gaFailReasonOf(0, 'The operation was aborted due to timeout')).toBe('other')
    expect(gaFailReasonOf(500, 'Internal error')).toBe('other')
    expect(gaFailReasonOf(400, 'Please remove entrances to make the request compatible.')).toBe('other')
  })

  it('shouldFanOut は other のみ true（quota / api-disabled / permission では追い打ちしない）', () => {
    expect(shouldFanOut('other')).toBe(true)
    expect(shouldFanOut('quota')).toBe(false)
    expect(shouldFanOut('api-disabled')).toBe(false)
    expect(shouldFanOut('permission')).toBe(false)
  })
})
