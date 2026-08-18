/**
 * 改善要望（F-42）の権限ゲートと集約・プロンプトの純ロジック。
 * canManageImprovements = deny-by-default（管理者は常時可・明示 allow で付与）。
 */
import { describe, expect, it } from 'vitest'
import { canManageImprovements, type PermissionSubject } from '../../shared/domain/permissions'
import type { PermissionRule } from '../../shared/domain/types'
import {
  buildCodingPrompt, canTransition, clusterTargetRequests, heuristicClusterRequests,
  IMPROVEMENT_REQUEST_ADOPTION_META, IMPROVEMENT_STATUS_META,
  improvementCommentError, improvementImagesError, improvementLinksError,
  matchesImprovementFilter, normalizeImprovementLinks, requestAdoptionOf,
  improvementEditError,
} from '../../shared/domain/improvement'

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
  it('ガント既定フィルタ（accepted = 実装が決まっていて未完了）は accepted のみ選ぶ', () => {
    // ImprovementsGantt は既定 statusFilter='accepted' でこの判定を使う（実装決定・未完了だけを初期表示）
    expect(matchesImprovementFilter('accepted', 'accepted')).toBe(true)
    expect(matchesImprovementFilter('triage', 'accepted')).toBe(false)
    expect(matchesImprovementFilter('resolved', 'accepted')).toBe(false)
    expect(matchesImprovementFilter('rejected', 'accepted')).toBe(false)
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
