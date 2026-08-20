/**
 * 活動ログ（案件ヘッダー + 活動ログ構造。改修依頼 2026-08-20）の単体テスト。
 * shared/domain/activity の activityLogError / heuristicActivityDigest は API（activities.ts）と
 * モック（useActivityLogs / use*Activities.generateDigest）の**パリティの SoT**。
 * - activityLogError: 宣言順（活動日 → 種別 → 件名 → Next Action日 → リンク）の検証
 * - heuristicActivityDigest: 決定性（同一入力 = 同一出力・入力順序に依存しない）/ 時系列考慮 / 空ログ挙動
 */
import { describe, expect, it } from 'vitest'
import {
  activityLogError, type ActivityLogInput,
  type ActivityDigestLog,
  heuristicActivityDigest, sortLogsChronologically,
} from '../../shared/domain/activity'

const logBase: ActivityLogInput = {
  loggedOn: '2026-08-20',
  kind: '訪問',
  title: '初回訪問・要件ヒアリング',
  body: '要件を確認した',
  nextAction: '',
  nextActionDate: null,
  links: [],
}

describe('activityLogError（活動ログの入力検証）', () => {
  it('正常入力は null（内容・Next Action は任意）', () => {
    expect(activityLogError(logBase)).toBeNull()
    expect(activityLogError({ ...logBase, body: '', nextAction: '', nextActionDate: null })).toBeNull()
  })
  it('必須項目（活動日・活動種別・件名）', () => {
    expect(activityLogError({ ...logBase, loggedOn: '' })).toBe('活動日を選択してください')
    expect(activityLogError({ ...logBase, loggedOn: '2026-02-30' })).toBe('活動日が正しくありません')
    expect(activityLogError({ ...logBase, kind: '' })).toBe('活動種別を選択してください')
    expect(activityLogError({ ...logBase, kind: 'テレパシー' })).toBe('活動種別の値が正しくありません')
    expect(activityLogError({ ...logBase, title: '  ' })).toBe('件名を入力してください')
  })
  it('Next Action日は実在日・参考リンクは http(s)', () => {
    expect(activityLogError({ ...logBase, nextActionDate: '2026-13-01' })).toBe('Next Action日が正しくありません')
    expect(activityLogError({ ...logBase, nextActionDate: '2026-09-01' })).toBeNull()
    expect(activityLogError({ ...logBase, links: ['ftp://a'] })).not.toBeNull()
    expect(activityLogError({ ...logBase, links: ['https://ref.example'] })).toBeNull()
  })
})

const header = { title: '在庫管理DXプロジェクト', status: '提案', nextAction: 'ヘッダー側アクション', nextActionDate: '2026-09-10' }

function log(over: Partial<ActivityDigestLog>): ActivityDigestLog {
  return {
    loggedOn: '2026-08-01', createdAt: '2026-08-01T10:00:00+09:00',
    kind: '訪問', title: '訪問A', body: '本文', nextAction: '', nextActionDate: null,
    ...over,
  }
}

describe('heuristicActivityDigest（決定的な AI集約）', () => {
  it('空ログでも壊れず「未登録」の案内を返す', () => {
    const d = heuristicActivityDigest(header, [])
    expect(d.summary).toContain('在庫管理DXプロジェクト')
    expect(d.summary).toContain('まだ登録されていません')
    expect(d.highlights).toEqual([])
  })

  it('決定性: 同一入力は常に同一出力・入力の並び順に依存しない（時系列ソートを内包）', () => {
    const logs = [
      log({ loggedOn: '2026-08-01', title: '初回訪問', kind: '訪問' }),
      log({ loggedOn: '2026-08-10', title: 'デモ実施', kind: 'Web会議', body: 'デモを実施し好感触' }),
      log({ loggedOn: '2026-08-05', title: '電話フォロー', kind: '電話' }),
    ]
    const a = heuristicActivityDigest(header, logs)
    const b = heuristicActivityDigest(header, logs)
    const shuffled = heuristicActivityDigest(header, [logs[2]!, logs[0]!, logs[1]!])
    expect(a).toEqual(b)
    expect(a).toEqual(shuffled)
  })

  it('時系列考慮: 直近（最新の活動日）のログが「直近の動き」として要約へ載る + 期間・件数・内訳', () => {
    const logs = [
      log({ loggedOn: '2026-08-01', title: '初回訪問', kind: '訪問' }),
      log({ loggedOn: '2026-08-05', title: '電話フォロー', kind: '電話' }),
      log({ loggedOn: '2026-08-10', title: 'デモ実施', kind: 'Web会議', body: 'デモを実施し好感触' }),
    ]
    const d = heuristicActivityDigest(header, logs)
    expect(d.summary).toContain('2026/08/01〜2026/08/10')
    expect(d.summary).toContain('3件')
    expect(d.summary).toContain('デモ実施') // 最新ログの件名
    expect(d.summary).toContain('デモを実施し好感触') // 最新ログの内容抜粋
    expect(d.summary).toContain('訪問1件')
    expect(d.highlights.length).toBeGreaterThan(0)
  })

  it('同一活動日は登録時刻（createdAt）で時系列を判定する', () => {
    const logs = [
      log({ loggedOn: '2026-08-10', createdAt: '2026-08-10T09:00:00+09:00', title: '午前の電話', kind: '電話' }),
      log({ loggedOn: '2026-08-10', createdAt: '2026-08-10T18:00:00+09:00', title: '夕方の訪問', kind: '訪問' }),
    ]
    const d = heuristicActivityDigest(header, logs)
    expect(d.summary).toContain('夕方の訪問')
    const sorted = sortLogsChronologically(logs)
    expect(sorted[0]!.title).toBe('午前の電話')
  })

  it('次のアクション: 最新の nextAction 付きログを優先し、無ければ案件ヘッダーへフォールバック', () => {
    const withLogNext = heuristicActivityDigest(header, [
      log({ loggedOn: '2026-08-01', nextAction: '古いアクション', nextActionDate: '2026-08-03' }),
      log({ loggedOn: '2026-08-10', nextAction: '見積書の提出', nextActionDate: '2026-08-25' }),
    ])
    expect(withLogNext.summary).toContain('見積書の提出')
    expect(withLogNext.summary).toContain('2026/08/25')

    const headerFallback = heuristicActivityDigest(header, [log({ loggedOn: '2026-08-01' })])
    expect(headerFallback.summary).toContain('ヘッダー側アクション')

    const none = heuristicActivityDigest({ title: 'x', status: '初回' }, [log({ loggedOn: '2026-08-01' })])
    expect(none.summary).toContain('次のアクションは未設定')
  })
})
