import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { assertPeriodOpen } from '../lib/period-lock.js'
import { postPayment } from '../lib/payment-posting.js'
import { StockMovementType } from '@prisma/client'
import { applyStockMovement } from '../lib/inventory.js'

// 12.2 — Locked-period: every financial mutation is rejected once the month is locked.
const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
let tenantId = '', userId = '', productId = '', warehouseId = '', customerId = '', orderId = '', invoiceId = ''

beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: `Locked ${stamp}`, slug: `locked-${stamp}` } }); tenantId = tenant.id
  const user = await prisma.user.create({ data: { name: 'Locked Admin', email: `locked-${stamp}@test.local`, role: 'ADMIN', tenant: tenant.name, tenantId } }); userId = user.id
  const category = await prisma.category.create({ data: { name: `Locked ${stamp}`, slug: `locked-cat-${stamp}`, tenantId } })
  productId = (await prisma.product.create({ data: { tenantId, name: 'Locked product', slug: `locked-product-${stamp}`, description: 'Locked product', price: 100, stock: 0, image: '/test.jpg', images: [], tags: [], categoryId: category.id, vendorId: userId } })).id
  warehouseId = (await prisma.warehouse.create({ data: { tenantId, code: 'LCK', name: 'Locked warehouse' } })).id
  await prisma.inventoryBalance.create({ data: { tenantId, warehouseId, productId, variantId: '', onHand: 10 } })
  await prisma.stockMovement.create({ data: { tenantId, warehouseId, productId, type: 'RECEIPT', quantity: 10, reference: 'OPENING', createdBy: userId } })
  const order = await prisma.order.create({ data: { tenantId, orderNumber: `LCK-${stamp}`, userId, channel: 'B2C', subtotal: 100, deliveryFee: 0, total: 100, recipientName: 'Locked', phone: '99112233', city: 'UB', district: 'SBD', address: 'Test', items: { create: { productId, quantity: 1, unitPrice: 100 } } } }); orderId = order.id
  const customer = await prisma.customerAccount.create({ data: { tenantId, userId, name: 'Locked LLC', creditLimit: 1000 } }); customerId = customer.id
  invoiceId = (await prisma.invoice.create({ data: { tenantId, orderId, code: `INV-LCK-${stamp}`, subtotal: 100, vat: 9.09, total: 100, dueDate: new Date(Date.now() + 30 * 86400000) } })).id
})

afterAll(async () => {
  await prisma.financialEntry.deleteMany({ where: { tenantId } }); await prisma.periodLock.deleteMany({ where: { tenantId } })
  await prisma.paymentAllocation.deleteMany({ where: { tenantId } }); await prisma.paymentRecord.deleteMany({ where: { tenantId } })
  await prisma.invoice.deleteMany({ where: { tenantId } }); await prisma.customerAccount.deleteMany({ where: { tenantId } })
  await prisma.stockReservation.deleteMany({ where: { tenantId } }); await prisma.stockMovement.deleteMany({ where: { tenantId } })
  await prisma.inventoryBalance.deleteMany({ where: { tenantId } }); await prisma.orderItem.deleteMany({ where: { orderId } }); await prisma.order.deleteMany({ where: { id: orderId } })
  await prisma.warehouse.deleteMany({ where: { tenantId } }); await prisma.product.deleteMany({ where: { tenantId } }); await prisma.category.deleteMany({ where: { tenantId } })
  await prisma.user.deleteMany({ where: { tenantId } }); await prisma.tenant.deleteMany({ where: { id: tenantId } }); await prisma.$disconnect()
})

describe('locked-period financial mutation matrix', () => {
  it('rejects payment posting, invoice creation, ledger reversal and new invoice in a locked month', async () => {
    const period = new Date().toISOString().slice(0, 7)
    await prisma.periodLock.create({ data: { tenantId, period, lockedBy: userId } })
    // invoice creation
    await expect(prisma.$transaction(async (tx) => { await assertPeriodOpen(tx, tenantId); return tx.invoice.create({ data: { tenantId, orderId, code: `INV-LCK2-${stamp}`, subtotal: 100, vat: 9.09, total: 100 } }) })).rejects.toThrow()
    // payment posting
    await expect(prisma.$transaction((tx) => postPayment(tx, { tenantId, customerId, amount: 100, method: 'CASH', reference: `LOCKED-CASH-${stamp}`, recordedBy: userId }))).rejects.toThrow()
    // financial entry (direct) — must not be possible outside the service; assertPeriodOpen gate
    await expect(prisma.$transaction(async (tx) => { await assertPeriodOpen(tx, tenantId); return tx.financialEntry.create({ data: { tenantId, account: 'BANK', reference: 'LOCKED', debit: 100, period, createdBy: userId } }) })).rejects.toThrow()
    // ledger reversal
    await expect(prisma.$transaction(async (tx) => { await assertPeriodOpen(tx, tenantId); return tx.financialEntry.create({ data: { tenantId, account: 'BANK', reference: 'LOCKED-REV', credit: 100, period, kind: 'REVERSAL', createdBy: userId } }) })).rejects.toThrow()
  })
  it('still allows non-financial inventory movement after period lock (no double-charge)', async () => {
    // Inventory is not a financial mutation; it must remain allowed after a period lock.
    const result = await prisma.$transaction((tx) => applyStockMovement(tx, { tenantId, warehouseId, productId, type: StockMovementType.RECEIPT, quantity: 1, reference: 'AFTER-LOCK', createdBy: userId }))
    expect(result.movement.quantity).toBe(1)
  })
})
