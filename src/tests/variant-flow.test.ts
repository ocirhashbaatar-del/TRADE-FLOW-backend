import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { app } from '../app.js'
import { prisma } from '../lib/prisma.js'
import { signAccessToken } from '../utils/auth.js'

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const ids: Record<string, string> = {}
let token = ''

beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: `Variant ${stamp}`, slug: `variant-${stamp}` } }); ids.tenant = tenant.id
  const user = await prisma.user.create({ data: { name: 'Variant admin', email: `variant-${stamp}@test.local`, role: 'ADMIN', tenant: tenant.name, tenantId: tenant.id } }); ids.user = user.id
  const category = await prisma.category.create({ data: { name: `Variant category ${stamp}`, slug: `variant-category-${stamp}`, tenantId: tenant.id } }); ids.category = category.id
  const product = await prisma.product.create({ data: { name: 'Variant product', slug: `variant-product-${stamp}`, description: 'Variant integration product', price: 100, stock: 5, image: '/test.jpg', images: [], tags: [], tenantId: tenant.id, categoryId: category.id, vendorId: user.id } }); ids.product = product.id
  const variant = await prisma.productVariant.create({ data: { tenantId: tenant.id, productId: product.id, sku: `VAR-${stamp}`, name: 'Large', options: { size: 'L' }, price: 125 } }); ids.variant = variant.id
  const warehouse = await prisma.warehouse.create({ data: { tenantId: tenant.id, code: `WH-${stamp}`, name: 'Variant warehouse' } }); ids.warehouse = warehouse.id
  await prisma.inventoryBalance.create({ data: { tenantId: tenant.id, warehouseId: warehouse.id, productId: product.id, variantId: variant.id, onHand: 5 } })
  await prisma.stockMovement.create({ data: { tenantId: tenant.id, warehouseId: warehouse.id, productId: product.id, variantId: variant.id, type: 'ADJUSTMENT', quantity: 5, reference: 'TEST:OPENING' } })
  token = signAccessToken({ id: user.id, email: user.email, role: user.role, tenantId: tenant.id })
})

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: ids.user } }); await prisma.stockReservation.deleteMany({ where: { tenantId: ids.tenant } }); await prisma.orderItem.deleteMany({ where: { productId: ids.product } }); await prisma.order.deleteMany({ where: { tenantId: ids.tenant } }); await prisma.stockMovement.deleteMany({ where: { tenantId: ids.tenant } }); await prisma.inventoryBalance.deleteMany({ where: { tenantId: ids.tenant } }); await prisma.productVariant.deleteMany({ where: { tenantId: ids.tenant } }); await prisma.warehouse.deleteMany({ where: { tenantId: ids.tenant } }); await prisma.product.deleteMany({ where: { tenantId: ids.tenant } }); await prisma.category.deleteMany({ where: { tenantId: ids.tenant } }); await prisma.user.deleteMany({ where: { id: ids.user } }); await prisma.tenant.deleteMany({ where: { id: ids.tenant } }); await prisma.$disconnect()
})

describe('variant end-to-end flow', () => {
  it('returns variant price/stock and reserves the selected variant', async () => {
    const detail = await request(app).get(`/api/v1/products/${ids.product}?tenant=variant-${stamp}&variantId=${ids.variant}`).expect(200)
    expect(detail.body.price).toBe(125); expect(detail.body.variants[0]).toMatchObject({ id: ids.variant, stock: 5, price: 125 })
    const payload = { items: [{ productId: ids.product, variantId: ids.variant, quantity: 2 }], recipientName: 'Variant Customer', phone: '99112233', city: 'Ulaanbaatar', district: 'Sukhbaatar', address: 'Variant test address', channel: 'B2C' }
    const order = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${token}`).send(payload).expect(201)
    expect(order.body.items[0]).toMatchObject({ variantId: ids.variant, unitPrice: '125' })
    expect(await prisma.stockReservation.findFirst({ where: { orderId: order.body.id, variantId: ids.variant, quantity: 2 } })).not.toBeNull()
    expect((await prisma.inventoryBalance.findFirstOrThrow({ where: { tenantId: ids.tenant, productId: ids.product, variantId: ids.variant } })).onHand).toBe(5)
  })
})
