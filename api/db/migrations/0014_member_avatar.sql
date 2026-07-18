-- バッチ5e: プロフィール画像（オペレーター指示 2026-07-17）
-- 本人が /profile で登録する小さな data:image/... URI（クライアントで 256px へ縮小済み）。
-- 空文字 = 未設定（イニシャル表示）
ALTER TABLE members ADD COLUMN IF NOT EXISTS avatar text NOT NULL DEFAULT '';
