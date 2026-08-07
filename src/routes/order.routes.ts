import { Router } from 'express'
import crypto from 'node:crypto'
import { NotificationType, ProductChannel } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, requireTenant } from '../middleware/auth.js'
import { resolvePrice } from '../lib/price-resolver.js'
import { audit } from '../lib/audit.js'
import { notifyUser } from '../socket.js'
import { sendMail } from '../lib/services.js'

const router = Router()
router.use(authenticate, requireTenant)
const schema = z.object({ items: z.array(z.object({ productId: z.string(), quantity: z.number().int().positive() })).min(1), recipientName: z.string().min(2), phone: z.string().min(8), city: z.string().min(2), district: z.string().min(2), address: z.string().min(4), channel: z.enum(['B2C', 'B2B', 'MANUAL']).default('B2C'), customerId: z.string().optional() })

router.post('/', async (req, res) => {
  const input = schema.parse(req.body)
  const tenantId = req.user!.tenantId!
  const allowedChannels = input.channel === 'B2B' ? [ProductChannel.BOTH, ProductChannel.B2B] : input.channel === 'B2C' ? [ProductChannel.BOTH, ProductChannel.B2C] : [ProductChannel.BOTH, ProductChannel.B2B, ProductChannel.B2C]
  const products = await prisma.product.findMany({ where: { id: { in: input.items.map((item) => item.productId) }, tenantId, active: true, channel: { in: allowedChannels } } })
  if (products.length !== input.items.length) return res.status(400).json({ message: 'Зарим бүтээгдэхүүн олдсонгүй.' })
  const deliveryFee = 180
  const order = await prisma.$transaction(async (tx) => {
    const requestedCustomer = input.customerId ? await tx.customerAccount.findFirst({ where: { id: input.customerId, tenantId, active: true } }) : null
    if (input.customerId && !['ADMIN', 'MANAGER', 'EMPLOYEE'].includes(req.user!.role)) throw Object.assign(new Error('Гар захиалга үүсгэх эрхгүй.'), { status: 403 })
    const customer = input.channel === 'B2B' ? requestedCustomer ?? await tx.customerAccount.findFirst({ where: { tenantId, userId: req.user!.id, active: true } }) : null
    const priced = await Promise.all(input.items.map(async (item) => ({ ...item, ...(await resolvePrice(tx, { tenantId, productId: item.productId, quantity: item.quantity, customerId: customer?.id, groupCode: customer?.groupCode ?? undefined })) })))
    const subtotal = priced.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0)
    const total = subtotal + deliveryFee
    if (input.channel === 'B2B' && (!customer || Number(customer.creditUsed) + total > Number(customer.creditLimit))) throw Object.assign(new Error('B2B зээлийн хязгаар хүрэлцэхгүй.'), { status: 409 })
    const reservations: Array<{ productId: string; warehouseId: string; quantity: number }> = []
    for (const item of priced) {
      const balances = await tx.inventoryBalance.findMany({ where: { tenantId, productId: item.productId }, orderBy: { updatedAt: 'asc' } })
      const balance = balances.find((row) => row.onHand - row.reserved >= item.quantity)
      if (!balance) throw Object.assign(new Error('Үлдэгдэл хүрэлцэхгүй эсвэл өөр захиалгад нөөцлөгдсөн.'), { status: 409 })
      const claimed = await tx.inventoryBalance.updateMany({
        where: { id: balance.id, tenantId, reserved: balance.reserved, onHand: { gte: balance.reserved + item.quantity } },
        data: { reserved: { increment: item.quantity } },
      })
      if (claimed.count !== 1) throw Object.assign(new Error('Үлдэгдлийг өөр захиалга түрүүлж нөөцөлсөн байна. Дахин оролдоно уу.'), { status: 409 })
      reservations.push({ productId: item.productId, warehouseId: balance.warehouseId, quantity: item.quantity })
    }
    const created = await tx.order.create({ data: { orderNumber: `TF-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`, tenantId, channel: input.channel, userId: customer?.userId ?? req.user!.id, subtotal, deliveryFee, total, recipientName: input.recipientName, phone: input.phone, city: input.city, district: input.district, address: input.address, items: { create: priced.map((item) => ({ productId: item.productId, quantity: item.quantity, unitPrice: item.price })) } }, include: { items: { include: { product: true } } } })
    if (customer) await tx.customerAccount.update({ where: { id: customer.id }, data: { creditUsed: { increment: total } } })
    for (const reservation of reservations) {
      await tx.stockReservation.create({ data: { tenantId, orderId: created.id, ...reservation, expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) } })
    }
    return created
  }, { isolationLevel: 'Serializable' })
  await audit(req, 'CREATE', 'Order', order.id, undefined, order)
  const notification = await prisma.notification.create({ data: { userId: req.user!.id, title: 'Захиалга баталгаажлаа', description: `${order.orderNumber} захиалгыг хүлээн авлаа.`, type: NotificationType.ORDER } })
  notifyUser(req.user!.id, 'notification:new', notification)
  void sendMail(req.user!.email, 'Захиалга баталгаажлаа', `<h2>${order.orderNumber}</h2><p>Таны захиалгыг амжилттай хүлээн авлаа.</p>`)
  res.status(201).json(order)
})
router.get('/', async (req, res) => {
  const staff = ['ADMIN', 'MANAGER', 'EMPLOYEE', 'TRANSPORTER', 'ACCOUNTANT'].includes(req.user!.role)
  const orders = await prisma.order.findMany({ where: { tenantId: req.user!.tenantId!, ...(staff ? {} : { userId: req.user!.id }) }, include: { items: { include: { product: true } } }, orderBy: { createdAt: 'desc' } })
  res.json(orders)
})
router.get('/:id', async (req, res) => {
  const order = await prisma.order.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId!, ...(req.user!.role === 'ADMIN' ? {} : { userId: req.user!.id }) }, include: { items: { include: { product: true } } } })
  order ? res.json(order) : res.status(404).json({ message: 'Захиалга олдсонгүй.' })
})
export default router
