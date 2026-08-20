// AKEBONO Company（company/）モックモード E2E。
// ダッシュボード（オフィス → 依頼 → 承認）/ タスクボード / 活動ログ / 日次報告 /
// トークン管理（予算設定 → ブロック抑制 → リセット = 取消フロー）/ AI 社員・ロール管理 /
// モバイル幅（375px）の崩れなしを確認する。
// 実行: e2e/run-new-apps-mock.sh（ビルド + 配信 + 本スイート）
const { check, withPage, summary } = require('./lib.cjs')

const BASE = process.env.BASE ?? 'http://127.0.0.1:4181'

async function main() {
  await withPage(async (page) => {
    console.log('suite: AKEBONO Company モックモード')

    // ===== ダッシュボード =====
    await page.goto(`${BASE}/#/`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'ダッシュボード' }).waitFor()
    check('ダッシュボード: KPI カードが表示される',
      (await page.getByText('稼働中の AI 社員').count()) >= 1
      && (await page.getByText('当月トークン').count()) >= 1)
    check('ダッシュボード: AI オフィスが表示される',
      (await page.getByRole('group', { name: /AIオフィス空間/ }).count()) === 1)

    // オフィスの AI 社員クリック → ドロワー → タスク依頼 → 分解案 → 承認
    await page.getByRole('button', { name: /レン（/ }).click()
    await page.getByRole('heading', { name: 'レン（AI社員）' }).waitFor()
    check('ドロワー: AI 社員の詳細が開く', true)
    await page.getByPlaceholder('例: 競合サービスの価格調査').fill('新サービスの市場調査レポート作成')
    await page.getByRole('button', { name: '分解案を作成' }).click()
    await page.getByText('AI による分解案').waitFor()
    check('タスク依頼: 分解案が表示される', true)
    await page.getByRole('button', { name: 'この分解で承認' }).click()
    await page.getByText(/実行を開始しました/).first().waitFor()
    check('タスク依頼: 承認で実行が開始される（トースト表示）', true)
    await page.keyboard.press('Escape')

    // ===== タスクボード =====
    await page.goto(`${BASE}/#/tasks`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'タスクボード' }).waitFor()
    check('タスクボード: 4 カラム（提案中/実行中/ブロック/完了）が表示される',
      (await page.getByRole('region', { name: /のタスク/ }).count()) >= 4)
    // モックの承認は同期で全自動実行される（完了 or 質問ブロックまで走り切る）
    check('タスクボード: 依頼したタスクが表示される',
      (await page.getByText('新サービスの市場調査レポート作成').count()) >= 1)

    // ===== 活動ログ =====
    await page.goto(`${BASE}/#/activity`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: '活動ログ' }).waitFor()
    check('活動ログ: タイムラインに tokens 表記がある',
      (await page.getByText(/tokens \/ \$/).count()) >= 1)
    check('活動ログ: AI 社員フィルタがある',
      (await page.getByLabel('AI 社員で絞り込み').count()) === 1)

    // ===== 日次報告 =====
    await page.goto(`${BASE}/#/reports`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'AI 日次報告' }).waitFor()
    await page.getByRole('button', { name: 'この日の報告を生成' }).click()
    await page.getByText(/日次報告を \d+ 件生成しました/).waitFor()
    check('日次報告: 生成できる（冪等 UPSERT）', true)

    // ===== トークン管理（予算設定 → ブロック → リセット = 取消） =====
    await page.goto(`${BASE}/#/tokens`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'トークン管理' }).waitFor()
    check('トークン管理: モック境界の注記がある',
      (await page.getByText(/本実装までの暫定機能/).count()) >= 1)
    check('トークン管理: 日別チャートカードがある',
      (await page.getByText('日別トークン消費（当月）').count()) >= 1)

    // 予算を極小にして「ブロック」動作へ変更 → ダッシュボードで新規依頼がブロックされる
    await page.getByPlaceholder('例: 2000000').first().fill('1')
    await page.getByRole('radio', { name: /新規の依頼・承認をブロック/ }).check()
    await page.getByRole('button', { name: '保存' }).click()
    await page.getByText('トークン予算設定を保存しました').waitFor()
    check('トークン管理: 予算設定を保存できる', true)

    await page.goto(`${BASE}/#/`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'ダッシュボード' }).waitFor()
    check('予算超過: ダッシュボードに超過バナーが出る',
      (await page.getByRole('alert').filter({ hasText: '月間予算を超過' }).count()) === 1)
    await page.getByRole('button', { name: /アキ（/ }).click()
    await page.getByPlaceholder('例: 競合サービスの価格調査').fill('ブロック確認用の依頼')
    await page.getByRole('button', { name: '分解案を作成' }).click()
    await page.getByText(/AKC-TOK-001/).waitFor()
    check('予算超過: 新規依頼がブロックされる（AKC-TOK-001）', true)
    await page.keyboard.press('Escape')

    // 既定値へリセット（取消フロー = 原則9.5）
    await page.goto(`${BASE}/#/tokens`)
    await page.getByRole('button', { name: '既定値へリセット' }).click()
    // 確認ダイアログの確定ボタン（confirmLabel = 'リセット'）
    await page.getByRole('button', { name: 'リセット', exact: true }).click()
    await page.getByText('既定値へ戻しました').waitFor()
    check('トークン管理: 既定値へリセットできる（取消フロー）', true)

    // ===== AI 社員・ロール管理（既定ユーザー m-03 = admin） =====
    await page.goto(`${BASE}/#/employees`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'AI 社員の管理' }).waitFor()
    check('AI 社員管理: 一覧が表示される',
      (await page.locator('main table tbody tr').count()) >= 5)
    await page.goto(`${BASE}/#/roles`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'ロール設定' }).waitFor()
    check('ロール設定: 一覧が表示される',
      (await page.locator('main table tbody tr').count()) >= 4)

    // ===== モバイル幅（375px） =====
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto(`${BASE}/#/`)
    await page.getByRole('main').getByRole('heading', { level: 1, name: 'ダッシュボード' }).waitFor()
    check('モバイル: ボトムナビが表示される',
      await page.getByRole('navigation', { name: 'モバイルナビ' }).isVisible())
    check('モバイル: 横スクロールが発生しない',
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  })

  summary('company-mock-e2e')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
