import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { releaseExpiredReservations } from '../lib/inventory.js'
import { resolvePrice } from '../lib/price-resolver.js'
import { postPayment } from '../lib/payment-posting.js'

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
let tenantId = '', userId = '', productId = '', warehouseId = '', orderId = '', customerId = '', invoiceId = ''

beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: `Acceptance ${stamp}`, slug: `acceptance-${stamp}` } }); tenantId = tenant.id
  const user = await prisma.user.create({ data: { name: 'Acceptance customer', email: `acceptance-${stamp}@test.local`, role: 'CUSTOMER', tenant: tenant.name, tenantId } }); userId = user.id
  const category = await prisma.category.create({ data: { name: `Acceptance ${stamp}`, slug: `acceptance-category-${stamp}`, tenantId } })
  const product = await prisma.product.create({ data: { tenantId, vendorId: userId, categoryId: category.id, name: 'Acceptance product', slug: `acceptance-product-${stamp}`, description: 'Acceptance product', price: 1000, costPrice: 600, stock: 5, image: '/test.jpg', images: [], tags: [] } }); productId = product.id
  const warehouse = await prisma.warehouse.create({ data: { tenantId, code: `ACC-${stamp.slice(-6)}`, name: 'Acceptance warehouse' } }); warehouseId = warehouse.id
  await prisma.inventoryBalance.create({ data: { tenantId, warehouseId, productId, variantId: '', onHand: 5, reserved: 1 } })
  await prisma.stockMovement.create({ data: { tenantId, warehouseId, productId, type: 'RECEIPT', quantity: 5, reference: 'OPENING', createdBy: userId } })
  const order = await prisma.order.create({ data: { tenantId, orderNumber: `ACC-${stamp}`, userId, channel: 'B2C', subtotal: 1000, deliveryFee: 0, total: 1000, recipientName: user.name, phone: '99112233', city: 'UB', district: 'SBD', address: 'Test', items: { create: { productId, quantity: 1, unitPrice: 1000, appliedPriceSource: 'RETAIL' } } } }); orderId = order.id
  await prisma.stockReservation.create({ data: { tenantId, orderId, warehouseId, productId, quantity: 1, expiresAt: new Date(Date.now() - 1000) } })
  const customer = await prisma.customerAccount.create({ data: { tenantId, userId, name: 'Acceptance LLC', creditLimit: 10000 } }); customerId = customer.id
  const invoice = await prisma.invoice.create({ data: { tenantId, orderId, code: `INV-${stamp}`, subtotal: 1000, vat: 90.91, total: 1000, dueDate: new Date(Date.now() - 40 * 86400000) } }); invoiceId = invoice.id
})

afterAll(async () => {
  await prisma.financialEntry.deleteMany({ where: { tenantId } }); await prisma.periodLock.deleteMany({ where: { tenantId } }); await prisma.paymentAllocation.deleteMany({ where: { tenantId } }); await prisma.paymentRecord.deleteMany({ where: { tenantId } }); await prisma.invoice.deleteMany({ where: { tenantId } }); await prisma.customerAccount.deleteMany({ where: { tenantId } }); await prisma.stockReservation.deleteMany({ where: { tenantId } }); await prisma.stockMovement.deleteMany({ where: { tenantId } }); await prisma.inventoryBalance.deleteMany({ where: { tenantId } }); await prisma.orderItem.deleteMany({ where: { orderId } }); await prisma.order.deleteMany({ where: { id: orderId } }); await prisma.warehouse.deleteMany({ where: { tenantId } }); await prisma.product.deleteMany({ where: { tenantId } }); await prisma.category.deleteMany({ where: { tenantId } }); await prisma.user.deleteMany({ where: { tenantId } }); await prisma.tenant.deleteMany({ where: { id: tenantId } }); await prisma.$disconnect()
})

describe('inventory and reservation invariants', () => {
  it('keeps movement ledger equal to physical onHand', async () => {
    const [movements, balance] = await Promise.all([prisma.stockMovement.aggregate({ where: { tenantId, warehouseId, productId }, _sum: { quantity: true } }), prisma.inventoryBalance.findFirstOrThrow({ where: { tenantId, warehouseId, productId } })])
    expect(movements._sum.quantity).toBe(balance.onHand)
  })
  it('releases an expired reservation exactly once without changing physical stock', async () => {
    expect(await releaseExpiredReservations(tenantId)).toBe(1); expect(await releaseExpiredReservations(tenantId)).toBe(0)
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { tenantId, warehouseId, productId } }); expect(balance.onHand).toBe(5); expect(balance.reserved).toBe(0)
  })
})

describe('pricing and finance acceptance', () => {
  it('returns the same resolver price for equivalent B2C, B2B and manual inputs', async () => {
    const values = await prisma.$transaction((tx) => Promise.all(['B2C', 'B2B', 'MANUAL'].map(() => resolvePrice(tx, { tenantId, productId, quantity: 1 }))))
    expect(new Set(values.map((row) => `${row.price}:${row.source}`)).size).toBe(1)
  })
  it('posts and allocates a replayed payment exactly once and produces correct aging balance', async () => {
    const first = await prisma.$transaction((tx) => postPayment(tx, { tenantId, customerId, amount: 400, method: 'QPAY', reference: `QPAY:${stamp}`, recordedBy: userId }))
    const replay = await prisma.$transaction((tx) => postPayment(tx, { tenantId, customerId, amount: 400, method: 'QPAY', reference: `QPAY:${stamp}`, recordedBy: userId }))
    expect(first.idempotent).toBe(false); expect(replay.idempotent).toBe(true)
    expect(await prisma.paymentRecord.count({ where: { tenantId, reference: `QPAY:${stamp}` } })).toBe(1)
    const paid = await prisma.paymentAllocation.aggregate({ where: { tenantId, invoiceId }, _sum: { amount: true } }); expect(Number(paid._sum.amount)).toBe(400); expect(1000 - Number(paid._sum.amount)).toBe(600)
  })
  it('rejects payment mutation in a locked period', async () => {
    await prisma.periodLock.create({ data: { tenantId, period: new Date().toISOString().slice(0, 7), lockedBy: userId } })
    await expect(prisma.$transaction((tx) => postPayment(tx, { tenantId, customerId, amount: 1, method: 'BANK', reference: `LOCKED:${stamp}` }))).rejects.toThrow()
  })
})
