import { Prisma, ReservationStatus } from '@prisma/client'
import { prisma } from './prisma.js'

type Transaction = Prisma.TransactionClient

export async function syncProductStock(tx: Transaction, tenantId: string, productId: string) {
  const total = await tx.inventoryBalance.aggregate({
    where: { tenantId, productId },
    _sum: { onHand: true },
  })
  await tx.product.updateMany({
    where: { id: productId, tenantId },
    data: { stock: total._sum.onHand ?? 0 },
  })
}

export async function releaseExpiredReservations(tenantId?: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.stockReservation.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        status: ReservationStatus.ACTIVE,
        expiresAt: { lte: new Date() },
      },
    })
    for (const row of rows) {
      const changed = await tx.stockReservation.updateMany({
        where: { id: row.id, status: ReservationStatus.ACTIVE },
        data: { status: ReservationStatus.EXPIRED },
      })
      if (!changed.count) continue
      const balance = await tx.inventoryBalance.updateMany({
        where: {
          tenantId: row.tenantId,
          warehouseId: row.warehouseId,
          productId: row.productId,
          variantId: row.variantId ?? '',
          reserved: { gte: row.quantity },
        },
        data: { reserved: { decrement: row.quantity } },
      })
      if (!balance.count) throw new Error(`Reservation ${row.id}-ийн reserved үлдэгдэл зөрсөн байна.`)
    }
    return rows.length
  }, { isolationLevel: 'Serializable' })
}
