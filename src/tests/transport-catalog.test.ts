import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { app } from '../app.js'
import { prisma } from '../lib/prisma.js'
import { signAccessToken } from '../utils/auth.js'

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
let tenantId = ''
let transporterId = ''
let adminId = ''
let token = ''
let productId = ''

beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: `Transport ${stamp}`, slug: `transport-${stamp}` } })
  tenantId = tenant.id
  const transporter = await prisma.user.create({ data: { name: 'Transporter', email: `transporter-${stamp}@test.local`, role: 'TRANSPORTER', tenant: tenant.name, tenantId: tenant.id } })
  transporterId = transporter.id
  const admin = await prisma.user.create({ data: { name: 'Admin', email: `admin-${stamp}@test.local`, role: 'ADMIN', tenant: tenant.name, tenantId: tenant.id } })
  adminId = admin.id
  const category = await prisma.category.create({ data: { name: `Cat ${stamp}`, slug: `cat-${stamp}`, tenantId } })
  const product = await prisma.product.create({ data: { tenantId, name: 'Transport item', slug: `transport-item-${stamp}`, description: 'Transport catalog item', price: 1000, costPrice: 700, stock: 5, image: '/test.jpg', images: [], tags: [], categoryId: category.id, vendorId: transporter.id } })
  productId = product.id
  token = signAccessToken({ id: transporter.id, email: transporter.email, role: transporter.role, tenantId: tenant.id })
}, 20000)

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: [transporterId, adminId] } } })
  await prisma.product.deleteMany({ where: { tenantId } })
  await prisma.category.deleteMany({ where: { tenantId } })
  await prisma.user.deleteMany({ where: { id: { in: [transporterId, adminId] } } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
  await prisma.$disconnect()
}, 20000)

describe('transporter catalog workflow', () => {
  it('returns transport catalog items and creates admin notification for a registration request', async () => {
    const catalog = await request(app).get('/api/v1/transport/catalog').set('Authorization', `Bearer ${token}`).expect(200)
    expect(Array.isArray(catalog.body)).toBe(true)
    expect(catalog.body.some((item: { id: string }) => item.id === productId)).toBe(true)

    const response = await request(app).post('/api/v1/transport/register').set('Authorization', `Bearer ${token}`).send({
      name: 'Хувь хүн',
      phone: '99112233',
      email: 'client@example.com',
      address: 'Сүхбаатар дүүрэг',
      city: 'Улаанбаатар',
      district: 'Сүхбаатар',
      note: 'Шуурхай хүргэлт',
      items: [{ productId, quantity: 2 }],
    }).expect(201)

    expect(response.body.ok).toBe(true)
    const notifications = await prisma.notification.findMany({ where: { userId: adminId, title: { contains: 'Тээвэрчийн захиалга' } } })
    expect(notifications.length).toBeGreaterThan(0)
  })
})
