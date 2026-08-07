import { NotificationType, Role } from '@prisma/client'
import { prisma } from './prisma.js'

const INTERVAL_MS = 60 * 60 * 1000
const WARNING_DAYS = 30

export async function createExpiryAlerts() {
  const now = new Date(), warningDate = new Date(now.getTime() + WARNING_DAYS * 86400000)
  const batches = await prisma.stockBatch.findMany({ where: { quantity: { gt: 0 }, expiresAt: { not: null, lte: warningDate } } })
  let created = 0
  for (const batch of batches) {
    const product = await prisma.product.findFirst({ where: { id: batch.productId, tenantId: batch.tenantId, trackExpiry: true }, select: { name: true } })
    if (!product || !batch.expiresAt) continue
    const alertType = batch.expiresAt <= now ? 'EXPIRED' : 'EXPIRING_30_DAYS'
    const existing = await prisma.expiryAlert.findUnique({ where: { batchId_alertType: { batchId: batch.id, alertType } } })
    if (existing) continue
    await prisma.$transaction(async (tx) => {
      await tx.expiryAlert.create({ data: { tenantId: batch.tenantId, batchId: batch.id, alertType, expiresAt: batch.expiresAt! } })
      const recipients = await tx.user.findMany({ where: { tenantId: batch.tenantId, role: { in: [Role.ADMIN, Role.MANAGER, Role.EMPLOYEE] } }, select: { id: true } })
      await tx.notification.createMany({ data: recipients.map((user) => ({ userId: user.id, title: alertType === 'EXPIRED' ? 'Хугацаа дууссан batch' : 'Хугацаа дуусах batch', description: `${product.name} · ${batch.batchNumber} · ${batch.expiresAt!.toLocaleDateString('mn-MN')}`, type: NotificationType.INVENTORY })) })
    })
    created++
  }
  return created
}

export function startExpiryWorker() {
  let running = false
  const run = async () => { if (running) return; running = true; try { await createExpiryAlerts() } catch (error) { console.error('Expiry alert worker failed', error) } finally { running = false } }
  void run()
  const timer = setInterval(() => void run(), INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
