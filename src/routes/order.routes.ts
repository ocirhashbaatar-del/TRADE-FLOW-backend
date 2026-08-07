import { Router } from 'express'
import crypto from 'node:crypto'
import { NotificationType, OrderStatus, ProductChannel, Role } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'
import { resolvePrice } from '../lib/price-resolver.js'
import { audit } from '../lib/audit.js'
import { notifyUser } from '../socket.js'
import { sendMail } from '../lib/services.js'
import { allowedOrderTransitions, transitionOrder } from '../lib/order-state.js'
import { hashToken } from '../utils/auth.js'

const router = Router()
router.use(authenticate, requireTenant)
const schema = z.object({ items: z.array(z.object({ productId: z.string(), quantity: z.number().int().positive() })).min(1), recipientName: z.string().min(2), phone: z.string().min(8), city: z.string().min(2), district: z.string().min(2), address: z.string().min(4), channel: z.enum(['B2C', 'B2B', 'MANUAL']).default('B2C'), customerId: z.string().optional(), couponCode: z.string().optional(), deliveryZoneId: z.string().optional() })

router.post('/', async (req, res) => {
  const input = schema.parse(req.body)
  const tenantId = req.user!.tenantId!
  const allowedChannels = input.channel === 'B2B' ? [ProductChannel.BOTH, ProductChannel.B2B] : input.channel === 'B2C' ? [ProductChannel.BOTH, ProductChannel.B2C] : [ProductChannel.BOTH, ProductChannel.B2B, ProductChannel.B2C]
  const products = await prisma.product.findMany({ where: { id: { in: input.items.map((item) => item.productId) }, tenantId, active: true, channel: { in: allowedChannels } } })
  if (products.length !== input.items.length) return res.status(400).json({ message: 'Зарим бүтээгдэхүүн олдсонгүй.' })
  const trackingToken = crypto.randomBytes(32).toString('hex')
  const order = await prisma.$transaction(async (tx) => {
    const requestedCustomer = input.customerId ? await tx.customerAccount.findFirst({ where: { id: input.customerId, tenantId, active: true } }) : null
    if (input.customerId && !['ADMIN', 'MANAGER', 'EMPLOYEE'].includes(req.user!.role)) throw Object.assign(new Error('Гар захиалга үүсгэх эрхгүй.'), { status: 403 })
    const customer = input.channel === 'B2B' ? requestedCustomer ?? await tx.customerAccount.findFirst({ where: { tenantId, userId: req.user!.id, active: true } }) : null
    const priced = await Promise.all(input.items.map(async (item) => ({ ...item, ...(await resolvePrice(tx, { tenantId, productId: item.productId, quantity: item.quantity, customerId: customer?.id, groupCode: customer?.groupCode ?? undefined })) })))
    const subtotal = priced.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0)
    const zone = input.deliveryZoneId ? await tx.deliveryZone.findFirst({ where: { id: input.deliveryZoneId, tenantId, active: true, city: { equals: input.city, mode: 'insensitive' }, districts: { has: input.district } } }) : null
    if (input.deliveryZoneId && !zone) throw Object.assign(new Error('Сонгосон хүргэлтийн бүс хаягтай тохирохгүй.'), { status: 400 })
    const deliveryFee = Number(zone?.fee ?? 180)
    const coupon = input.couponCode ? await tx.coupon.findFirst({ where: { tenantId, code: input.couponCode.toUpperCase(), active: true, minSubtotal: { lte: subtotal }, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] }] } }) : null
    if (input.couponCode && (!coupon || (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit))) throw Object.assign(new Error('Coupon хүчингүй эсвэл ашиглалтын хязгаар дууссан.'), { status: 400 })
    const discountAmount = coupon ? Math.min(subtotal, coupon.type === 'PERCENT' ? subtotal * Number(coupon.value) / 100 : Number(coupon.value)) : 0
    const total = subtotal - discountAmount + deliveryFee
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
    const initialStatus = input.channel === 'B2B' ? OrderStatus.CONFIRMED : OrderStatus.PENDING
    const created = await tx.order.create({ data: { orderNumber: `TF-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`, tenantId, channel: input.channel, status: initialStatus, userId: customer?.userId ?? req.user!.id, subtotal, deliveryFee, discountAmount, couponCode: coupon?.code, deliveryZoneId: zone?.id, trackingTokenHash: hashToken(trackingToken), total, recipientName: input.recipientName, phone: input.phone, city: input.city, district: input.district, address: input.address, items: { create: priced.map((item) => ({ productId: item.productId, quantity: item.quantity, unitPrice: item.price, appliedPriceSource: item.source })) } }, include: { items: { include: { product: true } } } })
    if (coupon) await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 } } })
    if (initialStatus !== OrderStatus.PENDING) await tx.orderStatusHistory.create({ data: { tenantId, orderId: created.id, fromStatus: OrderStatus.PENDING, toStatus: initialStatus, changedBy: req.user!.id, reason: 'B2B зээлийн нөхцөлөөр баталгаажсан' } })
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
  res.status(201).json({ ...order, trackingToken })
})
router.get('/', async (req, res) => {
  const staff = ['ADMIN', 'MANAGER', 'EMPLOYEE', 'TRANSPORTER', 'ACCOUNTANT'].includes(req.user!.role)
  const orders = await prisma.order.findMany({ where: { tenantId: req.user!.tenantId!, ...(staff ? {} : { userId: req.user!.id }) }, include: { items: { include: { product: true } }, statusHistory: { orderBy: { createdAt: 'asc' } } }, orderBy: { createdAt: 'desc' } })
  res.json(orders)
})
router.get('/:id', async (req, res) => {
  const staff = ['ADMIN', 'MANAGER', 'EMPLOYEE', 'TRANSPORTER', 'ACCOUNTANT'].includes(req.user!.role)
  const order = await prisma.order.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId!, ...(staff ? {} : { userId: req.user!.id }) }, include: { items: { include: { product: true } }, statusHistory: { orderBy: { createdAt: 'asc' } } } })
  order ? res.json(order) : res.status(404).json({ message: 'Захиалга олдсонгүй.' })
})
router.patch('/:id/status', authorize(Role.ADMIN, Role.MANAGER, Role.EMPLOYEE, Role.TRANSPORTER), async (req, res) => {
  const input = z.object({ status: z.nativeEnum(OrderStatus), reason: z.string().min(3).optional() }).parse(req.body)
  const row = await prisma.$transaction((tx) => transitionOrder(tx, { tenantId: req.user!.tenantId!, orderId: String(req.params.id), to: input.status, reason: input.reason, changedBy: req.user!.id }))
  await audit(req, 'UPDATE_STATUS', 'Order', row.id, undefined, { status: row.status })
  res.json({ ...row, allowedTransitions: allowedOrderTransitions(row.status) })
})
export default router
