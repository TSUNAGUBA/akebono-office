-- 0071: 活動記録3種に改修依頼 2026-08-19 第4弾の列を追加。
--   共通: village_id（事業区分マスタ参照・任意）・links（参考リンク URL 配列 jsonb）。
--   サポート: first_contact_method（最初の問い合わせ手段）・target_location（対象箇所）。
--   営業: contact_id（担当 = 顧客(人)参照・任意）・approach_group（アプローチグループ）。
--   パートナー: partner_company_id/partner_contact_id/approach_company_id（会社/担当/アプローチ企業の
--     マスタ参照へ移行）・approach_group。旧 partner_name/related_company は下位互換のため保持（原則7）。
--
-- 追加列のみ・NULL 許容 or 既定値あり = 既存行は非破壊（原則7）。FK は任意参照（NULL 可）。
-- 冪等: ADD COLUMN IF NOT EXISTS（多重適用でも壊れない = 原則2）。
SET search_path TO app_office;

-- サポート活動
ALTER TABLE support_activities ADD COLUMN IF NOT EXISTS village_id text REFERENCES villages(id);
ALTER TABLE support_activities ADD COLUMN IF NOT EXISTS first_contact_method text NOT NULL DEFAULT '';
ALTER TABLE support_activities ADD COLUMN IF NOT EXISTS target_location text NOT NULL DEFAULT '';
ALTER TABLE support_activities ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 営業活動
ALTER TABLE sales_activities ADD COLUMN IF NOT EXISTS village_id text REFERENCES villages(id);
ALTER TABLE sales_activities ADD COLUMN IF NOT EXISTS contact_id text REFERENCES contacts(id);
ALTER TABLE sales_activities ADD COLUMN IF NOT EXISTS approach_group text NOT NULL DEFAULT '';
ALTER TABLE sales_activities ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]'::jsonb;

-- パートナー活動
ALTER TABLE partner_activities ADD COLUMN IF NOT EXISTS village_id text REFERENCES villages(id);
ALTER TABLE partner_activities ADD COLUMN IF NOT EXISTS partner_company_id text REFERENCES companies(id);
ALTER TABLE partner_activities ADD COLUMN IF NOT EXISTS partner_contact_id text REFERENCES contacts(id);
ALTER TABLE partner_activities ADD COLUMN IF NOT EXISTS approach_company_id text REFERENCES companies(id);
ALTER TABLE partner_activities ADD COLUMN IF NOT EXISTS approach_group text NOT NULL DEFAULT '';
ALTER TABLE partner_activities ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]'::jsonb;
