/** 文字列ユーティリティ（ルート間で共有 = 原則3） */

/** コードポイント単位の切詰め（サロゲートペアを境界で壊さない） */
export function capCp(s: string, n: number): string {
  return [...s].slice(0, n).join('')
}
