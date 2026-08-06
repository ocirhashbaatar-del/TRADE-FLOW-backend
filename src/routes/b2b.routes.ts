import crypto from 'node:crypto'
import { Router } from 'express'
import { Role } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { sendMail } from '../lib/services.js'
import { hashToken } from '../utils/auth.js'
import { audit } from '../lib/audit.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'

const router = Router()
router.use(authenticate, requireTenant)
const tid = (req: Express.Request) => req.user!.tenantId!
router.get('/customers', authorize(Role.ADMIN, Role.MANAGER), async (req, res) => res.json(await prisma.customerAccount.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: 'desc' } })))
router.post('/customers', authorize(Role.ADMIN, Role.MANAGER), async (req, res) => {
  const input = z.object({ name: z.string().min(2), registrationNo: z.string().optional(), email: z.email().optional(), phone: z.string().optional(), groupCode: z.string().optional(), creditLimit: z.number().nonnegative().default(0) }).parse(req.body)
  const row = await prisma.customerAccount.create({ data: { ...input, tenantId: tid(req) } }); await audit(req, 'CREATE', 'CustomerAccount', row.id, undefined, row); res.status(201).json(row)
})
router.post('/customers/:id/invite', authorize(Role.ADMIN, Role.MANAGER), async (req, res) => {
  const customer = await prisma.customerAccount.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } })
  if (!customer?.email) return res.status(404).json({ message: 'Имэйлтэй харилцагч олдсонгүй.' })
  const token = crypto.randomBytes(32).toString('hex')
  await prisma.customerInvitation.create({ data: { tenantId: tid(req), customerId: customer.id, email: customer.email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 7 * 86400000), invitedBy: req.user!.id } })
  void sendMail(customer.email, 'TradeFlow B2B урилга', `<p>TradeFlow B2B порталд нэгдэх урилга.</p><p>Урилгын код: <b>${token}</b></p>`)
  res.status(201).json({ message: 'Урилга илгээгдлээ.' })
})
router.post('/invitations/accept', async (req, res) => {
  const { token } = z.object({ token: z.string().min(32) }).parse(req.body)
  const invitation = await prisma.customerInvitation.findUnique({ where: { tokenHash: hashToken(token) } })
  if (!invitation || invitation.tenantId !== tid(req) || invitation.acceptedAt || invitation.expiresAt < new Date()) return res.status(400).json({ message: 'Урилга хүчингүй.' })
  await prisma.$transaction([prisma.customerAccount.update({ where: { id: invitation.customerId }, data: { userId: req.user!.id } }), prisma.customerInvitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } })])
  res.json({ message: 'B2B эрх амжилттай холбогдлоо.' })
})
router.get('/portal', async (req, res) => {
  const customer = await prisma.customerAccount.findFirst({ where: { tenantId: tid(req), userId: req.user!.id, active: true } })
  if (!customer) return res.status(403).json({ message: 'B2B харилцагчийн эрхгүй.' })
  const [invoices, orders] = await Promise.all([prisma.invoice.findMany({ where: { tenantId: tid(req), orderId: { in: (await prisma.order.findMany({ where: { tenantId: tid(req), userId: req.user!.id }, select: { id: true } })).map((o) => o.id) } } }), prisma.order.findMany({ where: { tenantId: tid(req), userId: req.user!.id }, orderBy: { createdAt: 'desc' } })])
  res.json({ customer, availableCredit: Number(customer.creditLimit) - Number(customer.creditUsed), invoices, orders })
})
export default router
