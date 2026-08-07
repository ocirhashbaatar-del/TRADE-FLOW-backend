import { Router } from 'express'
import { BackorderStatus, OrderStatus, ReservationStatus, Role, StockMovementType } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { audit } from '../lib/audit.js'
import { releaseExpiredReservations, syncProductStock } from '../lib/inventory.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'
import { transitionOrder } from '../lib/order-state.js'
import { assertPeriodOpen } from '../lib/period-lock.js'
import PDFDocument from 'pdfkit'

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
    const balance = reservation ? await prisma.inventoryBalance.findFirst({ where: { tenantId, warehouseId: reservation.warehouseId, productId: item.productId } }) : null
    return { orderItemId: item.id, productId: item.productId, product: item.product.name, quantity: item.quantity - item.shippedQuantity, orderedQuantity: item.quantity, shippedQuantity: item.shippedQuantity, remainingQuantity: item.quantity - item.shippedQuantity, backorderedQuantity: item.backorderedQuantity, backorderStatus: item.backorderStatus, warehouseId: reservation?.warehouseId, pickLocation: balance?.pickLocation ?? 'UNASSIGNED', suggestedBatches: batches }
  }))
  lines.sort((a, b) => a.pickLocation.localeCompare(b.pickLocation))
  res.json({ orderId: order.id, orderNumber: order.orderNumber, lines })
})

router.get('/shipments/:id/label.pdf', async (req, res) => {
  const shipment = await prisma.shipment.findFirst({ where: { id: String(req.params.id), tenantId: tenant(req) } })
  if (!shipment) return res.status(404).json({ message: 'Ачилт олдсонгүй.' })
  const [order, lines] = await Promise.all([prisma.order.findFirstOrThrow({ where: { id: shipment.orderId, tenantId: tenant(req) } }), prisma.shipmentLine.findMany({ where: { tenantId: tenant(req), shipmentId: shipment.id } })])
  const doc = new PDFDocument({ size: [288, 432], margin: 22 }), chunks: Buffer[] = []
  doc.on('data', (chunk) => chunks.push(chunk)); doc.on('end', () => res.type('application/pdf').attachment(`${order.orderNumber}-label.pdf`).send(Buffer.concat(chunks)))
  doc.fontSize(18).text('TradeFlow Shipping Label').moveDown().fontSize(12).text(`Order: ${order.orderNumber}`).text(`Recipient: ${order.recipientName}`).text(`Phone: ${order.phone}`).text(`Address: ${order.city}, ${order.district}, ${order.address}`).text(`Carrier: ${shipment.carrierName ?? '-'}`).text(`Tracking: ${shipment.trackingCode ?? '-'}`).text(`Packages/items: ${lines.reduce((sum, line) => sum + line.quantity, 0)}`); doc.end()
})
router.get('/partner-export.csv', async (req, res) => {
  const shipments = await prisma.shipment.findMany({ where: { tenantId: tenant(req), status: 'SHIPPED' }, orderBy: { createdAt: 'desc' } })
  const orders = await prisma.order.findMany({ where: { tenantId: tenant(req), id: { in: shipments.map((row) => row.orderId) } } })
  const esc = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
  res.type('text/csv').attachment('delivery-partner-export.csv').send('\uFEFFOrder,Recipient,Phone,Address,Carrier,Tracking\n' + shipments.map((shipment) => { const order = orders.find((row) => row.id === shipment.orderId); return [order?.orderNumber, order?.recipientName, order?.phone, `${order?.city}, ${order?.district}, ${order?.address}`, shipment.carrierName, shipment.trackingCode].map(esc).join(',') }).join('\n'))
})

