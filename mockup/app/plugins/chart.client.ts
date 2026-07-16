/** Chart.js 登録（undeux-sales-suite と同パターン。使用要素を明示一括登録） */
import {
  ArcElement, BarController, BarElement, CategoryScale, Chart, DoughnutController,
  Filler, Legend, LinearScale, LineController, LineElement, PointElement, Title, Tooltip,
} from 'chart.js'
import { CHART_TEXT } from '~/utils/chart-theme'

export default defineNuxtPlugin(() => {
  Chart.register(
    CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement,
    LineController, BarController, DoughnutController,
    Title, Tooltip, Legend, Filler,
  )
  Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', Meiryo, sans-serif"
  Chart.defaults.font.size = 11
  Chart.defaults.color = CHART_TEXT
})
