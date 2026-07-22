// バッチ6d E2E（API モード実クリック）: AKEBONO F-03（要望ボックス + モックバッジ全廃の確認）
// F-20-1（業務アプリハブ化）後の画面に追随済み: h1 は「AKEBONO 業務」、要望ボックスは残置（F-03-2）、
// 空入力は送信ボタンの無効化で防止（エラーメッセージ方式から仕様変更）。
// 前提: run-batch6b-stack.sh のスタックが起動済み（dev 認証 m-e2e = admin）。
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4174'

async function main() {
  await withPage(async (page) => {
    console.log('suite: batch6d AKEBONO（API モード）')

    // 1) /akebono 表示: 業務アプリハブ + 要望ボックス + モックバッジなし（= 全廃マイルストーン）
    await page.goto(`${BASE}/#/akebono`)
    await page.getByRole('main').getByRole('heading', { name: 'AKEBONO 業務' }).waitFor()
    await page.waitForTimeout(800)
    check('AKEBONO ページ（業務アプリハブ）が表示される', true)
    await page.getByRole('heading', { name: 'AKEBONO への要望' }).waitFor()
    check('要望ボックス（F-03-2）が表示される', true)
    check('管理者ツールが表示される（admin）',
      (await page.getByText('管理者ツール').count()) > 0
      && (await page.getByText('共通マスタ管理').count()) > 0)
    check('モックアップバッジが表示されない（全廃マイルストーン）',
      !(await page.getByText('モックアップ', { exact: true }).count()))

    // 2) 要望の投稿 → 受付リストへ即時反映
    await page.getByPlaceholder('例）在庫のロット管理をしたい')
      .fill('E2E: 議事録から自動でタスク化してほしい')
    await page.getByRole('button', { name: '送信' }).click()
    await page.getByText('受け付けました。要件定義の参考にします').waitFor()
    check('投稿トーストが表示される', true)
    await page.getByText('E2E: 議事録から自動でタスク化してほしい').waitFor()
    check('要望が受付リストへ即時反映される', true)
    check('投稿者名が表示される', (await page.getByText('E2E 管理者').count()) > 0)

    // 3) 空入力は送信ボタンの無効化で防止（投稿成功後は入力欄がクリアされ無効に戻る）
    check('空入力では送信できない（ボタン無効化）',
      await page.getByRole('button', { name: '送信' }).isDisabled())

    // 4) リロードしても保持（DB が SoT）
    await page.reload()
    await page.getByText('E2E: 議事録から自動でタスク化してほしい').waitFor()
    check('リロード後も要望が保持される（API SoT）', true)

    // 5) 他ページにもモックバッジが残っていない（/sales・/status は 6b/6c で解除済みの回帰確認）
    for (const path of ['/sales', '/status']) {
      await page.goto(`${BASE}/#${path}`)
      await page.waitForTimeout(600)
      check(`${path} にモックアップバッジなし`, !(await page.getByText('モックアップ', { exact: true }).count()))
    }
  })
  summary('batch6d-e2e')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
