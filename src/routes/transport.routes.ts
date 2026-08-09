import { Router } from 'express'
import { NotificationType, Role } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, requireTenant } from '../middleware/auth.js'
import { notifyUser } from '../socket.js'

const router = Router()
router.use(authenticate, requireTenant)

const registerSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(8),
  email: z.string().email().optional().or(z.literal('')).transform((value) => (value ? value : undefined)),
  address: z.string().min(4),
  city: z.string().min(2),
  district: z.string().min(2),
  note: z.string().optional(),
  items: z.array(z.object({ productId: z.string(), quantity: z.number().int().positive() })).min(1),
})

router.get('/catalog', async (req, res) => {
  const tenantId = req.user!.tenantId!
  const products = await prisma.product.findMany({
    where: { tenantId, active: true },
    include: { category: true },
    orderBy: [{ featured: 'desc' }, { name: 'asc' }],
  })

  const balances = await prisma.inventoryBalance.groupBy({
    by: ['productId'],
    where: { tenantId, productId: { in: products.map((product) => product.id) } },
    _sum: { onHand: true, reserved: true },
  })

  const result = products.map((product) => {
    const balance = balances.find((row) => row.productId === product.id)
    const onHand = Number(balance?._sum.onHand ?? 0)
    const reserved = Number(balance?._sum.reserved ?? 0)
    const availableStock = Math.max(0, (onHand > 0 || reserved > 0 ? onHand - reserved : Number(product.stock ?? 0)))
    return {
      id: product.id,
      name: product.name,
      category: product.category?.name ?? 'Бусад',
      price: Number(product.price),
      stock: availableStock,
      image: product.image,
      featured: product.featured,
      description: product.description,
    }
  })

  res.json(result)
})

router.post('/register', async (req, res) => {
  const input = registerSchema.parse(req.body)
  const tenantId = req.user!.tenantId!
  const productIds = [...new Set(input.items.map((item) => item.productId))]
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, tenantId, active: true },
    include: { category: true },
  })

  if (products.length !== productIds.length) {
    return res.status(404).json({ message: 'Зарим бараа олдсонгүй.' })
  }

  const balances = await prisma.inventoryBalance.groupBy({
    by: ['productId'],
    where: { tenantId, productId: { in: productIds } },
    _sum: { onHand: true, reserved: true },
  })

  for (const item of input.items) {
    const product = products.find((row) => row.id === item.productId)
    const balance = balances.find((row) => row.productId === item.productId)
    const onHand = Number(balance?._sum.onHand ?? 0)
    const reserved = Number(balance?._sum.reserved ?? 0)
    const availableStock = Math.max(0, (onHand > 0 || reserved > 0 ? onHand - reserved : Number(product?.stock ?? 0)))
    if (!product || availableStock < item.quantity) {
      return res.status(409).json({ message: `${product?.name ?? 'Бараа'}-ны нөөц хүрэлцэхгүй байна.` })
    }
  }

  const recipients = await prisma.user.findMany({
    where: { tenantId, role: { in: [Role.ADMIN, Role.MANAGER] } },
    select: { id: true },
  })

  const summary = input.items.map((item) => {
    const product = products.find((row) => row.id === item.productId)
    return `${product?.name ?? item.productId} × ${item.quantity}`
  }).join(', ')

  const description = `${input.name} • ${input.phone} • ${input.address}, ${input.city}/${input.district}${input.email ? ` • ${input.email}` : ''}${input.note ? ` • ${input.note}` : ''} • ${summary}`

  const notifications = await Promise.all(recipients.map((recipient) => prisma.notification.create({
    data: {
      userId: recipient.id,
      title: 'Тээвэрчийн захиалга ирлээ',
      description,
      type: NotificationType.SYSTEM,
    },
  })))

  notifications.forEach((notification) => {
    notifyUser(notification.userId, 'notification:new', notification)
  })

  res.status(201).json({ ok: true, recipients: notifications.length, summary })
})

export default router
