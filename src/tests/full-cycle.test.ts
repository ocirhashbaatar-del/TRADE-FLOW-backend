import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { app } from '../app.js'
import { signAccessToken } from '../utils/auth.js'
import { applyStockMovement } from '../lib/inventory.js'
import { postPayment } from '../lib/payment-posting.js'
import { StockMovementType } from '@prisma/client'

// 12.2 — Full business cycle acceptance:
// purchase → receipt → inventory → order → shipment → invoice → payment → report.
// Asserts ledger balance == inventory balance (0-diff) through the whole cycle.
const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
let tenantId = '', userId = '', supplierId = '', categoryId = '', productId = '', warehouseId = ''
let token = ''

beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: `Cycle ${stamp}`, slug: `cycle-${stamp}` } }); tenantId = tenant.id
  const user = await prisma.user.create({ data: { name: 'Cycle Admin', email: `cycle-${stamp}@test.local`, role: 'ADMIN', tenant: tenant.name, tenantId: tenant.id } }); userId = user.id
  supplierId = (await prisma.supplier.create({ data: { registrationNo: `REG-${stamp}`, name: 'Cycle Supplier' } })).id
  categoryId = (await prisma.category.create({ data: { name: `Cycle ${stamp}`, slug: `cycle-cat-${stamp}`, tenantId: tenant.id } })).id
  productId = (await prisma.product.create({ data: { tenantId: tenant.id, name: 'Cycle product', slug: `cycle-product-${stamp}`, description: 'Cycle product', price: 500, costPrice: 300, stock: 0, image: '/test.jpg', images: [], tags: [], categoryId, vendorId: user.id } })).id
  warehouseId = (await prisma.warehouse.create({ data: { tenantId: tenant.id, code: 'CYC', name: 'Cycle warehouse' } })).id
  token = signAccessToken({ id: user.id, email: user.email, role: user.role, tenantId: tenant.id })
}, 20000)

afterAll(async () => {
  const orderIds = (await prisma.order.findMany({ where: { tenantId }, select: { id: true } })).map((r) => r.id)
  await prisma.refund.deleteMany({ where: { tenantId } }); await prisma.creditNote.deleteMany({ where: { tenantId } })
  await prisma.paymentAllocation.deleteMany({ where: { tenantId } }); await prisma.paymentRecord.deleteMany({ where: { tenantId } })
  await prisma.financialEntry.deleteMany({ where: { tenantId } }); await prisma.invoice.deleteMany({ where: { tenantId } })
  await prisma.shipmentLine.deleteMany({ where: { tenantId } }); await prisma.shipmentEvent.deleteMany({ where: { tenantId } })
  await prisma.shipment.deleteMany({ where: { tenantId } }); await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } })
  await prisma.stockReservation.deleteMany({ where: { orderId: { in: orderIds } } }); await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } })
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } }); await prisma.stockMovement.deleteMany({ where: { tenantId } })
  await prisma.inventoryBalance.deleteMany({ where: { tenantId } }); await prisma.goodsReceiptLine.deleteMany({ where: { tenantId } })
  await prisma.goodsReceipt.deleteMany({ where: { tenantId } }); await prisma.purchaseOrderLine.deleteMany({ where: { tenantId } })
  await prisma.purchaseOrder.deleteMany({ where: { tenantId } }); await prisma.product.deleteMany({ where: { tenantId } })
  await prisma.warehouse.deleteMany({ where: { tenantId } }); await prisma.category.deleteMany({ where: { tenantId } })
  await prisma.supplier.deleteMany({ where: { id: supplierId } }); await prisma.user.deleteMany({ where: { id: userId } }); await prisma.tenant.deleteMany({ where: { id: tenantId } })
  await prisma.$disconnect()
}, 20000)

