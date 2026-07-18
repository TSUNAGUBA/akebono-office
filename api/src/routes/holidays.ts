/**
 * 祝日マスタの公式取込（オペレーター報告 2026-07-18 #4）。
 * - SoT: public_holidays（一覧・手動追加・削除は汎用マスタ /v1/masters/holidays が担う）
 * - 取込元: 内閣府「国民の祝日」CSV（Shift_JIS）。画面の「公式データから更新」ボタンから
 *   いつでも再取込できる（date 一意の upsert = 冪等。再実行で既存データは巻き戻らない = 原則2）
 * - オフライン取込: body.csvText（UTF-8 文字列）/ body.csvBase64（バイト列 = UTF-8/Shift_JIS 自動判定)
 *   を渡すとネットワークへ出ずに取り込める（公式サイト障害時の手動アップロード経路・テスト用）
 * エラー: AKO-HOL-001（公式 CSV の取得失敗）/ AKO-HOL-002（CSV の解析結果が 0 件）
 */
import { Hono } from 'hono'
import type pg from 'pg'
import { requireAdmin } from '../auth'
import { audit } from '../lib/audit'
import { err } from '../lib/errors'
import { newId } from '../lib/ids'

export const OFFICIAL_HOLIDAYS_CSV_URL = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv'

/** バイト列を UTF-8（妥当な場合）または Shift_JIS としてデコードする（内閣府 CSV は Shift_JIS） */
function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('shift_jis').decode(bytes)
  }
}

/** CSV テキスト → { date, name }[]（ヘッダ行・不正行はスキップ。YYYY/M/D → YYYY-MM-DD へ正規化） */
export function parseHolidaysCsv(text: string): { date: string; name: string }[] {
  const out: { date: string; name: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    const [rawDate, rawName] = line.split(',')
    if (!rawDate || !rawName) continue
    const m = rawDate.trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/)
    if (!m) continue // ヘッダ行（国民の祝日・休日月日,…）等
    const date = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
    const name = rawName.trim()
    if (name) out.push({ date, name })
  }
  return out
}

/** fromDate より後の祝日日付 Set（翌営業日計算用。既定 400 日先まで = nextWorkingDay の探索上限を覆う） */
export async function holidaySetAfter(pool: pg.Pool, fromDate: string, days = 400): Promise<Set<string>> {
  const { rows } = await pool.query<{ date: string }>(
    `SELECT date::text AS date FROM public_holidays
     WHERE date > $1::date AND date <= $1::date + ($2 || ' days')::interval`,
    [fromDate, days])
  return new Set(rows.map(r => r.date))
}

export function holidaysRoutes(pool: pg.Pool): Hono {
  const app = new Hono()

  // 公式 CSV の取込（管理者のみ）。date 一意の upsert（official が手動登録より優先で上書き）
  app.post('/import', async (c) => {
    const user = requireAdmin(c)
    const body = await c.req.json().catch(() => ({})) as { csvText?: string; csvBase64?: string }
    // サイズ上限（公式 CSV 約 20KB に対し十分な余裕。巨大ボディの全量デコードを避ける = avatar ガードと同型）
    if ((body.csvText?.length ?? 0) > 2_000_000 || (body.csvBase64?.length ?? 0) > 2_800_000) {
      throw err('AKO-GEN-001', 'CSV が大きすぎます（1MB 以下にしてください）', 400)
    }
    let text: string
    let source = 'アップロード'
    if (typeof body.csvText === 'string' && body.csvText) {
      text = body.csvText
    } else if (typeof body.csvBase64 === 'string' && body.csvBase64) {
      text = decodeCsvBytes(Buffer.from(body.csvBase64, 'base64'))
    } else {
      source = '内閣府公式 CSV'
      try {
        const res = await fetch(OFFICIAL_HOLIDAYS_CSV_URL, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        text = decodeCsvBytes(new Uint8Array(await res.arrayBuffer()))
      } catch (e) {
        throw err('AKO-HOL-001',
          `公式 CSV の取得に失敗しました（${(e as Error).message}）。時間をおいて再実行するか、CSV ファイルをアップロードしてください`, 502)
      }
    }
    const rows = parseHolidaysCsv(text).slice(0, 5000)
    if (rows.length === 0) {
      throw err('AKO-HOL-002', 'CSV から祝日を読み取れませんでした。形式（日付,名称）をご確認ください', 400)
    }
    let upserted = 0
    for (const r of rows) {
      const result = await pool.query(
        `INSERT INTO public_holidays (id, date, name, source) VALUES ($1, $2, $3, 'official')
         ON CONFLICT (date) DO UPDATE SET name = EXCLUDED.name, source = 'official', updated_at = now()
         WHERE public_holidays.name IS DISTINCT FROM EXCLUDED.name OR public_holidays.source <> 'official'`,
        [newId('hd'), r.date, r.name])
      upserted += result.rowCount ?? 0
    }
    await audit(pool, {
      actorId: user.id, action: 'import', entity: 'public_holidays', entityId: '-',
      detail: `祝日を取込（${source}: ${rows.length} 件中 ${upserted} 件を追加・更新）`,
    })
    return c.json({ data: { total: rows.length, upserted } })
  })

  return app
}
