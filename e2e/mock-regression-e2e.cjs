// モック回帰（モックモード配信 :4173）: ナビ + 売上ページ + 主要ページの描画確認
// モックモードは localStorage シードで完全動作（下位互換の確認）。既定ユーザー m-03 = 管理者。
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

async function main() {
  await withPage(async (page) => {
    console.log('suite: モック回帰（ナビ + 売上 + 主要ページ）')

    // 1) ダッシュボード
    await page.goto(`${BASE}/#/`)
    await page.getByText('売上管理').first().waitFor()
    check('ダッシュボードのカードメニューが表示される', true)

    // 2) 売上管理（シードデータで KPI・チャートが出る）
    await page.goto(`${BASE}/#/sales`)
    await page.getByRole('main').getByRole('heading', { name: '売上管理' }).waitFor()
    await page.waitForTimeout(500)
    const kpi = await page.getByText(/^¥[\d,.]+(億|万)?$/).first().textContent()
    check('今月売上 KPI がシードから集計される', !!kpi && kpi !== '¥0')
    check('チャートが描画される', (await page.locator('canvas').count()) >= 3)
    const fyOptions = await page.getByLabel('売上の表示年度').locator('option').allTextContents()
    check('年度セレクタに複数年度（24 ヶ月シード）', fyOptions.length >= 2)

    // 3) モックモードでも実績登録（管理者既定ユーザー）が動く
    await page.getByRole('button', { name: '実績登録' }).click()
    await page.getByRole('dialog', { name: '月次実績の登録' }).waitFor()
    await page.getByLabel('売上（円）').fill('1000000')
    await page.getByLabel('原価（円）').fill('600000')
    await page.getByRole('button', { name: '登録する' }).click()
    await page.getByText('月次実績を登録しました').waitFor()
    check('モックモードで実績登録が反映される', true)

    // 4) 主要ページのナビ回帰（描画のみ）
    for (const [path, heading] of [
      ['/attendance', '勤怠管理'],
      ['/reports', '日報・週報'],
      ['/masters', 'マスタメンテナンス'],
      ['/status', '提供システム稼働状況'],
      ['/akebono', 'AKEBONO'],
    ]) {
      await page.goto(`${BASE}/#${path}`)
      await page.getByRole('main').getByRole('heading', { name: heading }).first().waitFor()
      check(`${path} が表示される`, true)
    }
  })
  summary('mock-regression-e2e')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
