/**
 * 改善要望（F-42）の権限ゲートと集約・プロンプトの純ロジック。
 * canManageImprovements = deny-by-default（管理者は常時可・明示 allow で付与）。
 */
import { describe, expect, it } from 'vitest'
import { canManageImprovements, type PermissionSubject } from '../../shared/domain/permissions'
import type { PermissionRule } from '../../shared/domain/types'
import {
  buildCodingPrompt, buildUnclusterNoteBody, canTransition, clusterTargetRequests, heuristicClusterRequests,
  IMPROVEMENT_REQUEST_ADOPTION_META, IMPROVEMENT_REQUEST_TAG_META, IMPROVEMENT_STATUS_META,
  improvementCommentError, improvementImagesError, improvementLinksError,
  matchesImprovementFilter, normalizeImprovementLinks, normalizeImprovementTags, planAdoptionBulk, PROMPT_NAVIGATOR_PREAMBLE, requestAdoptionOf,
  improvementAdoptionError,
  improvementEditError,
  improvementUnclusterError,
} from '../../shared/domain/improvement'
import { fmtDateTimeSec } from '~/utils/format'

function rule(p: Partial<PermissionRule>): PermissionRule {
  return {
    id: p.id ?? 'r', subjectKind: p.subjectKind ?? 'role', subjectId: p.subjectId ?? 'member',
    resource: p.resource ?? 'improvements', field: p.field ?? null, effect: p.effect ?? 'allow',
    active: p.active ?? true,
  }
}
const admin: PermissionSubject = { memberId: 'm-admin', title: '', role: 'admin' }
const member: PermissionSubject = { memberId: 'm-1', title: '主任', role: 'member' }

describe('canManageImprovements（deny-by-default）', () => {
  it('管理者は常時可（ルール無しでも）', () => {
    expect(canManageImprovements([], admin)).toBe(true)
  })
  it('一般は既定で不可（ルール無し = deny）', () => {
    expect(canManageImprovements([], member)).toBe(false)
  })
  it('個人 allow を付与すると閲覧可（明示許可）', () => {
    const rules = [rule({ subjectKind: 'member', subjectId: 'm-1', resource: 'improvements', effect: 'allow' })]
    expect(canManageImprovements(rules, member)).toBe(true)
  })
  it('役職 allow でも付与できる', () => {
    const rules = [rule({ subjectKind: 'title', subjectId: '主任', resource: 'improvements', effect: 'allow' })]
    expect(canManageImprovements(rules, member)).toBe(true)
  })
  it('無関係リソースの allow では付与されない', () => {
    const rules = [rule({ subjectKind: 'member', subjectId: 'm-1', resource: 'sales', effect: 'allow' })]
    expect(canManageImprovements(rules, member)).toBe(false)
  })
})

