import { OrderStatus, Role } from '@prisma/client'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { audit } from '../lib/audit.js'
import { authenticate, authorize, authorizeEmails, requireTenant } from '../middleware/auth.js'

const router = Router()
router.use(authenticate, requireTenant, authorize(Role.TRANSPORTER), authorizeEmails('gardi@gmail.com'))

router.get('/', async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { tenantId: req.user!.tenantId!, status: { not: OrderStatus.CANCELLED } },
    include: { items: { include: { product: true } } },
    orderBy: { createdAt: 'desc' },
  })
  res.json(orders)
})

router.patch('/:id/status', async (req, res) => {
  const { status } = z.object({ status: z.enum(['PROCESSING', 'SHIPPED', 'DELIVERED']) }).parse(req.body)
  const order = await prisma.order.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId! } })
  if (!order) return res.status(404).json({ message: 'Захиалга олдсонгүй.' })
  const updated = await prisma.order.update({ where: { id: order.id }, data: { status } })
  await audit(req, 'UPDATE_STATUS', 'Order', order.id, { status: order.status }, { status: updated.status })
  res.json(updated)
})

export default router
