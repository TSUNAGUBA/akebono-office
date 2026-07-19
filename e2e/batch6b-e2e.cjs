// バッチ6b E2E（API モード実クリック）: 売上管理 F-15
// 前提: run-batch6b-stack.sh が API(:8788・dev 認証 m-e2e=admin) + 静的配信(:4174) を起動済み。
// 顧客「E2E商事」「E2Eシステムズ」・自社（4 月始まり）はスタックが API 経由で登録済み。
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4174'

async function main() {
  await withPage(async (page) => {
    console.log('suite: batch6b 売上管理（API モード）')

    // 1) /sales 表示（モックバッジが出ない = mock-status から除去済み）
    await page.goto(`${BASE}/#/sales`)
    await page.getByRole('main').getByRole('heading', { name: '売上管理' }).waitFor()
    check('売上管理ページが表示される', true)
    await page.waitForTimeout(800) // ハイドレーション待ち
    check('モックアップバッジが表示されない', !(await page.getByText('モックアップ', { exact: true }).count()))

    // 2) 実績登録（管理者）: 当月 development 1,200,000 / 700,000
    await page.getByRole('button', { name: '実績登録' }).click()
    await page.getByRole('dialog', { name: '月次実績の登録' }).waitFor()
    check('実績登録モーダルが開く', true)
    const month = await page.getByLabel('対象月').inputValue()
    check('対象月が当月で初期化される', /^\d{4}-\d{2}$/.test(month))
    await page.getByLabel('顧客(会社)').selectOption({ label: 'E2E商事' })
    await page.getByLabel('事業種別').selectOption('development')
    await page.getByLabel('売上（円）').fill('1200000')
    await page.getByLabel('原価（円）').fill('700000')
    await page.getByRole('button', { name: '登録する' }).click()
    await page.getByText('月次実績を登録しました').waitFor()
    check('登録トーストが表示される', true)

    // 3) KPI へ即時反映（今月売上 ¥120万）
    await page.getByText('¥120万', { exact: true }).waitFor()
    check('今月売上 KPI = ¥120万', true)

    // 4) 別種別・別顧客を追加 → 合算 ¥200万・粗利率 50.0%
    await page.getByRole('button', { name: '実績登録' }).click()
    await page.getByRole('dialog', { name: '月次実績の登録' }).waitFor()
    await page.getByLabel('顧客(会社)').selectOption({ label: 'E2Eシステムズ' })
    await page.getByLabel('事業種別').selectOption('operation')
    await page.getByLabel('売上（円）').fill('800000')
    await page.getByLabel('原価（円）').fill('300000')
    await page.getByRole('button', { name: '登録する' }).click()
    await page.getByText('¥200万', { exact: true }).waitFor()
    check('今月売上 KPI = ¥200万（2 件の合算）', true)
    check('粗利率 KPI = 50.0%', (await page.getByText('50.0%', { exact: true }).count()) > 0)

    // 5) 同一キーの再登録は上書き（冪等 = 二重計上されない）
    await page.getByRole('button', { name: '実績登録' }).click()
    await page.getByRole('dialog', { name: '月次実績の登録' }).waitFor()
    await page.getByLabel('顧客(会社)').selectOption({ label: 'E2E商事' })
    await page.getByLabel('事業種別').selectOption('development')
    await page.getByLabel('売上（円）').fill('1500000')
    await page.getByLabel('原価（円）').fill('900000')
    await page.getByRole('button', { name: '登録する' }).click()
    await page.getByText('¥230万', { exact: true }).waitFor()
    check('同一キー再登録で上書き（¥230万 = 150+80。二重計上なし）', true)

    // 6) 年度セレクタに実データの年度が出る
    const fyOptions = await page.getByLabel('売上の表示年度').locator('option').allTextContents()
    check('年度セレクタに年度が表示される', fyOptions.length >= 1 && fyOptions.every(o => /^\d{4}年度$/.test(o)))

    // 7) リロードしても保持（DB が SoT）
    await page.reload()
    await page.getByText('¥230万', { exact: true }).waitFor()
    check('リロード後も実績が保持される（API SoT）', true)

    // 8) チャート描画（canvas 3 枚 = 月次推移・種別内訳・顧客別）
    check('チャートが描画される', (await page.locator('canvas').count()) >= 3)
  })
  summary('batch6b-e2e')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
