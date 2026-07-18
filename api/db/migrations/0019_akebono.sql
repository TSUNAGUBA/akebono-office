-- バッチ6d: AKEBONO（F-03）要望ボックス
-- akebono_wishes は記録系（追記のみ・巻き戻し禁止 = 原則2）。編集・削除 API は設けない。
-- 要望は実データのためシードしない（sales_monthly / service_incidents と同方針）。
-- at は JST ISO 文字列（text）= リポジトリ規約。

CREATE TABLE IF NOT EXISTS akebono_wishes (
  id        text PRIMARY KEY,
  member_id text NOT NULL REFERENCES members(id),
  body      text NOT NULL,
  at        text NOT NULL -- JST ISO
);
CREATE INDEX IF NOT EXISTS idx_akebono_wishes_at ON akebono_wishes (at DESC);
