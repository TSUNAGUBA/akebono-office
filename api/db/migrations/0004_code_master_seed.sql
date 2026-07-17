-- 汎用区分マスタの初期データ（役職・文書タグ・会社規模）。
-- メンバー登録の役職選択肢・顧客マスタの会社規模等はここを参照する。
-- mockup のシード（mockup/app/data/seed/core.ts seedCodeMaster）と同一内容。
-- 再実行・運用中の適用に安全: 既存 id はスキップ（ON CONFLICT DO NOTHING）し、
-- 画面から編集済みの行を上書きしない（記録・設定データの保護 = 開発原則2）。
INSERT INTO code_masters (id, category, code, label, display_order) VALUES
  ('cm-05', 'title', 'ceo', '代表取締役', 1),
  ('cm-06', 'title', 'director', '取締役', 2),
  ('cm-07', 'title', 'manager', 'マネージャー', 3),
  ('cm-08', 'title', 'leader', 'リーダー', 4),
  ('cm-09', 'title', 'staff', 'メンバー', 5),
  ('cm-10', 'title', 'assistant', 'アシスタント', 6),
  ('cm-11', 'title', 'partner', 'パートナー', 7),
  ('cm-12', 'documentTag', 'rule', '規程', 1),
  ('cm-13', 'documentTag', 'minutes', '議事録', 2),
  ('cm-14', 'documentTag', 'proposal', '提案書', 3),
  ('cm-15', 'documentTag', 'design', '設計書', 4),
  ('cm-16', 'documentTag', 'manual', 'マニュアル', 5),
  ('cm-17', 'companySize', 's', '50名未満', 1),
  ('cm-18', 'companySize', 'm', '50-100名', 2),
  ('cm-19', 'companySize', 'l', '100-300名', 3),
  ('cm-20', 'companySize', 'xl', '300-1000名', 4),
  ('cm-21', 'companySize', 'xxl', '1000名以上', 5)
ON CONFLICT (id) DO NOTHING;
