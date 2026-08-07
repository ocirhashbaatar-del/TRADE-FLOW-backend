import crypto from 'node:crypto'
import { Router } from 'express'
import { ProductChannel, Role } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { sendMail } from '../lib/services.js'
import { hashToken } from '../utils/auth.js'
import { audit } from '../lib/audit.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'
import { resolvePrice } from '../lib/price-resolver.js'
import { tenantWhere } from '../lib/tenant-scope.js'

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
router.get('/catalog', async (req, res) => {
  const query = z.object({ q: z.string().optional(), quantity: z.coerce.number().int().positive().default(1) }).parse(req.query)
  const tenantId = tid(req)
  const customer = await prisma.customerAccount.findFirst({ where: tenantWhere(tenantId, { userId: req.user!.id, active: true }) })
  if (!customer) return res.status(403).json({ message: 'B2B харилцагчийн эрхгүй.' })
  const rows = await prisma.$transaction(async (tx) => {
    const products = await tx.product.findMany({ where: tenantWhere(tenantId, { active: true, channel: { in: [ProductChannel.BOTH, ProductChannel.B2B] }, ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}) }), include: { category: true, vendor: true }, orderBy: [{ featured: 'desc' }, { name: 'asc' }] })
    return Promise.all(products.map(async (product) => {
      const resolved = await resolvePrice(tx, { tenantId, productId: product.id, quantity: query.quantity, customerId: customer.id, groupCode: customer.groupCode ?? undefined })
      return { id: product.id, name: product.name, category: product.category.name, vendor: product.vendor.name, price: resolved.price, priceSource: resolved.source, purchaseChannel: 'B2B', compareAt: product.compareAt ? Number(product.compareAt) : undefined, rating: product.rating, reviews: product.reviewCount, stock: product.stock, image: product.image, description: product.description, featured: product.featured, tags: product.tags }
    }))
  })
  res.json(rows)
})
router.post('/quick-order', async (req, res) => {
  const input = z.object({ lines: z.array(z.object({ sku: z.string().min(1), quantity: z.number().int().positive() })).min(1) }).parse(req.body)
  const products = await prisma.product.findMany({ where: { tenantId: tid(req), sku: { in: input.lines.map((line) => line.sku) }, active: true, channel: { in: [ProductChannel.BOTH, ProductChannel.B2B] } } })
  const missing = input.lines.filter((line) => !products.some((product) => product.sku === line.sku)).map((line) => line.sku)
  res.json({ lines: input.lines.flatMap((line) => { const product = products.find((row) => row.sku === line.sku); return product ? [{ productId: product.id, sku: line.sku, name: product.name, quantity: line.quantity }] : [] }), missing })
})
router.post('/reorder/:orderId', async (req, res) => {
  const order = await prisma.order.findFirst({ where: { id: String(req.params.orderId), tenantId: tid(req), userId: req.user!.id }, include: { items: { include: { product: true } } } })
  if (!order) return res.status(404).json({ message: 'Захиалга олдсонгүй.' })
  res.json({ lines: order.items.filter((line) => line.product.active).map((line) => ({ productId: line.productId, sku: line.product.sku, name: line.product.name, quantity: line.quantity })) })
})
router.post('/csv-preview', async (req, res) => {
  const { csv } = z.object({ csv: z.string().min(3) }).parse(req.body)
  const lines = csv.split(/\r?\n/).slice(1).filter(Boolean).map((row) => { const [sku, quantity] = row.split(','); return { sku: String(sku).trim(), quantity: Number(quantity) } }).filter((line) => line.sku && Number.isInteger(line.quantity) && line.quantity > 0)
  const products = await prisma.product.findMany({ where: { tenantId: tid(req), sku: { in: lines.map((line) => line.sku) }, active: true } })
  res.json({ lines: lines.flatMap((line) => { const product = products.find((row) => row.sku === line.sku); return product ? [{ productId: product.id, name: product.name, ...line }] : [] }), errors: lines.filter((line) => !products.some((row) => row.sku === line.sku)).map((line) => `${line.sku}: бараа олдсонгүй`) })
})
router.post('/credit-approvals', async (req, res) => {
  const customer = await prisma.customerAccount.findFirst({ where: { tenantId: tid(req), userId: req.user!.id, active: true } })
  if (!customer) return res.status(403).json({ message: 'B2B эрхгүй.' })
  const input = z.object({ amount: z.number().positive(), reason: z.string().min(3).optional() }).parse(req.body)
  res.status(201).json(await prisma.creditApproval.create({ data: { tenantId: tid(req), customerId: customer.id, requestedBy: req.user!.id, ...input } }))
})
router.get('/credit-approvals', async (req, res) => {
  const staff = [Role.ADMIN, Role.MANAGER].some((role) => role === req.user!.role)
  const customer = staff ? null : await prisma.customerAccount.findFirst({ where: { tenantId: tid(req), userId: req.user!.id } })
  res.json(await prisma.creditApproval.findMany({ where: { tenantId: tid(req), ...(customer ? { customerId: customer.id } : {}) }, orderBy: { createdAt: 'desc' } }))
})
router.post('/credit-approvals/:id/approve', authorize(Role.ADMIN, Role.MANAGER), async (req, res) => {
  const result = await prisma.$transaction(async (tx) => {
    const approval = await tx.creditApproval.findFirst({ where: { id: String(req.params.id), tenantId: tid(req), status: 'PENDING' } })
    if (!approval) throw Object.assign(new Error('Хүлээгдэж буй хүсэлт олдсонгүй.'), { status: 404 })
    await tx.customerAccount.update({ where: { id: approval.customerId }, data: { creditLimit: { increment: approval.amount } } })
    return tx.creditApproval.update({ where: { id: approval.id }, data: { status: 'APPROVED', reviewedBy: req.user!.id, reviewedAt: new Date() } })
  })
  res.json(result)
})
router.get('/payments', async (req, res) => {
  const customer = await prisma.customerAccount.findFirst({ where: { tenantId: tid(req), userId: req.user!.id } })
  res.json(customer ? await prisma.paymentRecord.findMany({ where: { tenantId: tid(req), customerId: customer.id }, orderBy: { paidAt: 'desc' } }) : [])
})
router.get('/returns', async (req, res) => {
  const orderIds = (await prisma.order.findMany({ where: { tenantId: tid(req), userId: req.user!.id }, select: { id: true } })).map((row) => row.id)
  res.json(await prisma.returnRequest.findMany({ where: { tenantId: tid(req), orderId: { in: orderIds } }, orderBy: { createdAt: 'desc' } }))
})
export default router
