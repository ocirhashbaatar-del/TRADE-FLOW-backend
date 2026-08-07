export type MovementPoint = { productId: string; quantity: number; unitCost?: unknown; createdAt: Date }

export function averageInventory(movements: MovementPoint[], end: Date, days: number) {
  const start = new Date(end.getTime() - days * 86400000)
  const byProduct = new Map<string, MovementPoint[]>()
  for (const row of movements) byProduct.set(row.productId, [...(byProduct.get(row.productId) ?? []), row])
  const result = new Map<string, number>()
  for (const [productId, rows] of byProduct) {
    let balance = rows.filter((row) => row.createdAt < start).reduce((sum, row) => sum + row.quantity, 0), total = 0
    const daily = rows.filter((row) => row.createdAt >= start && row.createdAt <= end).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    for (let day = 0; day < days; day += 1) { const cutoff = new Date(start.getTime() + (day + 1) * 86400000); for (const row of daily.filter((item) => item.createdAt >= new Date(cutoff.getTime() - 86400000) && item.createdAt < cutoff)) balance += row.quantity; total += balance }
    result.set(productId, total / days)
  }
  return result
}

export function ledgerValuation(movements: MovementPoint[]) {
  const state = new Map<string, { quantity: number; value: number }>()
  for (const row of [...movements].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const current = state.get(row.productId) ?? { quantity: 0, value: 0 }
    const averageCost = current.quantity > 0 ? current.value / current.quantity : Number(row.unitCost ?? 0)
    const cost = row.quantity > 0 && row.unitCost != null ? Number(row.unitCost) : averageCost
    current.quantity += row.quantity; current.value = Math.max(0, current.value + row.quantity * cost); state.set(row.productId, current)
  }
  return state
}

export const csv = (headers: string[], rows: unknown[][]) => '\uFEFF' + headers.map(escapeCsv).join(',') + '\n' + rows.map((row) => row.map(escapeCsv).join(',')).join('\n')
const escapeCsv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
