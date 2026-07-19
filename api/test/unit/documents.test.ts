/**
 * ドキュメント管理（バッチ7l）の純関数検証。
 * - buildV4SignParts: GCS V4 署名の正規リクエスト構築（仕様準拠の形式検証）
 * - wouldCycle: フォルダ移動の循環検出
 */
import { describe, expect, it } from 'vitest'
import { buildV4SignParts } from '../../src/lib/storage'
import { wouldCycle } from '../../src/routes/documents'

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
