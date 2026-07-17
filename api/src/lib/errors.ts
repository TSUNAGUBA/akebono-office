/**
 * エラー表現。想定エラーは AKO-XXX-nnn コード付きで JSON 返却する
 * （台帳: .ai-native/outputs/phase5/api-design.md §4。モックの Result 型と同じ形）。
 */
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: ContentfulStatusCode = 400,
  ) {
    super(message)
  }
}

/** 便宜コンストラクタ（throw err('AKO-…', '…', 403)） */
export function err(code: string, message: string, status: ContentfulStatusCode = 400): ApiError {
  return new ApiError(code, message, status)
}

export function errorResponse(c: Context, e: unknown) {
  if (e instanceof ApiError) {
    return c.json({ error: { code: e.code, message: e.message } }, e.status)
  }
  console.error('unhandled error:', e)
  return c.json({ error: { code: 'AKO-GEN-500', message: 'サーバー内部エラーが発生しました' } }, 500)
}