router.post('/shipments', async (req, res) => {
  const input = z.object({ orderId: z.string(), carrierName: z.string().optional(), trackingCode: z.string().optional(), lines: z.array(z.object({ productId: z.string(), quantity: z.number().int().positive() })).optional() }).parse(req.body)
  const tenantId = tenant(req)
  const shipment = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id: input.orderId, tenantId }, include: { items: { include: { product: true } } } })
    if (!order || [OrderStatus.CANCELLED, OrderStatus.DELIVERED, OrderStatus.RETURNED, OrderStatus.SHIPPED].includes(order.status as never)) throw Object.assign(new Error('Захиалгыг бэлтгэх боломжгүй.'), { status: 409 })
    if (order.status === OrderStatus.PENDING) throw Object.assign(new Error('Төлбөргүй захиалгыг ачих боломжгүй.'), { status: 409 })
    if (order.status === OrderStatus.PAID) await transitionOrder(tx, { tenantId, orderId: order.id, to: OrderStatus.CONFIRMED, changedBy: req.user!.id, reason: 'Төлбөр баталгаажсан' })
    if (new Set<OrderStatus>([OrderStatus.PAID, OrderStatus.CONFIRMED]).has(order.status)) await transitionOrder(tx, { tenantId, orderId: order.id, to: OrderStatus.PROCESSING, changedBy: req.user!.id, reason: 'Picking эхэлсэн' })
    if (new Set<OrderStatus>([OrderStatus.PAID, OrderStatus.CONFIRMED, OrderStatus.PROCESSING]).has(order.status)) await transitionOrder(tx, { tenantId, orderId: order.id, to: OrderStatus.READY, changedBy: req.user!.id, reason: 'Ачилтад бэлэн' })
    const reservations = await tx.stockReservation.findMany({ where: { tenantId, orderId: order.id, status: ReservationStatus.ACTIVE } })
    const remainingItems = order.items.filter((item) => item.shippedQuantity < item.quantity)
    if (remainingItems.some((item) => !reservations.some((row) => row.productId === item.productId))) throw Object.assign(new Error('Үлдсэн барааны идэвхтэй нөөцлөлт бүрэн биш.'), { status: 409 })
    const requested = new Map((input.lines ?? remainingItems.map((item) => ({ productId: item.productId, quantity: item.quantity - item.shippedQuantity }))).map((line) => [line.productId, line.quantity]))
    if (!reservations[0]) throw Object.assign(new Error('Ачих нөөцлөлт олдсонгүй.'), { status: 409 })
    const created = await tx.shipment.create({ data: { tenantId, orderId: order.id, warehouseId: reservations[0]!.warehouseId, status: 'SHIPPED', carrierName: input.carrierName, trackingCode: input.trackingCode, pickedBy: req.user!.id, packedAt: new Date(), shippedAt: new Date() } })
    let totalRemaining = 0
    for (const item of remainingItems) {
      const reservation = reservations.find((row) => row.productId === item.productId)!
      const shippingQuantity = requested.get(item.productId) ?? 0
      if (shippingQuantity < 0 || shippingQuantity > reservation.quantity) throw Object.assign(new Error('Ачилтын тоо нөөцлөлтөөс хэтэрсэн.'), { status: 409 })
      if (!shippingQuantity) {
        const backorderedQuantity = item.quantity - item.shippedQuantity
        await tx.orderItem.update({ where: { id: item.id }, data: { backorderedQuantity, backorderStatus: BackorderStatus.OPEN } })
        totalRemaining += backorderedQuantity
        continue
      }
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
      await tx.stockReservation.update({ where: { id: reservation.id }, data: shippingQuantity === reservation.quantity ? { status: ReservationStatus.COMMITTED } : { quantity: { decrement: shippingQuantity }, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } })
      const shippedQuantity = item.shippedQuantity + shippingQuantity
      const backorderedQuantity = item.quantity - shippedQuantity
      await tx.orderItem.update({ where: { id: item.id }, data: { shippedQuantity, backorderedQuantity, backorderStatus: backorderedQuantity > 0 ? BackorderStatus.OPEN : item.backorderStatus === BackorderStatus.OPEN ? BackorderStatus.FULFILLED : BackorderStatus.NONE } })
      totalRemaining += backorderedQuantity
      await syncProductStock(tx, tenantId, item.productId)
    }
    await transitionOrder(tx, { tenantId, orderId: order.id, to: totalRemaining > 0 ? OrderStatus.PARTIALLY_SHIPPED : OrderStatus.SHIPPED, changedBy: req.user!.id, reason: totalRemaining > 0 ? `${totalRemaining} ширхэг backorder үлдсэн` : 'Бүх мөр ачигдсан' })
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
  const existing = line ? await prisma.returnRequest.aggregate({ where: { tenantId, orderId: input.orderId, productId: input.productId, status: { in: ['REQUESTED', 'APPROVED'] } }, _sum: { quantity: true } }) : null
  if (!line || input.quantity + Number(existing?._sum.quantity ?? 0) > line.shippedQuantity) return res.status(400).json({ message: 'Буцаалтын тоо ачуулсан хэмжээнээс хэтэрсэн.' })
  const row = await prisma.returnRequest.create({ data: { ...input, tenantId, createdBy: req.user!.id } })
  await audit(req, 'CREATE', 'ReturnRequest', row.id, undefined, row)
  res.status(201).json(row)
})
router.post('/returns/:id/approve', async (req, res) => {
  const tenantId = tenant(req), id = String(req.params.id)
  const row = await prisma.$transaction(async (tx) => {
    const request = await tx.returnRequest.findFirst({ where: { id, tenantId, status: 'REQUESTED' } })
    if (!request) throw Object.assign(new Error('Буцаалтын хүсэлт олдсонгүй.'), { status: 404 })
    const order = await tx.order.findFirst({ where: { id: request.orderId, tenantId }, include: { items: { include: { product: true } } } })
    const orderItem = order?.items.find((item) => item.productId === request.productId)
    if (!order || !orderItem || orderItem.returnedQuantity + request.quantity > orderItem.shippedQuantity) throw Object.assign(new Error('Буцаалтын хэмжээ хүчингүй.'), { status: 409 })
    await assertPeriodOpen(tx, tenantId)
    const restock = request.condition === 'GOOD'
    if (restock) {
      await tx.inventoryBalance.upsert({ where: { tenantId_warehouseId_productId_variantId: { tenantId, warehouseId: request.warehouseId, productId: request.productId, variantId: '' } }, create: { tenantId, warehouseId: request.warehouseId, productId: request.productId, variantId: '', onHand: request.quantity }, update: { onHand: { increment: request.quantity } } })
    }
    await tx.stockMovement.create({ data: { tenantId, warehouseId: request.warehouseId, productId: request.productId, type: restock ? StockMovementType.RETURN : StockMovementType.DISPOSAL, quantity: restock ? request.quantity : -request.quantity, reference: `RETURN:${request.id}`, reason: request.reason, createdBy: req.user!.id } })
    if (restock) await syncProductStock(tx, tenantId, request.productId)
    const gross = Number(orderItem.unitPrice) * request.quantity
    const vat = gross * Number(orderItem.product.vatRate) / (100 + Number(orderItem.product.vatRate))
    const invoice = await tx.invoice.findFirst({ where: { tenantId, orderId: order.id } })
    const creditNote = await tx.creditNote.create({ data: { tenantId, code: `CN-${Date.now()}-${request.id.slice(-5)}`, invoiceId: invoice?.id, orderId: order.id, returnRequestId: request.id, subtotal: gross - vat, vat, total: gross, createdBy: req.user!.id } })
    const period = creditNote.createdAt.toISOString().slice(0, 7)
    await tx.financialEntry.createMany({ data: [
      { tenantId, account: 'SALES_REVENUE', reference: creditNote.code, debit: gross - vat, period, createdBy: req.user!.id },
      { tenantId, account: 'VAT_PAYABLE', reference: creditNote.code, debit: vat, period, createdBy: req.user!.id },
      { tenantId, account: invoice ? 'ACCOUNTS_RECEIVABLE' : 'CUSTOMER_CREDIT', reference: creditNote.code, credit: gross, period, createdBy: req.user!.id },
    ] })
    if (invoice) {
      const previousCredits = await tx.creditNote.aggregate({ where: { tenantId, invoiceId: invoice.id, id: { not: creditNote.id }, status: 'ISSUED' }, _sum: { total: true } })
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: Number(previousCredits._sum.total ?? 0) + gross >= Number(invoice.total) ? 'CREDITED' : 'PARTIALLY_CREDITED' } })
    }
    if (order.channel === 'B2B') {
      const customer = await tx.customerAccount.findFirst({ where: { tenantId, userId: order.userId } })
      if (customer) await tx.customerAccount.update({ where: { id: customer.id }, data: { creditUsed: Math.max(0, Number(customer.creditUsed) - gross) } })
    }
    const updatedItem = await tx.orderItem.update({ where: { id: orderItem.id }, data: { returnedQuantity: { increment: request.quantity } } })
    const allReturned = order.items.every((item) => item.id === updatedItem.id ? updatedItem.returnedQuantity >= item.shippedQuantity && item.shippedQuantity >= item.quantity : item.returnedQuantity >= item.shippedQuantity && item.shippedQuantity >= item.quantity)
    if (allReturned && new Set<OrderStatus>([OrderStatus.SHIPPED, OrderStatus.PARTIALLY_DELIVERED, OrderStatus.DELIVERED]).has(order.status)) await transitionOrder(tx, { tenantId, orderId: order.id, to: OrderStatus.RETURNED, changedBy: req.user!.id, reason: `Credit note ${creditNote.code}` })
    return tx.returnRequest.update({ where: { id: request.id }, data: { status: 'APPROVED', restock, approvedBy: req.user!.id, creditNoteId: creditNote.id } })
  })
  await audit(req, 'APPROVE', 'ReturnRequest', row.id, undefined, row)
  res.json(row)
})
router.get('/returns', async (req, res) => res.json(await prisma.returnRequest.findMany({ where: { tenantId: tenant(req) }, orderBy: { createdAt: 'desc' } })))
export default router