describe('集約・ステータス・プロンプト（純ロジック）', () => {
  it('未判定 item へ追記し、新規ページは作成する', () => {
    const plan = heuristicClusterRequests(
      [{ id: 'i1', status: 'triage', pagePaths: ['/a'] }],
      [
        { id: 'r1', pagePath: '/a', pageLabel: 'A', body: 'x' },
        { id: 'r2', pagePath: '/b', pageLabel: 'B', body: 'y' },
      ],
    )
    expect(plan.appends).toEqual([{ itemId: 'i1', requestIds: ['r1'] }])
    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0]!.requestIds).toEqual(['r2'])
  })
  it('解決済み → 対応する（reopen）ができる（取消可能性）', () => {
    expect(canTransition('resolved', 'accepted')).toBe(true)
    expect(canTransition('resolved', 'triage')).toBe(false)
  })
  it('open フィルターは未解決（triage/accepted）のみ', () => {
    expect(matchesImprovementFilter('triage', 'open')).toBe(true)
    expect(matchesImprovementFilter('resolved', 'open')).toBe(false)
  })
  it('ガント既定フィルタ（committed = 実装が決まっていて未完了 = 対応する + 対応中。2026-08-18）', () => {
    // ImprovementsGantt は既定 statusFilter='committed' でこの判定を使う（実装決定・未完了だけを初期表示。
    // 対応中の追加で accepted 単独から拡張 = 着手した案件がガントから消えない）
    expect(matchesImprovementFilter('accepted', 'committed')).toBe(true)
    expect(matchesImprovementFilter('in_progress', 'committed')).toBe(true)
    expect(matchesImprovementFilter('triage', 'committed')).toBe(false)
    expect(matchesImprovementFilter('resolved', 'committed')).toBe(false)
    expect(matchesImprovementFilter('rejected', 'committed')).toBe(false)
  })
  it('対応中（in_progress）の遷移と表示メタ（改修依頼 2026-08-18）', () => {
    expect(canTransition('accepted', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'resolved')).toBe(true)
    expect(canTransition('in_progress', 'accepted')).toBe(true) // 着手の取消 = 原則9.5
    expect(canTransition('triage', 'in_progress')).toBe(false)
    expect(IMPROVEMENT_STATUS_META.in_progress.label).toBe('対応中')
    expect(IMPROVEMENT_STATUS_META.in_progress.open).toBe(true)
  })
  it('ステータスメタの tone は UI Tone と対応（neutral/info/ok/warn）', () => {
    expect(IMPROVEMENT_STATUS_META.triage.tone).toBe('neutral')
    expect(IMPROVEMENT_STATUS_META.resolved.tone).toBe('ok')
  })
  it('プロンプトに対象パスと元要望が含まれる', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'accepted', pagePaths: ['/a'],
      requests: [{ pageLabel: 'A', pagePath: '/a', body: '直したい' }],
    }])
    expect(prompt).toContain('/a')
    expect(prompt).toContain('直したい')
  })
  it('プロンプト冒頭にナビゲーター定型文が必ず入る（改修依頼 2026-08-18）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'accepted', pagePaths: ['/a'], requests: [],
    }])
    expect(prompt.startsWith(PROMPT_NAVIGATOR_PREAMBLE)).toBe(true)
    expect(prompt).toContain('あなたはナビゲーターです。')
    expect(prompt).toContain('改修後は指摘事項がなくなるまでコードレビューとシステム監査を繰り返してください。')
    // 定型文の後に区切りと従来の見出しが続く（冒頭 = 見出しより前）
    expect(prompt.indexOf('あなたはナビゲーターです。')).toBeLessThan(prompt.indexOf('# 改善要望に基づく改修依頼'))
  })
  it('要望の添付（参考リンク・画像件数）がプロンプトに加味される（2026-08-17）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'accepted', pagePaths: ['/a'],
      requests: [{ pageLabel: 'A', pagePath: '/a', body: '直したい', links: ['https://ref.example'], imageCount: 1 }],
    }])
    expect(prompt).toContain('参考リンク: https://ref.example')
    expect(prompt).toContain('添付画像 1 件')
  })
})

