import type { Request } from 'express'
import { prisma } from './prisma.js'
import { notifyTenant } from '../socket.js'

export async function audit(req: Request, action: string, entityType: string, entityId: string, before?: unknown, after?: unknown) {
  if (!req.user?.tenantId) return
  await prisma.auditLog.create({
    data: {
      tenantId: req.user.tenantId,
      actorId: req.user.id,
      action,
      entityType,
      entityId,
      before: before as never,
      after: after as never,
      ipAddress: req.ip,
    },
  })
  const eventType = entityType === 'Order' ? 'order.updated' : entityType === 'Shipment' ? 'shipment.updated' : entityType.includes('Inventory') ? 'inventory.updated' : 'entity.updated'
  notifyTenant(req.user.tenantId, eventType, { action, entityType, entityId, actorId: req.user.id, data: after ?? before ?? null })
  ;(req as Request & { realtimeEmitted?: boolean }).realtimeEmitted = true
}
