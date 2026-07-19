// チャットボット マルチターン E2E（API モード・LLM 無効 = フォールバック経路）
// オペレーター報告 2026-07-18 対応の検証:
//  1) フォローアップ質問（キーワードなし）でも直前の話題（2 段ルーティング）で回答する
//  2) リロード後も同じセッションを自動再開し、会話履歴が表示される
// 待機はストリーミング完了 = 入力欄の再活性（isStreaming 解除）を条件待ちする（時間依存フレークの排除）
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4174'

/** ストリーミング完了待ち（textarea は isStreaming 中 disabled になる） */
async function waitStreamDone(input, timeoutMs = 30000) {
  const t0 = Date.now()
  await new Promise(r => setTimeout(r, 300)) // ストリーミング開始（disabled 化）を待つ
  while (Date.now() - t0 < timeoutMs) {
    if (await input.isEnabled()) return
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('ストリーミングが完了しません')
}

async function main() {
  await withPage(async (page) => {
    console.log('suite: チャットボット マルチターン（API モード・フォールバック経路）')

    await page.goto(`${BASE}/#/support/chatbot`)
    await page.getByRole('main').getByRole('heading', { name: 'AIチャットボット' }).waitFor()
    check('チャットボットページが表示される', true)

    const input = page.getByLabel('質問を入力')
    const sendBtn = page.getByRole('button', { name: '送信' })
    // m-e2e は有給付与なし → answerLeave は「有効な有給付与が見つかりません」の固有文言を返す
    const LEAVE_MARKER = /有効な有給付与が見つかりませんでした/g

    // 1 ターン目: 有給の質問（フォールバックの決定的応答 = 有給トピック）
    await input.fill('有給の残りは何日？')
    await sendBtn.click()
    await waitStreamDone(input)
    let body = await page.locator('main').innerText()
    check('1 ターン目: 有給トピックの応答が返る', (body.match(LEAVE_MARKER) ?? []).length === 1)

    // 2 ターン目: キーワードを含まないフォローアップ → 従来は「うまく回答できませんでした」、
    // 修正後は直前の話題（有給）を引き継いで回答する（= 有給応答の固有文言が 2 回現れる）
    await input.fill('じゃあ去年はどうだった？')
    await sendBtn.click()
    await waitStreamDone(input)
    body = await page.locator('main').innerText()
    check('2 ターン目: フォローアップが定型応答に落ちない', !body.includes('うまく回答できませんでした'))
    check('2 ターン目: 直前の話題（有給）の応答が返る（固有文言 2 回）',
      (body.match(LEAVE_MARKER) ?? []).length === 2)

    // リロード → セッション自動再開（会話履歴が残って表示される）。
    // 検証は初期サジェストと重複しない固有文言（2 ターン目）で行う
    await page.reload()
    await page.getByText('じゃあ去年はどうだった？').waitFor()
    check('リロード後も同じ会話が自動再開される（sessionStorage + サーバー履歴）', true)

    // 会社の質問（フォールバック answerCompany）: 業界 + 関係性が実データで返る
    // （オペレーター報告 2026-07-18 #2: クライアント側フォールバックにも関係性を追加）
    await input.fill('E2E商事について教えて')
    await sendBtn.click()
    await waitStreamDone(input)
    const companyBody = await page.locator('main').innerText()
    check('会社応答: 業界が返る', companyBody.includes('E2Eアパレル'))
    check('会社応答: 会社間の関係が返る', companyBody.includes('E2E取引先'))

    // 「弊社」= 自社の名寄せ（オペレーター報告 2026-07-18 #3: 弊社/当社・法人格省略の照合）
    await input.fill('弊社の取引先は?')
    await sendBtn.click()
    await waitStreamDone(input)
    const selfBody = await page.locator('main').innerText()
    check('自社応答: 「弊社」キーワードで自社情報が返る', selfBody.includes('自社「E2E 自社」'))
    check('自社応答: 取引関係（E2E商事）が返る', selfBody.includes('E2E商事'))

    // 新しい会話 → 空の状態から開始できる（従来機能の回帰確認）
    await page.getByRole('button', { name: '新しい会話' }).click()
    await page.waitForTimeout(500)
    const afterNew = await page.locator('main').innerText()
    check('「新しい会話」で空の状態から開始できる', !afterNew.includes('じゃあ去年はどうだった？'))
  })
  summary('chatbot-multiturn-e2e')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