describe('生要望の選別（requestAdoptionOf。2026-08-17 第 2 弾）', () => {
  it('adoption 未定義の旧データは集約済み = adopted / 未集約 = pending に補完（下位互換）', () => {
    expect(requestAdoptionOf({ itemId: 'imp-1' })).toBe('adopted')
    expect(requestAdoptionOf({ itemId: null })).toBe('pending')
    expect(requestAdoptionOf({ adoption: 'declined', itemId: null })).toBe('declined')
  })
  it('選別メタのラベル（未選別/採用/不採用）と tone', () => {
    expect(IMPROVEMENT_REQUEST_ADOPTION_META.pending.label).toBe('未選別')
    expect(IMPROVEMENT_REQUEST_ADOPTION_META.adopted.tone).toBe('ok')
    expect(IMPROVEMENT_REQUEST_ADOPTION_META.declined.tone).toBe('warn')
  })
  it('コメント本文の検証（空・上限）', () => {
    expect(improvementCommentError(' ')).not.toBeNull()
    expect(improvementCommentError('確認: 対象は部署セレクトの想定で良いですか？')).toBeNull()
  })
  it('mock の集約対象 = clusterTargetRequests（未集約・有効・採用のみ。未選別/不採用/取消済みは集約されない）', () => {
    // useImprovements.mockGenerate はこの共有関数で対象を選ぶ（API generate の SQL 条件と同一 = 原則6）
    expect(clusterTargetRequests([
      { id: 'a', itemId: null, archivedAt: null, adoption: 'adopted' as const },
      { id: 'b', itemId: null, archivedAt: null, adoption: 'pending' as const },
      { id: 'c', itemId: null, archivedAt: null, adoption: 'declined' as const },
      { id: 'd', itemId: 'imp-1', archivedAt: null, adoption: 'adopted' as const },
      { id: 'e', itemId: null, archivedAt: '2026-08-17T00:00:00+09:00', adoption: 'adopted' as const },
    ]).map(r => r.id)).toEqual(['a'])
  })
})

describe('添付の検証（投稿フォーム = ImprovementSubmit / useImprovements.submit と共有）', () => {
  it('リンクは http(s) のみ・正規化で空/重複を除く', () => {
    expect(normalizeImprovementLinks([' https://a.example ', '', ' https://a.example'])).toEqual(['https://a.example'])
    expect(improvementLinksError(['https://a.example'])).toBeNull()
    expect(improvementLinksError(['example.com'])).not.toBeNull()
  })
  it('画像は data:image の allowlist（PNG/JPEG/WebP/GIF）のみ', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    expect(improvementImagesError([{ filename: 'a.png', mime: 'image/png', dataUrl: png }])).toBeNull()
    expect(improvementImagesError([{ filename: 'a.svg', mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }])).not.toBeNull()
  })
})

describe('要望タグ（壁打ち/お任せ = F-42-17・改修依頼 2026-08-18）', () => {
  it('normalizeImprovementTags は既知タグのみ・重複除去（未知値・非配列は落とす）', () => {
    expect(normalizeImprovementTags(['brainstorm', 'entrust'])).toEqual(['brainstorm', 'entrust'])
    expect(normalizeImprovementTags(['entrust', 'entrust', 'bogus', 1, null])).toEqual(['entrust'])
    expect(normalizeImprovementTags('entrust')).toEqual([])
    expect(normalizeImprovementTags(undefined)).toEqual([])
  })
  it('タグメタは 壁打ち/お任せ のラベルと説明を持つ（ラベル SoT）', () => {
    expect(IMPROVEMENT_REQUEST_TAG_META.brainstorm.label).toBe('壁打ち')
    expect(IMPROVEMENT_REQUEST_TAG_META.entrust.label).toBe('お任せ')
    expect(IMPROVEMENT_REQUEST_TAG_META.entrust.description).toContain('開発側の解釈')
  })
  it('buildCodingPrompt はタグを〔壁打ち〕〔お任せ〕で明記し、読み方の注記を添える', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'accepted', pagePaths: ['/x'],
      requests: [
        { pageLabel: 'X', pagePath: '/x', body: '直したい A', tags: ['entrust'] },
        { pageLabel: 'X', pagePath: '/x', body: '直したい B', tags: ['brainstorm', 'entrust'] },
      ],
    }])
    expect(prompt).toContain('〔お任せ〕 直したい A')
    expect(prompt).toContain('〔壁打ち〕〔お任せ〕 直したい B')
    expect(prompt).toContain('開発側の解釈で進めてよい')
  })
  it('タグ無しの要望はプロンプト出力が従来と同一（下位互換 = 原則7）', () => {
    const prompt = buildCodingPrompt([{
      title: 't', summary: 's', detail: 'd', status: 'accepted', pagePaths: ['/x'],
      requests: [{ pageLabel: 'X', pagePath: '/x', body: '直したい' }],
    }])
    expect(prompt).not.toContain('〔')
    expect(prompt).not.toContain('お任せ')
  })
})

