/** チャート系列色（デザイントークン --series-1..6 と同値の固定順。循環生成禁止） */
export const SERIES_COLORS = ['#2a78d6', '#1baf7a', '#eda100', '#7a5af5', '#e2647f', '#4fb3c9'] as const

/** チャート固有色（デザイントークン同値の固定値。Chart.js は CSS 変数を解決できないため） */
export const CHART_GRID = '#eef0f2' // = --c-neutral-soft
export const CHART_MUTED_SLICE = '#c8ccd2' // 「その他」スライス（--c-line-strong 近傍の低彩度グレー）
export const CHART_TEXT = '#4b5563' // = --c-sub
export const CHART_BORDER = '#ffffff' // = --c-surface
