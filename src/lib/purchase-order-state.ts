import { PurchaseOrderStatus, type Prisma } from '@prisma/client'

const transitions: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  DRAFT: [PurchaseOrderStatus.SENT, PurchaseOrderStatus.CANCELLED],
  SENT: [PurchaseOrderStatus.PARTIALLY_RECEIVED, PurchaseOrderStatus.RECEIVED, PurchaseOrderStatus.CANCELLED],
  PARTIALLY_RECEIVED: [PurchaseOrderStatus.RECEIVED, PurchaseOrderStatus.CLOSED, PurchaseOrderStatus.CANCELLED],
  RECEIVED: [PurchaseOrderStatus.CLOSED], CLOSED: [], CANCELLED: [],
}

export async function transitionPurchaseOrder(tx: Prisma.TransactionClient, input: { tenantId: string; id: string; to: PurchaseOrderStatus }) {
  const current = await tx.purchaseOrder.findFirst({ where: { id: input.id, tenantId: input.tenantId } })
  if (!current) throw Object.assign(new Error('PO олдсонгүй.'), { status: 404 })
  if (!transitions[current.status].includes(input.to)) throw Object.assign(new Error(`${current.status} → ${input.to} төлөв рүү шилжих боломжгүй.`), { status: 409 })
  return tx.purchaseOrder.update({ where: { id: current.id }, data: { status: input.to } })
}