describe('fmtDateTimeSec（受付箱のタイムスタンプ = yyyy/MM/dd HH:mm:ss。改修依頼 2026-08-18）', () => {
  it('JST ISO 文字列を秒までゼロ埋めで表示する（TZ 変換しない = 壁時計のまま）', () => {
    expect(fmtDateTimeSec('2026-08-17T09:05:03+09:00')).toBe('2026/08/17 09:05:03')
    expect(fmtDateTimeSec('2026-01-02T23:59:59+09:00')).toBe('2026/01/02 23:59:59')
  })
  it('形式外・時刻の無い文字列はそのまま返す（他フォーマッタと同じフォールバック）', () => {
    expect(fmtDateTimeSec('2026-08-17')).toBe('2026-08-17')
    expect(fmtDateTimeSec('不明')).toBe('不明')
  })
})

describe('improvementEditError（要望本文の編集可否。F-42-16・2026-08-18。API ルートと同一の判定順）', () => {
  const active = { memberId: 'm-a', archivedAt: null }
  const archived = { memberId: 'm-a', archivedAt: '2026-08-18T10:00:00+09:00' }

  it('本人は編集できる（null = 許可）', () => {
    expect(improvementEditError(active, 'm-a', false)).toBeNull()
  })

  it('管理権限者は他人の要望も編集できる', () => {
    expect(improvementEditError(active, 'm-b', true)).toBeNull()
  })

  it('本人でも管理権限者でもない第三者は AKO-PRM-001', () => {
    expect(improvementEditError(active, 'm-b', false)?.code).toBe('AKO-PRM-001')
  })

  it('存在しない要望は AKO-REQ-002', () => {
    expect(improvementEditError(undefined, 'm-a', true)?.code).toBe('AKO-REQ-002')
  })

  it('取消済みは本人・管理権限者でも AKO-REQ-015（先に復元）', () => {
    expect(improvementEditError(archived, 'm-a', false)?.code).toBe('AKO-REQ-015')
    expect(improvementEditError(archived, 'm-b', true)?.code).toBe('AKO-REQ-015')
  })

  it('判定順 = 存在 → 権限 → 取消済み（権限の無い第三者へ取消状態を漏らさない）', () => {
    expect(improvementEditError(archived, 'm-b', false)?.code).toBe('AKO-PRM-001')
  })
})

