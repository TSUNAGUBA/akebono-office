// 営業活動・BP活動の「案件ヘッダー + 活動ログ」構造のモックモード E2E（改修依頼 2026-08-20）。
// 1) 案件一覧 → 行クリックで案件詳細ページへ遷移
// 2) 活動ログ: 20件/ページのページング（deal-0001 = シード 26 件で 2 ページ目が実在）
// 3) 活動ログの登録（登録ボタンで実際に登録される = 登録無反応バグの回帰）
// 4) AI集約: 生成 → サマリー表示（ログ n 件時点）
// 5) BP: 「背景・目的」「取組内容」項目 + 登録フォームのインラインエラー（トースト非依存）
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173'

async function main() {
  await withPage(async (page) => {
    console.log('suite: 活動記録の案件 + 活動ログ構造（改修依頼 2026-08-20）')

    // ---- 1) 案件一覧 → 詳細ページ遷移 ----
    await page.goto(`${BASE}/#/sales-activity`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: '営業活動' }).waitFor()
    await page.getByText('在庫管理DXプロジェクト').first().click()
    // 詳細ページ固有の要素（活動ログカード）が出るまで待ってから URL を判定する
    await page.getByText(/活動ログ（26件）/).waitFor()
    check('営業活動: 行クリックで案件詳細ページへ遷移する', page.url().includes('/sales-activity/deal-0001'))
    check('案件詳細: 活動ログが 26 件表示される（シード）', true)

    // ---- 2) 活動ログのページング（26 件シード → 全 26 件中 + 2 ページ目） ----
    await page.getByText(/全 26 件中/).first().waitFor()
    check('活動ログ: ページング UI（全 26 件中）が出る', true)
    await page.getByRole('button', { name: '次のページ' }).click()
    await page.getByText('2 / 2').waitFor()
    check('活動ログ: 2 ページ目へ遷移できる（20件/ページ）', true)
    await page.getByRole('button', { name: '前のページ' }).click()

    // ---- 3) 活動ログの登録（登録ボタンで実際に登録される） ----
    await page.getByRole('button', { name: 'ログを登録' }).click()
    await page.getByRole('heading', { name: '活動ログを登録' }).waitFor()
    // 必須未入力で登録 → インラインエラー（role=alert）が出てドロワーは閉じない（トースト非依存の回帰）
    await page.getByRole('button', { name: '登録', exact: true }).click()
    await page.getByRole('alert').first().waitFor()
    check('活動ログ: 必須未入力はドロワー内インラインエラーで無反応にならない', true)
    await page.getByLabel('件名', { exact: true }).fill('E2E ログ登録テスト')
    // 活動種別は既定値なしの必須項目（UiSelect）
    await page.getByLabel('活動種別', { exact: true }).selectOption({ label: '訪問' })
    await page.getByRole('button', { name: '登録', exact: true }).click()
    await page.getByText('活動ログを登録しました').waitFor()
    check('活動ログ: 登録ボタンで登録されトーストが出る', true)
    await page.getByText(/活動ログ（27件）/).waitFor()
    check('活動ログ: 登録が一覧件数へ反映される（26→27件）', true)

    // ---- 4) AI集約 ----
    await page.getByRole('button', { name: 'AIで集約' }).click()
    await page.getByText(/ログ 27 件時点/).waitFor()
    check('AI集約: 生成でサマリーが保管・表示される（ログ 27 件時点）', true)

    // ---- 5) BP: 背景・目的 / 取組内容 + 登録フォームのインラインエラー ----
    await page.goto(`${BASE}/#/partner-activity`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'ビジネスパートナー活動' }).waitFor()
    await page.getByRole('button', { name: '案件を登録' }).click()
    await page.getByLabel('背景・目的').waitFor()
    check('BP: 登録フォームに「背景・目的」（旧: 概要）がある', true)
    check('BP: 登録フォームに「取組内容」がある', (await page.getByLabel('取組内容').count()) >= 1)
    // 必須（パートナー会社・テーマ・活動区分）未入力 → インラインエラーが出てドロワーは閉じない
    await page.getByRole('button', { name: '登録', exact: true }).click()
    await page.getByRole('alert').first().waitFor()
    check('BP: 必須未入力はインラインエラーで明示される（無反応にならない）', true)
    await page.keyboard.press('Escape')

    // ---- モバイル 375px: 案件詳細ページが崩れない ----
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto(`${BASE}/#/sales-activity/deal-0001`)
    await page.getByText(/活動ログ（/).waitFor()
    const overflow = await page.evaluate(() =>
      document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth)
    check(`モバイル 375px: 案件詳細で横スクロールが発生しない（overflow=${overflow}px）`, overflow <= 1)
  })
  summary('活動記録の案件 + 活動ログ構造')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
