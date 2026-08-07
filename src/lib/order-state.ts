import { OrderStatus, type Prisma } from '@prisma/client'

const transitions: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: [OrderStatus.PAID, OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  PAID: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  CONFIRMED: [OrderStatus.PROCESSING, OrderStatus.READY, OrderStatus.CANCELLED],
  PROCESSING: [OrderStatus.READY, OrderStatus.PARTIALLY_SHIPPED, OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  READY: [OrderStatus.PARTIALLY_SHIPPED, OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  PARTIALLY_SHIPPED: [OrderStatus.PARTIALLY_SHIPPED, OrderStatus.SHIPPED, OrderStatus.PARTIALLY_DELIVERED, OrderStatus.CANCELLED],
  SHIPPED: [OrderStatus.PARTIALLY_DELIVERED, OrderStatus.DELIVERED, OrderStatus.RETURNED],
  PARTIALLY_DELIVERED: [OrderStatus.DELIVERED, OrderStatus.RETURNED],
  DELIVERED: [OrderStatus.RETURNED],
  RETURNED: [],
  CANCELLED: [],
}

export const allowedOrderTransitions = (status: OrderStatus) => transitions[status]

export async function transitionOrder(tx: Prisma.TransactionClient, input: { tenantId: string; orderId: string; to: OrderStatus; changedBy?: string; reason?: string }) {
  const order = await tx.order.findFirst({ where: { id: input.orderId, tenantId: input.tenantId } })
  if (!order) throw Object.assign(new Error('Захиалга олдсонгүй.'), { status: 404 })
  if (order.status === input.to) return order
  if (!transitions[order.status].includes(input.to)) throw Object.assign(new Error(`${order.status} → ${input.to} төлөвт шилжих боломжгүй.`), { status: 409 })
  if (input.to === OrderStatus.CANCELLED) {
    const reservations = await tx.stockReservation.findMany({ where: { tenantId: input.tenantId, orderId: order.id, status: 'ACTIVE' } })
    for (const reservation of reservations) {
      await tx.inventoryBalance.updateMany({ where: { tenantId: input.tenantId, warehouseId: reservation.warehouseId, productId: reservation.productId, variantId: reservation.variantId ?? '', reserved: { gte: reservation.quantity } }, data: { reserved: { decrement: reservation.quantity } } })
      await tx.stockReservation.update({ where: { id: reservation.id }, data: { status: 'RELEASED' } })
    }
    await tx.orderItem.updateMany({ where: { orderId: order.id, backorderStatus: 'OPEN' }, data: { backorderStatus: 'CANCELLED' } })
  }
  const updated = await tx.order.update({ where: { id: order.id }, data: { status: input.to } })
  await tx.orderStatusHistory.create({ data: { tenantId: input.tenantId, orderId: order.id, fromStatus: order.status, toStatus: input.to, changedBy: input.changedBy, reason: input.reason } })
  return updated
}
