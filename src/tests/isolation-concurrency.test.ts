import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { app } from '../app.js'
import { signAccessToken } from '../utils/auth.js'
import { tenantContext } from '../lib/tenant-context.js'

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const ids: { tenants: string[]; users: string[]; categories: string[]; products: string[]; warehouses: string[] } = { tenants: [], users: [], categories: [], products: [], warehouses: [] }

beforeAll(async () => {
  for (const suffix of ['a', 'b']) {
    const tenant = await prisma.tenant.create({ data: { name: `Test ${suffix}`, slug: `test-${stamp}-${suffix}` } }); ids.tenants.push(tenant.id)
    const user = await prisma.user.create({ data: { name: `Vendor ${suffix}`, email: `vendor-${stamp}-${suffix}@test.local`, role: 'VENDOR', tenant: tenant.name, tenantId: tenant.id } }); ids.users.push(user.id)
    const category = await prisma.category.create({ data: { name: `Shared category ${stamp}`, slug: `shared-category-${stamp}`, tenantId: tenant.id } }); ids.categories.push(category.id)
    const product = await prisma.product.create({ data: { name: `Secret ${suffix}`, slug: `shared-product-${stamp}`, description: 'Integration test product', price: 100, stock: 1, image: '/test.jpg', images: [], tags: [], tenantId: tenant.id, categoryId: category.id, vendorId: user.id } }); ids.products.push(product.id)
    const warehouse = await prisma.warehouse.create({ data: { tenantId: tenant.id, code: `WH-${suffix}`, name: `Warehouse ${suffix}` } }); ids.warehouses.push(warehouse.id)
    await prisma.inventoryBalance.create({ data: { tenantId: tenant.id, warehouseId: warehouse.id, productId: product.id, variantId: '', onHand: 1 } })
  }
})

afterAll(async () => {
  const orderIds = (await prisma.order.findMany({ where: { tenantId: { in: ids.tenants } }, select: { id: true } })).map((row) => row.id)
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } })
  await prisma.stockReservation.deleteMany({ where: { orderId: { in: orderIds } } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } })
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
  await prisma.rolePermission.deleteMany({ where: { tenantId: { in: ids.tenants } } })
  await prisma.inventoryBalance.deleteMany({ where: { warehouseId: { in: ids.warehouses } } })
  await prisma.warehouse.deleteMany({ where: { id: { in: ids.warehouses } } })
  await prisma.product.deleteMany({ where: { id: { in: ids.products } } })
  await prisma.category.deleteMany({ where: { id: { in: ids.categories } } })
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } })
  await prisma.tenant.deleteMany({ where: { id: { in: ids.tenants } } })
  await prisma.$disconnect()
})

describe('tenant isolation', () => {
  it('storefront only returns the selected tenant catalog', async () => {
    const response = await request(app).get(`/api/v1/products?tenant=test-${stamp}-a`).expect(200)
    expect(response.body.some((row: { id: string }) => row.id === ids.products[0])).toBe(true)
    expect(response.body.some((row: { id: string }) => row.id === ids.products[1])).toBe(false)
  })
  it('does not expose a product detail through another tenant storefront', async () => {
    await request(app).get(`/api/v1/products/${ids.products[1]}?tenant=test-${stamp}-a`).expect(404)
  })
  it('does not expose cost price through public product APIs', async () => {
    const list = await request(app).get(`/api/v1/products?tenant=test-${stamp}-a`).expect(200)
    const detail = await request(app).get(`/api/v1/products/${ids.products[0]}?tenant=test-${stamp}-a`).expect(200)
    expect(list.body[0]).not.toHaveProperty('costPrice'); expect(detail.body).not.toHaveProperty('costPrice')
  })
  it('enforces a stored RolePermission over the hardcoded fallback role', async () => {
    await prisma.rolePermission.create({ data: { tenantId: ids.tenants[0]!, role: 'VENDOR', module: 'catalog', canRead: false } })
    const token = signAccessToken({ id: ids.users[0]!, email: `vendor-${stamp}-a@test.local`, role: 'VENDOR', tenantId: ids.tenants[0]! })
    await request(app).get('/api/v1/products/manage').set('Authorization', `Bearer ${token}`).expect(403)
  })
  it('scopes unique reads, updates, deletes and upserts to the active tenant', async () => {
    await tenantContext.run({ tenantId: ids.tenants[0] }, async () => {
      expect(await prisma.product.findUnique({ where: { id: ids.products[1] } })).toBeNull()
      await expect(prisma.product.update({ where: { id: ids.products[1] }, data: { name: 'Cross tenant update' } })).rejects.toMatchObject({ code: 'P2025' })
      await expect(prisma.product.delete({ where: { id: ids.products[1] } })).rejects.toMatchObject({ code: 'P2025' })
      await expect(prisma.product.upsert({ where: { id: ids.products[1]! }, update: { name: 'Cross tenant upsert' }, create: { id: ids.products[1]!, name: 'Blocked clone', slug: `blocked-${stamp}`, description: 'Blocked cross tenant clone', price: 1, stock: 0, image: '/test.jpg', images: [], tags: [], tenantId: ids.tenants[0]!, categoryId: ids.categories[0]!, vendorId: ids.users[0]! } })).rejects.toMatchObject({ code: 'P2002' })
    })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: ids.products[1] } })).name).toBe('Secret b')
  })
})

describe('inventory concurrency', () => {
  it('allows exactly one of 50 HTTP orders for the final unit and preserves physical stock', async () => {
    const token = signAccessToken({ id: ids.users[0]!, email: `vendor-${stamp}-a@test.local`, role: 'VENDOR', tenantId: ids.tenants[0]! })
    const payload = { items: [{ productId: ids.products[0], quantity: 1 }], recipientName: 'Concurrency User', phone: '99112233', city: 'Ulaanbaatar', district: 'Sukhbaatar', address: 'Test address', channel: 'B2C' }
    const responses = await Promise.all(Array.from({ length: 50 }, () => request(app).post('/api/v1/orders').set('Authorization', `Bearer ${token}`).send(payload)))
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1)
    expect(responses.filter((response) => response.status === 409)).toHaveLength(49)
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { tenantId: ids.tenants[0], productId: ids.products[0] } })
    expect(balance.onHand).toBe(1); expect(balance.reserved).toBe(1)
    const order = await prisma.order.findFirstOrThrow({ where: { tenantId: ids.tenants[0] }, include: { items: true } })
    expect(order.items[0]?.appliedPriceSource).toBe('RETAIL')
  })
})