describe('full purchase→receipt→inventory→order→shipment→invoice→payment→report cycle', () => {
  it('runs the whole cycle and keeps ledger == inventory with 0 diff', async () => {
    // 1. Purchase order + line (purchase-order model has no `lines` relation, create separately)
    const po = await prisma.purchaseOrder.create({ data: { tenantId, code: `PO-${stamp}`, supplierId, warehouseId, status: 'SENT', createdBy: userId } })
    const poLine = await prisma.purchaseOrderLine.create({ data: { tenantId, purchaseOrderId: po.id, productId, orderedQty: 10, unitCost: 300 } })
    // 2. Goods receipt + line
    const receipt = await prisma.goodsReceipt.create({ data: { tenantId, code: `GR-${stamp}`, purchaseOrderId: po.id, supplierId, warehouseId, receivedBy: userId } })
    await prisma.goodsReceiptLine.create({ data: { tenantId, goodsReceiptId: receipt.id, purchaseOrderLineId: poLine.id, productId, expectedQuantity: 10, receivedQuantity: 10, acceptedQuantity: 10, discrepancyQuantity: 0, unitCost: 300 } })
    expect(receipt.id).toBeTruthy()
    // 3. Inventory movement (receipt)
    await prisma.$transaction((tx) => applyStockMovement(tx, { tenantId, warehouseId, productId, type: StockMovementType.RECEIPT, quantity: 10, unitCost: 300, reference: receipt.code, createdBy: userId }))
    // 4. Order (reservation)
    const order = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${token}`).send({ items: [{ productId, quantity: 3 }], recipientName: 'Cycle Customer', phone: '99112233', city: 'Ulaanbaatar', district: 'Sukhbaatar', address: 'Cycle address', channel: 'B2C' }).expect(201)
    expect(order.body.items[0].appliedPriceSource).toBe('RETAIL')
    // 5. Shipment (SALE movement consumes reservation)
    const shipment = await prisma.$transaction(async (tx) => {
      const reservation = await tx.stockReservation.findFirstOrThrow({ where: { tenantId, orderId: order.body.id } })
      const created = await tx.shipment.create({ data: { tenantId, orderId: order.body.id, warehouseId, status: 'SHIPPED', pickedBy: userId, packedAt: new Date(), shippedAt: new Date() } })
      await tx.shipmentLine.create({ data: { tenantId, shipmentId: created.id, orderItemId: order.body.items[0].id, productId, quantity: 3 } })
      await tx.shipmentEvent.create({ data: { tenantId, shipmentId: created.id, status: 'SHIPPED', createdBy: userId } })
      await applyStockMovement(tx, { tenantId, warehouseId: reservation.warehouseId, productId, type: StockMovementType.SALE, quantity: -3, consumeReserved: 3, reference: order.body.orderNumber, createdBy: userId })
      await tx.stockReservation.update({ where: { id: reservation.id }, data: { status: 'COMMITTED' } })
      await tx.order.update({ where: { id: order.body.id }, data: { status: 'SHIPPED' } })
      return created
    }, { isolationLevel: 'Serializable' })
    expect(shipment.id).toBeTruthy()
    // 6. Invoice
    const invoice = await prisma.invoice.create({ data: { tenantId, orderId: order.body.id, code: `INV-${stamp}`, subtotal: 1500, vat: 136.36, total: 1500, dueDate: new Date(Date.now() + 30 * 86400000) } })
    // 7. Payment
    const payment = await prisma.$transaction((tx) => postPayment(tx, { tenantId, customerId: order.body.userId, amount: 1500, method: 'CASH', reference: `CASH:${stamp}`, recordedBy: userId }))
    expect(payment.idempotent).toBe(false)
    // 8. Report / reconciliation
    const [movements, balance] = await Promise.all([
      prisma.stockMovement.aggregate({ where: { tenantId, warehouseId, productId }, _sum: { quantity: true } }),
      prisma.inventoryBalance.findFirstOrThrow({ where: { tenantId, warehouseId, productId } }),
    ])
    // receipt +10, sale -3 => ledger 7 == onHand 7 => 0-diff
    expect(movements._sum.quantity).toBe(7); expect(balance.onHand).toBe(7); expect(Number(movements._sum.quantity)).toBe(Number(balance.onHand))
    const allocated = await prisma.paymentAllocation.aggregate({ where: { tenantId, invoiceId: invoice.id }, _sum: { amount: true } })
    expect(Number(allocated._sum.amount)).toBe(1500)
    const report = await request(app).get('/api/v1/reports/operations?days=30').set('Authorization', `Bearer ${token}`).expect(200)
    expect(Array.isArray(report.body.inventoryTurnover)).toBe(true)
  })
})