describe('improvementUnclusterError（集約解除の可否。F-42-19・追加指示 2026-08-18。API ルートと同一判定）', () => {
  it('集約済み・有効な要望は解除できる（null = 許可）', () => {
    expect(improvementUnclusterError({ itemId: 'imp-1', archivedAt: null })).toBeNull()
  })
  it('存在しない要望は AKO-REQ-002', () => {
    expect(improvementUnclusterError(undefined)?.code).toBe('AKO-REQ-002')
  })
  it('未集約の要望は AKO-REQ-017（解除は不要）', () => {
    expect(improvementUnclusterError({ itemId: null, archivedAt: null })?.code).toBe('AKO-REQ-017')
  })
  it('取消済みの要望は AKO-REQ-018（先に復元）。判定順 = 存在 → 未集約 → 取消済み', () => {
    expect(improvementUnclusterError({ itemId: 'imp-1', archivedAt: '2026-08-18T10:00:00+09:00' })?.code).toBe('AKO-REQ-018')
    expect(improvementUnclusterError({ itemId: null, archivedAt: '2026-08-18T10:00:00+09:00' })?.code).toBe('AKO-REQ-017')
  })
  it('決着済み（解決済み/対応しない）item の元要望は AKO-REQ-021（先に reopen = 記録保護。R18）', () => {
    const active = { itemId: 'imp-1', archivedAt: null }
    expect(improvementUnclusterError(active, { status: 'resolved' })?.code).toBe('AKO-REQ-021')
    expect(improvementUnclusterError(active, { status: 'rejected' })?.code).toBe('AKO-REQ-021')
    // 未決着（未判定・対応する）は従来どおり解除できる。item 省略（旧呼び出し）も許可 = 下位互換
    expect(improvementUnclusterError(active, { status: 'triage' })).toBeNull()
    expect(improvementUnclusterError(active, { status: 'accepted' })).toBeNull()
    expect(improvementUnclusterError(active)).toBeNull()
  })
  it('取消済み item の元要望は AKO-REQ-022（先に item を復元 = 論理削除中のトレースを書き換えない。R24）', () => {
    const active = { itemId: 'imp-1', archivedAt: null }
    expect(improvementUnclusterError(active, { status: 'triage', archivedAt: '2026-08-18T10:00:00+09:00' })?.code).toBe('AKO-REQ-022')
    // 取消済み + 決着済みは復元が先（022 が優先）
    expect(improvementUnclusterError(active, { status: 'resolved', archivedAt: '2026-08-18T10:00:00+09:00' })?.code).toBe('AKO-REQ-022')
  })
  it('解除後の要望は clusterTargetRequests の対象になる（adoption=adopted へ戻す前提の確認）', () => {
    // unclusterRequest は itemId=null + adoption='adopted' へ更新する（mock/API 共通）。
    // その結果行が共有の集約対象判定を満たすことを固定する（再度 AI 集約の対象 = 要望の受入条件）
    expect(clusterTargetRequests([{ id: 'a', itemId: null, archivedAt: null, adoption: 'adopted' as const }])
      .map(r => r.id)).toEqual(['a'])
  })
  it('解除履歴（excludeItemIds）の item へは再追記せず新規作成する（同じ単位への往復 + detail 重複防止）', () => {
    const open = [{ id: 'i1', status: 'triage' as const, pagePaths: ['/a'] }]
    // 除外なし = 従来どおり追記
    expect(heuristicClusterRequests(open, [{ id: 'r1', pagePath: '/a', pageLabel: 'A', body: 'x' }]).appends)
      .toEqual([{ itemId: 'i1', requestIds: ['r1'] }])
    // 除外あり（i1 から解除された要望）= i1 へは戻さず新規作成
    const plan = heuristicClusterRequests(open, [{ id: 'r1', pagePath: '/a', pageLabel: 'A', body: 'x', excludeItemIds: ['i1'] }])
    expect(plan.appends).toHaveLength(0)
    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0]!.requestIds).toEqual(['r1'])
  })
  it('除外は要望単位（同じページの除外なし要望は従来どおり追記 = 巻き添えで新規 item を作らない。レビュー R2）', () => {
    const open = [{ id: 'i1', status: 'triage' as const, pagePaths: ['/a'] }]
    const plan = heuristicClusterRequests(open, [
      { id: 'r1', pagePath: '/a', pageLabel: 'A', body: 'x', excludeItemIds: ['i1'] }, // 解除された要望
      { id: 'r2', pagePath: '/a', pageLabel: 'A', body: 'y' }, // 新規要望（除外なし）
    ])
    expect(plan.appends).toEqual([{ itemId: 'i1', requestIds: ['r2'] }]) // r2 は i1 へ
    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0]!.requestIds).toEqual(['r1']) // r1 だけ新規
  })
  it('除外された要望も別の triage item が同ページを対象にしていればそこへ追記する', () => {
    const open = [
      { id: 'i1', status: 'triage' as const, pagePaths: ['/a'] },
      { id: 'i2', status: 'triage' as const, pagePaths: ['/a'] },
    ]
    const plan = heuristicClusterRequests(open, [{ id: 'r1', pagePath: '/a', pageLabel: 'A', body: 'x', excludeItemIds: ['i1'] }])
    expect(plan.appends).toEqual([{ itemId: 'i2', requestIds: ['r1'] }])
    expect(plan.creates).toHaveLength(0)
  })
  it('buildUnclusterNoteBody = 元 item へ残す修正メモ（本文の先頭を引用・改行は潰す・「含めないこと」を明記）', () => {
    const note = buildUnclusterNoteBody('タイムカードの\n打刻を取り消せるようにしてほしい')
    expect(note).toContain('【集約の解除】')
    expect(note).toContain('タイムカードの 打刻を取り消せるように')
    expect(note).toContain('実装対象に含めないこと')
    // 長文は 60 字で切って省略記号を付ける
    const long = buildUnclusterNoteBody('あ'.repeat(100))
    expect(long).toContain(`「${'あ'.repeat(60)}…」`)
  })
})

