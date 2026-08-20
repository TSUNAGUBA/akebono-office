import { describe, expect, it } from 'vitest'
import { normalizeSearch, normalizedIncludes } from '~/utils/search'

/**
 * 検索正規化（NFKC + 小文字）のリグレッション。PG の app_office.akebono_norm と同一結果であることが
 * 両モードの検索ヒット一致の前提（migration 0056 でスモーク検証済み）。
 */
describe('normalizeSearch（大文字小文字・全角半角の吸収）', () => {
  it('全角 ASCII → 半角 + 小文字', () => {
    expect(normalizeSearch('ＡＫＥＢＯＮＯ－１２３')).toBe('akebono-123')
    expect(normalizeSearch('Akebono-123')).toBe('akebono-123')
  })
  it('半角カナ → 全角カナ（濁点合成）', () => {
    expect(normalizeSearch('ｱｹﾎﾞﾉ')).toBe('アケボノ')
    expect(normalizeSearch('アケボノ')).toBe('アケボノ')
  })
  it('全角スペース・記号も NFKC で畳み込む', () => {
    expect(normalizeSearch('ＡＢ　ＣＤ')).toBe('ab cd')
  })
})

describe('normalizedIncludes（正規化部分一致）', () => {
  it('表記ゆれ（全角/半角/大小）を跨いでヒット', () => {
    expect(normalizedIncludes('ＡＫＥＢＯＮＯ商事', 'akebono')).toBe(true)
    expect(normalizedIncludes('アケボノ商事', 'ｱｹﾎﾞﾉ')).toBe(true)
    expect(normalizedIncludes('Akebono Corp', 'ＣＯＲＰ')).toBe(true)
  })
  it('空クエリ（trim 後）は常にヒット = 絞り込みなし', () => {
    expect(normalizedIncludes('anything', '   ')).toBe(true)
  })
  it('含まれないときは false', () => {
    expect(normalizedIncludes('アケボノ', 'さくら')).toBe(false)
  })
})
