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

export async function applyStockMovement(tx: Transaction, input: { tenantId: string; warehouseId: string; productId: string; variantId?: string | null; batchId?: string; type: Prisma.StockMovementUncheckedCreateInput['type']; quantity: number; unitCost?: number; reference?: string; reason?: string; createdBy?: string; consumeReserved?: number; reversesId?: string }) {
  if (!input.quantity) throw new Error('Stock movement quantity 0 байж болохгүй.')
  const variantId = input.variantId ?? ''
  const existing = await tx.inventoryBalance.findUnique({ where: { tenantId_warehouseId_productId_variantId: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: input.productId, variantId } } })
  const nextOnHand = (existing?.onHand ?? 0) + input.quantity
  const nextReserved = (existing?.reserved ?? 0) - (input.consumeReserved ?? 0)
  if (nextOnHand < 0 || nextReserved < 0 || nextReserved > nextOnHand) throw Object.assign(new Error('Нөөцийн хөдөлгөөн үлдэгдэл/reservation invariant зөрчлөө.'), { status: 409 })
  const balance = await tx.inventoryBalance.upsert({
    where: { tenantId_warehouseId_productId_variantId: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: input.productId, variantId } },
    create: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: input.productId, variantId, onHand: input.quantity, reserved: 0 },
    update: { onHand: { increment: input.quantity }, ...(input.consumeReserved ? { reserved: { decrement: input.consumeReserved } } : {}) },
  })
  const movement = await tx.stockMovement.create({ data: { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: input.productId, variantId: input.variantId, batchId: input.batchId, type: input.type, quantity: input.quantity, unitCost: input.unitCost, reference: input.reference, reason: input.reason, createdBy: input.createdBy, reversesId: input.reversesId } })
  await syncProductStock(tx, input.tenantId, input.productId)
  return { balance, movement }
}

export async function reconcileInventory(tenantId?: string) {
  const movements = await prisma.stockMovement.groupBy({ by: ['tenantId', 'warehouseId', 'productId', 'variantId'], where: tenantId ? { tenantId } : {}, _sum: { quantity: true } })
  let mismatches = 0
  for (const row of movements) {
    const variantId = row.variantId ?? ''
    const balance = await prisma.inventoryBalance.findUnique({ where: { tenantId_warehouseId_productId_variantId: { tenantId: row.tenantId, warehouseId: row.warehouseId, productId: row.productId, variantId } } })
    const ledgerOnHand = row._sum.quantity ?? 0
    if ((balance?.onHand ?? 0) === ledgerOnHand) continue
    mismatches++
    await prisma.$transaction(async (tx) => {
      await tx.inventoryBalance.upsert({ where: { tenantId_warehouseId_productId_variantId: { tenantId: row.tenantId, warehouseId: row.warehouseId, productId: row.productId, variantId } }, create: { tenantId: row.tenantId, warehouseId: row.warehouseId, productId: row.productId, variantId, onHand: ledgerOnHand }, update: { onHand: ledgerOnHand } })
      await tx.auditLog.create({ data: { tenantId: row.tenantId, action: 'INVENTORY_RECONCILE', entityType: 'InventoryBalance', entityId: balance?.id ?? `${row.warehouseId}:${row.productId}:${variantId}`, before: { onHand: balance?.onHand ?? 0 }, after: { onHand: ledgerOnHand } } })
      const recipients = await tx.user.findMany({ where: { tenantId: row.tenantId, role: { in: ['ADMIN', 'MANAGER'] } }, select: { id: true } })
      await tx.notification.createMany({ data: recipients.map((user) => ({ userId: user.id, title: 'Нөөцийн зөрүү засагдлаа', description: `${row.productId}: ${balance?.onHand ?? 0} → ${ledgerOnHand}`, type: 'INVENTORY' })) })
      await syncProductStock(tx, row.tenantId, row.productId)
    })
  }
  return { checked: movements.length, mismatches }
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
      const order = await tx.order.findFirst({ where: { id: row.orderId, tenantId: row.tenantId }, select: { status: true } })
      if (order?.status !== 'PENDING') continue
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
