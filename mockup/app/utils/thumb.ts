/**
 * サムネイル/画像プレースホルダの共有ヘルパー（商品画像。F-21-3）
 * - 純関数（色クラス・頭文字）は products 画面と AkebonoProductThump で共有（原則3・重複排除）
 * - imageToDataUri は画像ファイルを縮小して data URI 化する（実登録。ブラウザ API を関数内でのみ参照）
 */

/** 画像未設定時の色プレースホルダ（静的クラスで Tailwind の purge を回避） */
export const THUMB_BOX_CLASSES = [
  'bg-brand-soft text-brand',
  'bg-ok-soft text-ok',
  'bg-info-soft text-info',
  'bg-warn-soft text-warn',
  'bg-serious-soft text-serious',
] as const

/** シード文字列から決定的に色クラスを選ぶ */
export function thumbBoxClass(seed: string): string {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return THUMB_BOX_CLASSES[h % THUMB_BOX_CLASSES.length]!
}

/** プレースホルダに描く頭文字 */
export function thumbFirstChar(s: string): string {
  return (s.trim()[0] ?? '?').toUpperCase()
}

/** 保存キャップ（localStorage 容量に配慮。480px JPEG は通常 20-60KB） */
export const IMAGE_MAX_PX = 480
export const IMAGE_MAX_CHARS = 400_000

/**
 * 画像ファイルを最大辺 maxPx へ縮小し data URI 化する（アスペクト比保持）。
 * profile.vue の resizeToDataUri と同型だが、商品画像は正方形クロップせず縦横比を保つ。
 * ブラウザ専用（Image/canvas）。呼び出しはクライアントのみ（本アプリは SPA）。
 */
export function imageToDataUri(file: File, maxPx = IMAGE_MAX_PX, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('canvas が利用できません'))
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      // PNG は透過保持のため PNG、その他は JPEG で圧縮
      const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
      resolve(canvas.toDataURL(mime, quality))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('画像を読み込めませんでした'))
    }
    img.src = url
  })
}
