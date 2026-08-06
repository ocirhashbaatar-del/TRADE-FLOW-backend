import type { Prisma } from '@prisma/client'
export async function assertPeriodOpen(db: Prisma.TransactionClient, tenantId: string, date = new Date()) {
  const period = date.toISOString().slice(0, 7)
  if (await db.periodLock.findUnique({ where: { tenantId_period: { tenantId, period } } })) throw Object.assign(new Error(`${period} санхүүгийн үе хаагдсан.`), { status: 409 })
  return period
}