describe('planAdoptionBulk / improvementAdoptionError（受付箱の選別ガードと一括仕分け。F-42-18・2026-08-18）', () => {
  const rows = [
    { id: 'a', itemId: null, archivedAt: null },
    { id: 'b', itemId: null, archivedAt: null },
    { id: 'c', itemId: 'imp-1', archivedAt: null }, // 集約済み = 対象外
    { id: 'd', itemId: null, archivedAt: '2026-08-18T00:00:00+09:00' }, // 取消済み = 対象外
  ]
  it('improvementAdoptionError の判定順 = 存在 → 取消済み → 集約済み（mock・API・一括仕分けの共有ガード）', () => {
    expect(improvementAdoptionError(undefined)?.code).toBe('AKO-REQ-002')
    // 取消済み + 集約済みは 019（先に復元）を案内する: 013 の「集約の解除」を先に案内すると
    // 解除も取消済みで行き止まり（AKO-REQ-018）になるため（レビュー R10）
    expect(improvementAdoptionError({ itemId: 'imp-1', archivedAt: '2026-08-18T00:00:00+09:00' })?.code).toBe('AKO-REQ-019')
    expect(improvementAdoptionError({ itemId: null, archivedAt: '2026-08-18T00:00:00+09:00' })?.code).toBe('AKO-REQ-019')
    expect(improvementAdoptionError({ itemId: 'imp-1', archivedAt: null })?.code).toBe('AKO-REQ-013')
    expect(improvementAdoptionError({ itemId: null, archivedAt: null })).toBeNull()
  })
  it('重複除去し、適用できる id のみ仕分ける（done/failed の算定根拠）', () => {
    const plan = planAdoptionBulk(['a', 'b', 'a'], rows)
    expect(plan.targets).toEqual(['a', 'b']) // 重複は 1 件に（2 重カウントしない）
    expect(plan.applicable).toEqual(['a', 'b'])
    expect(plan.lastError).toBeNull()
  })
  it('存在しない・集約済み・取消済みはスキップし、最後の理由を返す（部分成功 = 原則4）', () => {
    const plan = planAdoptionBulk(['a', 'nope', 'c', 'd'], rows)
    expect(plan.applicable).toEqual(['a'])
    expect(plan.targets).toHaveLength(4) // failed = targets.length - applicable.length = 3
    expect(plan.lastError?.code).toBe('AKO-REQ-019') // 最後に当たった理由（d = 取消済み）
    expect(planAdoptionBulk(['c'], rows).lastError?.code).toBe('AKO-REQ-013')
    expect(planAdoptionBulk(['nope'], rows).lastError?.code).toBe('AKO-REQ-002')
  })
  it('全滅（適用 0 件）でも targets は返る（呼び出し側が ok:false + 理由で案内できる）', () => {
    const plan = planAdoptionBulk(['c', 'd'], rows)
    expect(plan.applicable).toEqual([])
    expect(plan.lastError).not.toBeNull()
  })
})
