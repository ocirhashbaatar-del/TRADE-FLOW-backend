import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { app } from '../app.js'

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const ids: { tenants: string[]; users: string[]; categories: string[]; products: string[] } = { tenants: [], users: [], categories: [], products: [] }

beforeAll(async () => {
  for (const suffix of ['a', 'b']) {
    const tenant = await prisma.tenant.create({ data: { name: `Test ${suffix}`, slug: `test-${stamp}-${suffix}` } }); ids.tenants.push(tenant.id)
    const user = await prisma.user.create({ data: { name: `Vendor ${suffix}`, email: `vendor-${stamp}-${suffix}@test.local`, role: 'VENDOR', tenant: tenant.name, tenantId: tenant.id } }); ids.users.push(user.id)
    const category = await prisma.category.create({ data: { name: `Category ${stamp} ${suffix}`, slug: `category-${stamp}-${suffix}`, tenantId: tenant.id } }); ids.categories.push(category.id)
    const product = await prisma.product.create({ data: { name: `Secret ${suffix}`, slug: `secret-${stamp}-${suffix}`, description: 'Integration test product', price: 100, stock: 1, image: '/test.jpg', images: [], tags: [], tenantId: tenant.id, categoryId: category.id, vendorId: user.id } }); ids.products.push(product.id)
  }
})

afterAll(async () => {
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
})

describe('inventory concurrency', () => {
  it('allows exactly one of 50 claims for the final unit', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => prisma.product.updateMany({ where: { id: ids.products[0], tenantId: ids.tenants[0], stock: { gte: 1 } }, data: { stock: { decrement: 1 } } })))
    expect(results.reduce((sum, row) => sum + row.count, 0)).toBe(1)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: ids.products[0] } })).stock).toBe(0)
  })
})
