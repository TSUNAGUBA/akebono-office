/**
 * 決定的乱数ユーティリティ（akebono-scm-platform mockup 規範を踏襲）
 * - Math.random は使用禁止。同じキーは常に同じ値を返し、リロードしても世界が変わらない。
 */

/** 文字列 → 32bit ハッシュ（FNV-1a） */
export function hashStr(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** キーから [0,1) の決定的な値 */
export function unit(key: string): number {
  return hashStr(key) / 0x100000000
}

/** キーから [min,max] の決定的な整数 */
export function irange(key: string, min: number, max: number): number {
  return min + Math.floor(unit(key) * (max - min + 1))
}

/** キーから配列要素を決定的に選択 */
export function pick<T>(key: string, arr: readonly T[]): T {
  return arr[irange(key, 0, arr.length - 1)] as T
}
