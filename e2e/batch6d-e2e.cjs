// バッチ6d E2E（API モード実クリック）: AKEBONO F-03（要望ボックス + モックバッジ全廃の確認）
// 前提: run-batch6b-stack.sh のスタックが起動済み（dev 認証 m-e2e）。
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4174'

async function main() {
  await withPage(async (page) => {
    console.log('suite: batch6d AKEBONO（API モード）')

    // 1) /akebono 表示: 業務アプリハブ（旧「要件定義中プレースホルダ + 構想ロードマップ」は業務アプリ本実装 F-20-1 で
    //    撤去済み）+ 要望ボックス + モックバッジなし（= 全廃マイルストーン）
    await page.goto(`${BASE}/#/akebono`)
    // h1 を厳密指定（{ name: 'AKEBONO' } は「AKEBONO への要望」節見出しにも部分一致し strict mode 違反になる）
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'AKEBONO 業務' }).waitFor()
    await page.waitForTimeout(800)
    check('AKEBONO ページが表示される', true)
    await page.getByRole('heading', { name: 'AKEBONO への要望' }).waitFor()
    check('要望ボックス（F-03-2）が表示される', true)
    check('モックアップバッジが表示されない（全廃マイルストーン）',
      !(await page.getByText('モックアップ', { exact: true }).count()))

    // 空入力では送信ボタンが無効（誤送信の防止 = 現行 UI。旧エラートースト方式から変更）
    check('空入力では送信ボタンが無効',
      await page.getByRole('button', { name: '送信' }).isDisabled())

    // 2) 要望の投稿 → 受付リストへ即時反映
    await page.getByRole('textbox', { name: '要望', exact: true })
      .fill('E2E: 議事録から自動でタスク化してほしい')
    await page.getByRole('button', { name: '送信' }).click()
    await page.getByText('受け付けました。要件定義の参考にします').waitFor()
    check('投稿トーストが表示される', true)
    await page.getByText('E2E: 議事録から自動でタスク化してほしい').waitFor()
    check('要望が受付リストへ即時反映される', true)
    check('投稿者名が表示される', (await page.getByText('E2E 管理者').count()) > 0)

    // 3) リロードしても保持（DB が SoT）
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
