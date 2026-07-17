/** id 生成（プレフィックス + UUID。モックの決定的 id と衝突しない） */
import { randomUUID } from 'node:crypto'

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}
