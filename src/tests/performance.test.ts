import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
let tenantId = '', userId = '', categoryId = '', warehouseId = ''
beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: `Perf ${stamp}`, slug: `perf-${stamp}` } }); tenantId = tenant.id
  userId = (await prisma.user.create({ data: { name: 'Perf vendor', email: `perf-${stamp}@test.local`, role: 'VENDOR', tenant: tenant.name, tenantId } })).id
  categoryId = (await prisma.category.create({ data: { name: `Perf ${stamp}`, slug: `perf-category-${stamp}`, tenantId } })).id
  warehouseId = (await prisma.warehouse.create({ data: { tenantId, code: 'PERF', name: 'Performance warehouse' } })).id
  await prisma.product.createMany({ data: Array.from({ length: 10000 }, (_, i) => ({ tenantId, vendorId: userId, categoryId, name: `SKU ${i}`, slug: `perf-${stamp}-${i}`, sku: `PERF-${stamp}-${i}`, description: 'Performance test', price: 100, stock: i % 100, image: '/test.jpg', images: [], tags: [] })) })
  const products = await prisma.product.findMany({ where: { tenantId }, select: { id: true, stock: true } })
  await prisma.inventoryBalance.createMany({ data: products.map((p) => ({ tenantId, warehouseId, productId: p.id, variantId: '', onHand: p.stock })) })
}, 60000)
afterAll(async () => {
  await prisma.inventoryBalance.deleteMany({ where: { tenantId } }); await prisma.product.deleteMany({ where: { tenantId } }); await prisma.warehouse.deleteMany({ where: { tenantId } }); await prisma.category.deleteMany({ where: { tenantId } }); await prisma.user.deleteMany({ where: { tenantId } }); await prisma.tenant.deleteMany({ where: { id: tenantId } }); await prisma.$disconnect()
}, 60000)
describe('10,000 SKU inventory report', () => {
  it('returns the tenant inventory under three seconds', async () => {
    const start = performance.now()
    const rows = await prisma.inventoryBalance.findMany({ where: { tenantId }, select: { productId: true, onHand: true, reserved: true } })
    const duration = performance.now() - start
    expect(rows).toHaveLength(10000); expect(duration).toBeLessThan(3000)
  })
})
