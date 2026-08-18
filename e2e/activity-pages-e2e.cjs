// 活動記録 3 ページ + 顧客活動改修 + 一覧ページング（改修依頼 2026-08-18）のモックモード E2E。
// モックモード配信（既定 :4173）に対して、新設ページの描画・登録フィードバック・
// 顧客活動の全員閲覧化 + 活動手段・ページング UI・モバイル幅（375px）の崩れなしを確認する。
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

async function main() {
  await withPage(async (page) => {
    console.log('suite: 活動記録 3 ページ + 顧客活動 + ページング（改修依頼 2026-08-18）')

    // 1) サポート活動: シード表示 + ページング UI + 登録フィードバック
    await page.goto(`${BASE}/#/support-activity`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'サポート活動' }).waitFor()
    await page.getByText('CSVが取り込めない').first().waitFor()
    check('サポート活動: シードの一覧が表示される', true)
    check('サポート活動: ページング UI（全 N 件中）が表示される',
      (await page.getByText(/全 \d+ 件中/).count()) >= 1)
    await page.getByRole('button', { name: '登録する' }).click()
    await page.getByLabel('受付日').waitFor()
    await page.getByLabel('顧客（会社）').fill('イーツーイー商会')
    await page.getByLabel('問い合わせ種別', { exact: true }).selectOption({ label: 'データ' })
    await page.getByLabel('件名', { exact: true }).fill('E2E 登録テスト')
    await page.getByLabel('問い合わせ内容').fill('E2E からの登録確認')
    await page.getByRole('button', { name: '登録', exact: true }).click()
    await page.getByText('サポート活動を登録しました').waitFor()
    check('サポート活動: 登録でトーストのフィードバックがある', true)
    await page.getByText('未登録の顧客はマスタへ登録し、記録に反映しました').waitFor()
    check('サポート活動: 未登録の会社がコンボボックス経由でマスタ登録される', true)

    // 2) 営業活動: シード表示 + フェーズバッジ + 金額表示
    await page.goto(`${BASE}/#/sales-activity`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: '営業活動' }).waitFor()
    await page.getByText('在庫管理DXプロジェクト').first().waitFor()
    check('営業活動: シードの一覧が表示される', true)
    check('営業活動: 商談金額が ¥ 書式で表示される',
      (await page.getByText('¥1,500,000').count()) >= 1)

    // 3) ビジネスパートナー活動: シード表示 + 詳細ドロワーの関連商談リンク
    await page.goto(`${BASE}/#/partner-activity`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'ビジネスパートナー活動' }).waitFor()
    await page.getByText('製造業DX案件の紹介').first().click()
    await page.getByRole('link', { name: /生産管理システム刷新/ }).waitFor()
    check('パートナー活動: 詳細ドロワーに関連商談（営業活動）へのリンクが出る', true)
    await page.keyboard.press('Escape')

    // 4) 顧客活動（旧: 顧客ログ）: 改称 + 全員の記録の閲覧 + 記録者フィルタ + 活動手段
    await page.goto(`${BASE}/#/customer-log`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: '顧客活動' }).waitFor()
    check('顧客活動: ページ名が「顧客活動」へ改称されている', true)
    // 既定ユーザー m-03（葛西）でも他メンバー（m-04/m-05）の記録が一覧に出る（全員閲覧化）
    await page.getByText('売上分析スイートの更新要望').first().waitFor() // m-04 の記録
    check('顧客活動: 他メンバーの記録も一覧に表示される（全員閲覧化）', true)
    check('顧客活動: 記録者で絞り込みセレクトがある',
      (await page.getByLabel('記録者で絞り込み').count()) === 1)
    // 活動手段チップが一覧に出る（シードの method）
    check('顧客活動: 一覧に活動手段（Web会議 等）が表示される',
      (await page.getByText('Web会議').count()) >= 1)
    // 記録モーダル: 活動目的（旧: 属性タグ）+ 活動手段チップ
    await page.getByRole('button', { name: '記録する' }).click()
    await page.getByText('活動目的（任意）').waitFor()
    check('顧客活動: フォームの「活動目的」（旧: 属性タグ）がある', true)
    const methodChips = page.getByRole('tablist', { name: '活動手段' })
    await methodChips.waitFor()
    check('顧客活動: 「活動手段」チップ（訪問/Web会議/…）が活動目的の下にある',
      (await methodChips.getByRole('tab').count()) === 7) // 未設定 + プリセット 6
    await page.keyboard.press('Escape')

    // 5) 既存一覧のページング横展開の代表確認（顧客(会社)マスタ = 管理者ページ）
    await page.goto(`${BASE}/#/masters/customers`)
    await page.getByText(/顧客\(会社\)一覧/).waitFor()
    check('masters/customers: ページング UI が表示される',
      (await page.getByText(/全 \d+ 件中/).count()) >= 1)

    // 6) モバイル幅（375px）: 崩れず操作できる（横スクロールが発生しない）
    await page.setViewportSize({ width: 375, height: 800 })
    for (const [path, label] of [
      ['/#/support-activity', 'サポート活動'],
      ['/#/sales-activity', '営業活動'],
      ['/#/partner-activity', 'ビジネスパートナー活動'],
      ['/#/customer-log', '顧客活動'],
    ]) {
      await page.goto(`${BASE}${path}`)
      await page.getByRole('main').getByRole('heading', { level: 1, name: label }).waitFor()
      await page.waitForTimeout(300)
      const overflow = await page.evaluate(() =>
        document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth)
      check(`モバイル 375px: ${label} で横スクロールが発生しない（overflow=${overflow}px）`, overflow <= 1)
    }
  })
  summary('活動記録 3 ページ + 顧客活動 + ページング')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
