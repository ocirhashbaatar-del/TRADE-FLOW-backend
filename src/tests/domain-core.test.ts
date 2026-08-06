import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { resolvePrice } from '../lib/price-resolver.js'
import { assertPeriodOpen } from '../lib/period-lock.js'

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
let tenantId = '', userId = '', categoryId = '', productId = '', warehouseId = ''
beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: `Domain ${stamp}`, slug: `domain-${stamp}` } }); tenantId = tenant.id
  const user = await prisma.user.create({ data: { name: 'Domain Admin', email: `domain-${stamp}@test.local`, role: 'ADMIN', tenant: tenant.name, tenantId } }); userId = user.id
  const category = await prisma.category.create({ data: { name: `Domain ${stamp}`, slug: `domain-category-${stamp}`, tenantId } }); categoryId = category.id
  const product = await prisma.product.create({ data: { tenantId, name: 'Price product', slug: `price-${stamp}`, description: 'Domain test', price: 1000, stock: 10, image: '/test.jpg', images: [], tags: [], categoryId, vendorId: userId, trackBatch: true } }); productId = product.id
  warehouseId = (await prisma.warehouse.create({ data: { tenantId, code: 'TEST', name: 'Test warehouse' } })).id
})
afterAll(async () => {
  await prisma.periodLock.deleteMany({ where: { tenantId } }); await prisma.priceHistory.deleteMany({ where: { tenantId } }); await prisma.promotion.deleteMany({ where: { tenantId } }); await prisma.priceRule.deleteMany({ where: { tenantId } }); await prisma.stockBatch.deleteMany({ where: { tenantId } }); await prisma.warehouse.deleteMany({ where: { tenantId } }); await prisma.product.deleteMany({ where: { tenantId } }); await prisma.category.deleteMany({ where: { tenantId } }); await prisma.user.deleteMany({ where: { tenantId } }); await prisma.tenant.deleteMany({ where: { id: tenantId } }); await prisma.$disconnect()
})
describe('price resolver', () => {
  it('uses contract price and then applies active promotion', async () => {
    await prisma.priceRule.create({ data: { tenantId, productId, customerId: userId, minQuantity: 1, price: 800, priority: 100 } })
    await prisma.promotion.create({ data: { tenantId, productId, name: '10 percent', discountPct: 10, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 60000) } })
    const result = await prisma.$transaction((tx) => resolvePrice(tx, { tenantId, productId, customerId: userId, quantity: 1 }))
    expect(result.price).toBe(720); expect(result.source.startsWith('PROMOTION:')).toBe(true)
  })
})
describe('FEFO eligibility', () => {
  it('excludes expired batches and orders valid batches by earliest expiry', async () => {
    await prisma.stockBatch.createMany({ data: [{ tenantId, warehouseId, productId, batchNumber: 'EXPIRED', expiresAt: new Date(Date.now() - 86400000), quantity: 5 }, { tenantId, warehouseId, productId, batchNumber: 'LATE', expiresAt: new Date(Date.now() + 10 * 86400000), quantity: 5 }, { tenantId, warehouseId, productId, batchNumber: 'EARLY', expiresAt: new Date(Date.now() + 86400000), quantity: 5 }] })
    const rows = await prisma.stockBatch.findMany({ where: { tenantId, productId, quantity: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: { expiresAt: 'asc' } })
    expect(rows.map((r) => r.batchNumber)).toEqual(['EARLY', 'LATE'])
  })
})
describe('period lock', () => {
  it('rejects financial writes in a locked month', async () => {
    const period = new Date().toISOString().slice(0, 7)
    await prisma.periodLock.create({ data: { tenantId, period, lockedBy: userId } })
    await expect(prisma.$transaction((tx) => assertPeriodOpen(tx, tenantId))).rejects.toThrow('санхүүгийн үе хаагдсан')
  })
})
