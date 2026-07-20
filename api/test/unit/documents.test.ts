/**
 * ドキュメント管理（バッチ7l）の純関数検証。
 * - buildV4SignParts: GCS V4 署名の正規リクエスト構築（仕様準拠の形式検証）
 * - wouldCycle: フォルダ移動の循環検出
 */
import { describe, expect, it } from 'vitest'
import { buildV4SignParts, sanitizeFilename, strictEncode } from '../../src/lib/storage'
import { driveForbiddenHint, googleErrorDetail, wouldCycle } from '../../src/routes/documents'

describe('googleErrorDetail / driveForbiddenHint（ドライブ 403 の自己診断。PR #63 R1 M-2/M-3）', () => {
  const gRes = (body: unknown, status = 403): Response =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

  it('reason と message を結合して返す', async () => {
    const g = await googleErrorDetail(gRes({
      error: { message: 'Google Drive API has not been used in project 123', errors: [{ reason: 'accessNotConfigured' }] },
    }))
    expect(g.reason).toBe('accessNotConfigured')
    expect(g.detail).toBe('accessNotConfigured: Google Drive API has not been used in project 123')
  })

  it('非 JSON ボディ・空ボディは空文字（例外にしない）', async () => {
    expect((await googleErrorDetail(gRes('<html>error</html>'))).detail).toBe('')
    expect((await googleErrorDetail(gRes({}))).detail).toBe('')
  })

  it('message は 200 コードポイントで切り詰める', async () => {
    const g = await googleErrorDetail(gRes({ error: { message: 'x'.repeat(500) } }))
    expect([...g.detail].length).toBe(200)
  })

  it('403 + 設定不備系 reason・理由不明の 403 のみヒントを付ける（レート超過には付けない）', () => {
    expect(driveForbiddenHint(403, 'accessNotConfigured')).toContain('drive.googleapis.com')
    expect(driveForbiddenHint(403, 'insufficientPermissions')).toContain('再接続')
    expect(driveForbiddenHint(403, '')).toContain('drive.googleapis.com')
    expect(driveForbiddenHint(403, 'rateLimitExceeded')).toBe('')
    expect(driveForbiddenHint(500, 'accessNotConfigured')).toBe('')
  })
})

describe('sanitizeFilename / strictEncode（R1 M-1）', () => {
  it('パス区切り・制御文字を除去し、危険な名前はフォールバックする', () => {
    expect(sanitizeFilename('a/b\\c.txt')).toBe('a_b_c.txt')
    expect(sanitizeFilename('rep\u0000ort\u001f.pdf')).toBe('report.pdf')
    expect(sanitizeFilename('..')).toBe('file')
    expect(sanitizeFilename('  ')).toBe('file')
    expect(sanitizeFilename('会議資料.pdf')).toBe('会議資料.pdf')
  })

  it("strictEncode は encodeURIComponent が素通しする ! ' ( ) * も %XX 化する", () => {
    expect(strictEncode("a(1)'*!.pdf")).toBe('a%281%29%27%2A%21.pdf')
    expect(strictEncode('レポート.pdf')).toBe(encodeURIComponent('レポート.pdf'))
  })

  it('特殊文字ファイル名でも署名パーツが厳格エンコードで構築される', () => {
    const p = buildV4SignParts({
      bucket: 'b',
      path: "documents/doc-1/会議資料(最終版)'23.pdf",
      saEmail: 'sa@example.iam.gserviceaccount.com',
      now: new Date('2026-07-19T00:00:00.000Z'),
      expiresSeconds: 900,
      responseDisposition: `attachment; filename*=UTF-8''${strictEncode("会議資料(最終版)'23.pdf")}`,
    })
    expect(p.canonicalUri).not.toMatch(/[!'()*]/)
    expect(p.canonicalQuery).not.toMatch(/[!'()*]/)
  })
})

describe('buildV4SignParts', () => {
  const base = {
    bucket: 'my-bucket',
    path: 'documents/doc-1/レポート.pdf',
    saEmail: 'sa@example.iam.gserviceaccount.com',
    now: new Date('2026-07-19T12:34:56.789Z'),
    expiresSeconds: 900,
  }

  it('タイムスタンプ・スコープ・URI が V4 形式に従う', () => {
    const p = buildV4SignParts(base)
    expect(p.timestamp).toBe('20260719T123456Z')
    expect(p.canonicalUri).toBe('/my-bucket/documents/doc-1/%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88.pdf')
    expect(p.canonicalQuery).toContain('X-Goog-Algorithm=GOOG4-RSA-SHA256')
    expect(p.canonicalQuery).toContain(encodeURIComponent(`${base.saEmail}/20260719/auto/storage/goog4_request`))
    expect(p.canonicalQuery).toContain('X-Goog-Expires=900')
    expect(p.canonicalQuery).toContain('X-Goog-SignedHeaders=host')
  })

  it('正規リクエストと署名対象文字列の構造が仕様どおり', () => {
    const p = buildV4SignParts(base)
    const reqLines = p.canonicalRequest.split('\n')
    expect(reqLines[0]).toBe('GET')
    expect(reqLines[1]).toBe(p.canonicalUri)
    expect(reqLines[2]).toBe(p.canonicalQuery)
    expect(reqLines[3]).toBe('host:storage.googleapis.com')
    expect(reqLines[6]).toBe('UNSIGNED-PAYLOAD')
    const signLines = p.stringToSign.split('\n')
    expect(signLines[0]).toBe('GOOG4-RSA-SHA256')
    expect(signLines[1]).toBe('20260719T123456Z')
    expect(signLines[2]).toBe('20260719/auto/storage/goog4_request')
    expect(signLines[3]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('クエリパラメータはキーの辞書順に並ぶ（署名検証の前提）', () => {
    const p = buildV4SignParts({ ...base, responseDisposition: `attachment; filename*=UTF-8''x.pdf` })
    const keys = p.canonicalQuery.split('&').map(kv => kv.split('=')[0]!)
    expect([...keys].sort()).toEqual(keys)
    expect(p.canonicalQuery).toContain('response-content-disposition=')
  })
})

describe('wouldCycle', () => {
  //  a ── b ── c（a の子 b・b の子 c）
  const nodes = [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'b' },
    { id: 'x', parentId: null },
  ]

  it('自分自身・子孫への移動は循環', () => {
    expect(wouldCycle(nodes, 'a', 'a')).toBe(true)
    expect(wouldCycle(nodes, 'a', 'b')).toBe(true)
    expect(wouldCycle(nodes, 'a', 'c')).toBe(true)
  })

  it('無関係なフォルダ・ルートへの移動は循環でない', () => {
    expect(wouldCycle(nodes, 'a', 'x')).toBe(false)
    expect(wouldCycle(nodes, 'b', null)).toBe(false)
    expect(wouldCycle(nodes, 'c', 'a')).toBe(false)
  })
})
