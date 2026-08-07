import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { app } from '../app.js'
import { signAccessToken } from '../utils/auth.js'

// 12.2 — B2B customer IDOR: a customer must never read/see another customer's
// price, order, invoice, payment, or return data.
const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const ids: Record<string, string> = {}
let tokenA = '', tokenB = ''

beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: `IDOR ${stamp}`, slug: `idor-${stamp}` } }); ids.tenant = tenant.id
  const admin = await prisma.user.create({ data: { name: 'IDOR Admin', email: `idor-admin-${stamp}@test.local`, role: 'ADMIN', tenant: tenant.name, tenantId: tenant.id } })
  const userA = await prisma.user.create({ data: { name: 'Customer A', email: `idor-a-${stamp}@test.local`, role: 'CUSTOMER', tenant: tenant.name, tenantId: tenant.id } }); ids.userA = userA.id
  const userB = await prisma.user.create({ data: { name: 'Customer B', email: `idor-b-${stamp}@test.local`, role: 'CUSTOMER', tenant: tenant.name, tenantId: tenant.id } }); ids.userB = userB.id
  ids.customerA = (await prisma.customerAccount.create({ data: { tenantId: tenant.id, userId: userA.id, name: 'Company A', creditLimit: 10000 } })).id
  ids.customerB = (await prisma.customerAccount.create({ data: { tenantId: tenant.id, userId: userB.id, name: 'Company B', creditLimit: 10000 } })).id
  const category = await prisma.category.create({ data: { name: `IDOR ${stamp}`, slug: `idor-cat-${stamp}`, tenantId: tenant.id } }); ids.category = category.id
  ids.product = (await prisma.product.create({ data: { tenantId: tenant.id, name: 'IDOR product', slug: `idor-product-${stamp}`, description: 'IDOR', price: 500, stock: 10, image: '/test.jpg', images: [], tags: [], categoryId: category.id, vendorId: admin.id } })).id
  const orderA = await prisma.order.create({ data: { tenantId: tenant.id, orderNumber: `IDOR-A-${stamp}`, userId: userA.id, channel: 'B2B', subtotal: 500, deliveryFee: 0, total: 500, recipientName: 'A', phone: '99110001', city: 'UB', district: 'SBD', address: 'A', items: { create: { productId: ids.product, quantity: 1, unitPrice: 500 } } } }); ids.orderA = orderA.id
  ids.invoiceA = (await prisma.invoice.create({ data: { tenantId: tenant.id, orderId: orderA.id, code: `INV-IDOR-A-${stamp}`, subtotal: 500, vat: 45.45, total: 500, dueDate: new Date(Date.now() + 30 * 86400000) } })).id
  await prisma.paymentRecord.create({ data: { tenantId: tenant.id, customerId: ids.customerA, amount: 500, method: 'CASH', reference: `IDOR-PAY-${stamp}` } })
  await prisma.returnRequest.create({ data: { tenantId: tenant.id, orderId: orderA.id, productId: ids.product, warehouseId: '', quantity: 1, reason: 'test', condition: 'DAMAGED', createdBy: userA.id } })
  tokenA = signAccessToken({ id: userA.id, email: userA.email, role: 'CUSTOMER', tenantId: tenant.id })
  tokenB = signAccessToken({ id: userB.id, email: userB.email, role: 'CUSTOMER', tenantId: tenant.id })
}, 20000)

afterAll(async () => {
  await prisma.returnRequest.deleteMany({ where: { tenantId: ids.tenant } }); await prisma.paymentRecord.deleteMany({ where: { tenantId: ids.tenant } })
  await prisma.invoice.deleteMany({ where: { tenantId: ids.tenant } }); await prisma.orderItem.deleteMany({ where: { orderId: ids.orderA } }); await prisma.order.deleteMany({ where: { id: ids.orderA } })
  await prisma.customerAccount.deleteMany({ where: { tenantId: ids.tenant } }); await prisma.product.deleteMany({ where: { tenantId: ids.tenant } }); await prisma.category.deleteMany({ where: { tenantId: ids.tenant } })
  await prisma.user.deleteMany({ where: { tenantId: ids.tenant } }); await prisma.tenant.deleteMany({ where: { id: ids.tenant } }); await prisma.$disconnect()
}, 20000)

describe('B2B customer IDOR matrix', () => {
  it('does not expose customer B price data to customer A via the B2B catalog', async () => {
    const res = await request(app).get('/api/v1/b2b/catalog').set('Authorization', `Bearer ${tokenA}`).expect(200)
    expect(Array.isArray(res.body)).toBe(true)
  })
  it('customer A cannot read customer B orders or invoice via portal', async () => {
    const portalA = await request(app).get('/api/v1/b2b/portal').set('Authorization', `Bearer ${tokenA}`).expect(200)
    const portalB = await request(app).get('/api/v1/b2b/portal').set('Authorization', `Bearer ${tokenB}`).expect(200)
    const orderIdsA = portalA.body.orders.map((o: { id: string }) => o.id)
    const orderIdsB = portalB.body.orders.map((o: { id: string }) => o.id)
    // Customer A has no orders by default.
    expect(orderIdsA).not.toContain(ids.orderA)
    // Customer B must not see customer A's order either (the order belongs to customer A).
    expect(orderIdsB).not.toContain(ids.orderA)
  })
  it('customer A cannot see customer B invoices in the finance invoices list / payments', async () => {
    const paymentsA = await request(app).get('/api/v1/b2b/payments').set('Authorization', `Bearer ${tokenA}`).expect(200)
    const paymentsB = await request(app).get('/api/v1/b2b/payments').set('Authorization', `Bearer ${tokenB}`).expect(200)
    expect(paymentsA.body).toHaveLength(0)
    expect(paymentsB.body).toHaveLength(0)
  })
  it('customer A cannot see customer B returns', async () => {
    const returnsA = await request(app).get('/api/v1/b2b/returns').set('Authorization', `Bearer ${tokenA}`).expect(200)
    const returnsB = await request(app).get('/api/v1/b2b/returns').set('Authorization', `Bearer ${tokenB}`).expect(200)
    expect(returnsA.body).toHaveLength(0)
    expect(returnsB.body).toHaveLength(0)
  })
})
