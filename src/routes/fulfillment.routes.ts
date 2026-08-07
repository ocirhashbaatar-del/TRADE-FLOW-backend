import { Router } from 'express'
import { OrderStatus, ReservationStatus, Role, StockMovementType } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { audit } from '../lib/audit.js'
import { releaseExpiredReservations, syncProductStock } from '../lib/inventory.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'

const router = Router()
router.use(authenticate, requireTenant, authorize(Role.ADMIN, Role.MANAGER, Role.EMPLOYEE, Role.VENDOR, Role.TRANSPORTER))
const tenant = (req: Express.Request) => req.user!.tenantId!

router.get('/picking/:orderId', async (req, res) => {
  const tenantId = tenant(req)
  const order = await prisma.order.findFirst({ where: { id: req.params.orderId, tenantId }, include: { items: { include: { product: true } } } })
  if (!order) return res.status(404).json({ message: 'Захиалга олдсонгүй.' })
  const reservations = await prisma.stockReservation.findMany({ where: { tenantId, orderId: order.id, status: ReservationStatus.ACTIVE } })
  const lines = await Promise.all(order.items.map(async (item) => {
    const reservation = reservations.find((row) => row.productId === item.productId)
    const batches = item.product.trackBatch && reservation ? await prisma.stockBatch.findMany({ where: { tenantId, warehouseId: reservation.warehouseId, productId: item.productId, quantity: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }] }) : []
    return { orderItemId: item.id, productId: item.productId, product: item.product.name, quantity: item.quantity, warehouseId: reservation?.warehouseId, suggestedBatches: batches }
  }))
  res.json({ orderId: order.id, orderNumber: order.orderNumber, lines })
})

router.post('/shipments', async (req, res) => {
  const input = z.object({ orderId: z.string(), carrierName: z.string().optional(), trackingCode: z.string().optional(), lines: z.array(z.object({ productId: z.string(), quantity: z.number().int().positive() })).optional() }).parse(req.body)
  const tenantId = tenant(req)
  const shipment = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id: input.orderId, tenantId }, include: { items: { include: { product: true } } } })
    if (!order || [OrderStatus.CANCELLED, OrderStatus.DELIVERED, OrderStatus.SHIPPED].includes(order.status as never)) throw Object.assign(new Error('Захиалгыг бэлтгэх боломжгүй.'), { status: 409 })
    const reservations = await tx.stockReservation.findMany({ where: { tenantId, orderId: order.id, status: ReservationStatus.ACTIVE } })
    if (reservations.length !== order.items.length) throw Object.assign(new Error('Идэвхтэй нөөцлөлт бүрэн биш.'), { status: 409 })
    const requested = new Map((input.lines ?? order.items.map((item) => ({ productId: item.productId, quantity: item.quantity }))).map((line) => [line.productId, line.quantity]))
    const created = await tx.shipment.create({ data: { tenantId, orderId: order.id, warehouseId: reservations[0]!.warehouseId, status: 'SHIPPED', carrierName: input.carrierName, trackingCode: input.trackingCode, pickedBy: req.user!.id, packedAt: new Date(), shippedAt: new Date() } })
    let partial = false
    for (const item of order.items) {
      const reservation = reservations.find((row) => row.productId === item.productId)!
      const shippingQuantity = requested.get(item.productId) ?? 0
      if (shippingQuantity < 0 || shippingQuantity > reservation.quantity) throw Object.assign(new Error('Ачилтын тоо нөөцлөлтөөс хэтэрсэн.'), { status: 409 })
      if (!shippingQuantity) { partial = true; continue }
      if (shippingQuantity < reservation.quantity) partial = true
      let remaining = shippingQuantity
      if (item.product.trackBatch) {
        const batches = await tx.stockBatch.findMany({ where: { tenantId, warehouseId: reservation.warehouseId, productId: item.productId, quantity: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }] })
        for (const batch of batches) {
          if (!remaining) break
          const picked = Math.min(remaining, batch.quantity)
          await tx.stockBatch.update({ where: { id: batch.id }, data: { quantity: { decrement: picked } } })
          await tx.shipmentLine.create({ data: { tenantId, shipmentId: created.id, orderItemId: item.id, productId: item.productId, batchId: batch.id, quantity: picked } })
          remaining -= picked
        }
        if (remaining) throw Object.assign(new Error(`${item.product.name}: хүчинтэй batch хүрэлцэхгүй.`), { status: 409 })
      } else {
        await tx.shipmentLine.create({ data: { tenantId, shipmentId: created.id, orderItemId: item.id, productId: item.productId, quantity: shippingQuantity } })
      }
      const balance = await tx.inventoryBalance.updateMany({ where: { tenantId, warehouseId: reservation.warehouseId, productId: item.productId, onHand: { gte: shippingQuantity }, reserved: { gte: shippingQuantity } }, data: { onHand: { decrement: shippingQuantity }, reserved: { decrement: shippingQuantity } } })
      if (!balance.count) throw Object.assign(new Error('Агуулахын үлдэгдэл хүрэлцэхгүй.'), { status: 409 })
      await tx.stockMovement.create({ data: { tenantId, warehouseId: reservation.warehouseId, productId: item.productId, type: StockMovementType.SALE, quantity: -shippingQuantity, reference: order.orderNumber, createdBy: req.user!.id } })
      await tx.stockReservation.update({ where: { id: reservation.id }, data: shippingQuantity === reservation.quantity ? { status: ReservationStatus.COMMITTED } : { quantity: { decrement: shippingQuantity } } })
      await syncProductStock(tx, tenantId, item.productId)
    }
    await tx.order.update({ where: { id: order.id }, data: { status: partial ? OrderStatus.PROCESSING : OrderStatus.SHIPPED } })
    return created
  }, { isolationLevel: 'Serializable' })
  await audit(req, 'SHIP', 'Shipment', shipment.id, undefined, shipment)
  res.status(201).json(shipment)
})

