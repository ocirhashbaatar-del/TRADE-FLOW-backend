import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { app } from '../app.js'
import { signAccessToken } from '../utils/auth.js'

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
  it('enforces a stored RolePermission over the hardcoded fallback role', async () => {
    await prisma.rolePermission.create({ data: { tenantId: ids.tenants[0]!, role: 'VENDOR', module: 'catalog', canRead: false } })
    const token = signAccessToken({ id: ids.users[0]!, email: `vendor-${stamp}-a@test.local`, role: 'VENDOR', tenantId: ids.tenants[0]! })
    await request(app).get('/api/v1/products/manage').set('Authorization', `Bearer ${token}`).expect(403)
  })
})

describe('inventory concurrency', () => {
  it('allows exactly one of 50 reservations for the final available unit without reducing onHand', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => prisma.inventoryBalance.updateMany({ where: { tenantId: ids.tenants[0], warehouseId: ids.warehouses[0], productId: ids.products[0], variantId: '', onHand: { gte: 1 }, reserved: 0 }, data: { reserved: { increment: 1 } } })))
    expect(results.reduce((sum, row) => sum + row.count, 0)).toBe(1)
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { tenantId: ids.tenants[0], productId: ids.products[0] } })
    expect(balance.onHand).toBe(1)
    expect(balance.reserved).toBe(1)
  })
})
