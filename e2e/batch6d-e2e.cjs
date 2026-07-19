// バッチ6d E2E（API モード実クリック）: AKEBONO F-03（要望ボックス + モックバッジ全廃の確認）
// 前提: run-batch6b-stack.sh のスタックが起動済み（dev 認証 m-e2e）。
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4174'

async function main() {
  await withPage(async (page) => {
    console.log('suite: batch6d AKEBONO（API モード）')

    // 1) /akebono 表示: プレースホルダ + ロードマップ + モックバッジなし（= 全廃マイルストーン）
    await page.goto(`${BASE}/#/akebono`)
    await page.getByRole('main').getByRole('heading', { name: 'AKEBONO' }).waitFor()
    await page.waitForTimeout(800)
    check('AKEBONO ページが表示される', true)
    await page.getByText('AKEBONO は要件定義中です').waitFor()
    check('要件定義中バナーが表示される', true)
    check('構想ロードマップが表示される',
      (await page.getByText('構想ロードマップ').count()) > 0
      && (await page.getByText('プロトタイプ開発').count()) > 0)
    check('モックアップバッジが表示されない（全廃マイルストーン）',
      !(await page.getByText('モックアップ', { exact: true }).count()))

    // 2) 要望の投稿 → 受付リストへ即時反映
    await page.getByPlaceholder('例: 過去の提案書から勝ちパターンを提示してほしい')
      .fill('E2E: 議事録から自動でタスク化してほしい')
    await page.getByRole('button', { name: '送信' }).click()
    await page.getByText('受け付けました。要件定義の参考にします').waitFor()
    check('投稿トーストが表示される', true)
    await page.getByText('E2E: 議事録から自動でタスク化してほしい').waitFor()
    check('要望が受付リストへ即時反映される', true)
    check('投稿者名が表示される', (await page.getByText('E2E 管理者').count()) > 0)

    // 3) 空入力はエラー表示
    await page.getByRole('button', { name: '送信' }).click()
    await page.getByText('要望を入力してください').waitFor()
    check('空入力のエラーが表示される', true)

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