router.post('/reservations/release-expired', async (req, res) => {
  const released = await releaseExpiredReservations(tenant(req))
  res.json({ released })
})
router.post('/returns', async (req, res) => {
  const input = z.object({ orderId: z.string(), productId: z.string(), warehouseId: z.string(), quantity: z.number().int().positive(), reason: z.string().min(3), condition: z.enum(['GOOD', 'DAMAGED', 'EXPIRED']) }).parse(req.body)
  const tenantId = tenant(req)
  const order = await prisma.order.findFirst({ where: { id: input.orderId, tenantId }, include: { items: true } })
  const line = order?.items.find((item) => item.productId === input.productId)
  if (!line || input.quantity > line.quantity) return res.status(400).json({ message: 'Буцаалтын тоо буруу.' })
  const row = await prisma.returnRequest.create({ data: { ...input, tenantId, createdBy: req.user!.id } })
  await audit(req, 'CREATE', 'ReturnRequest', row.id, undefined, row)
  res.status(201).json(row)
})
router.post('/returns/:id/approve', async (req, res) => {
  const tenantId = tenant(req), id = String(req.params.id)
  const row = await prisma.$transaction(async (tx) => {
    const request = await tx.returnRequest.findFirst({ where: { id, tenantId, status: 'REQUESTED' } })
    if (!request) throw Object.assign(new Error('Буцаалтын хүсэлт олдсонгүй.'), { status: 404 })
    const restock = request.condition === 'GOOD'
    if (restock) {
      await tx.inventoryBalance.upsert({ where: { tenantId_warehouseId_productId_variantId: { tenantId, warehouseId: request.warehouseId, productId: request.productId, variantId: '' } }, create: { tenantId, warehouseId: request.warehouseId, productId: request.productId, variantId: '', onHand: request.quantity }, update: { onHand: { increment: request.quantity } } })
    }
    await tx.stockMovement.create({ data: { tenantId, warehouseId: request.warehouseId, productId: request.productId, type: restock ? StockMovementType.RETURN : StockMovementType.DISPOSAL, quantity: restock ? request.quantity : -request.quantity, reference: `RETURN:${request.id}`, reason: request.reason, createdBy: req.user!.id } })
    if (restock) await syncProductStock(tx, tenantId, request.productId)
    return tx.returnRequest.update({ where: { id: request.id }, data: { status: 'APPROVED', restock, approvedBy: req.user!.id } })
  })
  await audit(req, 'APPROVE', 'ReturnRequest', row.id, undefined, row)
  res.json(row)
})
router.get('/returns', async (req, res) => res.json(await prisma.returnRequest.findMany({ where: { tenantId: tenant(req) }, orderBy: { createdAt: 'desc' } })))
export default router
