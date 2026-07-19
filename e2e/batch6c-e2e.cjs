// バッチ6c E2E（API モード実クリック）: 提供システム稼働状況 F-11
// 前提: run-batch6b-stack.sh のスタックが起動済み（dev 認証 m-e2e=admin）。
// 0018 シードの 3 サービス（AKEBONO SCM ほか）が存在し、インシデントは未登録の状態から開始する。
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4174'

async function main() {
  await withPage(async (page) => {
    console.log('suite: batch6c 稼働状況（API モード）')

    // 1) 一覧: 正常バナー + シード 3 サービス + モックバッジなし
    await page.goto(`${BASE}/#/status`)
    await page.getByRole('main').getByRole('heading', { name: '提供システム稼働状況' }).waitFor()
    await page.waitForTimeout(800)
    check('稼働状況ページが表示される', true)
    check('モックアップバッジが表示されない', !(await page.getByText('モックアップ', { exact: true }).count()))
    await page.getByText('全サービスが正常に稼働しています').waitFor()
    check('正常バナー（最悪値ロールアップ = operational）', true)
    check('シードの 3 サービスが表示される',
      (await page.getByText('AKEBONO SCM', { exact: true }).count()) > 0
      && (await page.getByText('UNDEUX Sales Suite', { exact: true }).count()) > 0
      && (await page.getByText('TOKUTAKE AI Platform', { exact: true }).count()) > 0)

    // 2) 詳細: インシデント登録（管理者）
    await page.getByText('AKEBONO SCM', { exact: true }).first().click()
    await page.getByRole('main').getByRole('heading', { name: 'AKEBONO SCM' }).waitFor()
    check('サービス詳細が表示される', true)
    await page.getByRole('button', { name: 'インシデント登録' }).click()
    await page.getByRole('dialog', { name: 'インシデント登録' }).waitFor()
    await page.getByPlaceholder('例: API 応答遅延').fill('E2E: API 応答遅延')
    await page.getByLabel('影響度').selectOption('major')
    await page.getByPlaceholder('検知した事象・影響範囲・対応状況など').fill('応答時間の悪化を検知しました。')
    await page.getByRole('button', { name: '登録して通知' }).click()
    await page.getByText('インシデントを登録し、管理者へ通知しました').waitFor()
    check('インシデント登録トースト', true)
    await page.getByText('E2E: API 応答遅延').first().waitFor()
    check('インシデント履歴フィードへ即時反映', true)

    // 3) 一覧のバナーが最悪値ロールアップで変わる
    await page.goto(`${BASE}/#/status`)
    await page.getByText('一部サービスで障害が発生しています').waitFor()
    check('バナーが「一部障害」へ変化（major → partial_outage）', true)
    check('カードに対応中インシデントが表示される',
      (await page.getByText(/対応中: E2E: API 応答遅延/).count()) > 0)

    // 4) 状況更新: 正順遷移（調査中 → 原因特定）
    await page.getByText('AKEBONO SCM', { exact: true }).first().click()
    await page.getByRole('button', { name: '状況を更新' }).first().click()
    await page.getByRole('dialog', { name: 'インシデント状況更新' }).waitFor()
    await page.getByLabel('次のステータス').selectOption('identified')
    await page.getByPlaceholder('原因・対応内容・利用者への影響など').fill('DB インデックス劣化と特定。再構築を実施します。')
    await page.getByRole('button', { name: '更新して通知' }).click()
    await page.getByText('状況を更新し、管理者へ通知しました').waitFor()
    check('状況更新（調査中 → 原因特定）', true)
    check('タイムラインに原因特定が追記される',
      (await page.getByText('DB インデックス劣化と特定。再構築を実施します。').count()) > 0)

    // 5) 解決 → バナー復帰
    await page.getByRole('button', { name: '状況を更新' }).first().click()
    await page.getByRole('dialog', { name: 'インシデント状況更新' }).waitFor()
    await page.getByLabel('次のステータス').selectOption('resolved')
    await page.getByPlaceholder('原因・対応内容・利用者への影響など').fill('再構築が完了し、応答時間の回復を確認しました。')
    await page.getByRole('button', { name: '更新して通知' }).click()
    await page.getByText('解決済みとして記録し、管理者へ通知しました').waitFor()
    check('解決済みへの更新', true)
    await page.goto(`${BASE}/#/status`)
    await page.getByText('全サービスが正常に稼働しています').waitFor()
    check('解決後にバナーが正常へ復帰', true)

    // 6) リロードしても履歴が保持される（DB が SoT）+ 90 日稼働率の表示
    await page.getByText('AKEBONO SCM', { exact: true }).first().click()
    await page.getByRole('main').getByRole('heading', { name: 'AKEBONO SCM' }).waitFor()
    await page.reload()
    await page.getByText('E2E: API 応答遅延').first().waitFor()
    check('リロード後もインシデント履歴が保持される（API SoT）', true)
    check('解決済みバッジが表示される', (await page.getByText('解決済み', { exact: true }).count()) > 0)
    check('90 日稼働率が表示される', (await page.getByText('過去 90 日の稼働率').count()) > 0)
  })
  summary('batch6c-e2e')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
