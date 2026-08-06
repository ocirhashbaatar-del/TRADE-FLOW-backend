import { Router } from 'express'
import { Role } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { resolvePrice } from '../lib/price-resolver.js'
import { audit } from '../lib/audit.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'
import { cacheDelete } from '../lib/redis.js'

const router = Router()
router.use(authenticate, requireTenant)
const manage = authorize(Role.ADMIN, Role.MANAGER)
const tenant = (req: Express.Request) => req.user!.tenantId!
router.get('/rules', async (req, res) => res.json(await prisma.priceRule.findMany({ where: { tenantId: tenant(req) }, orderBy: [{ productId: 'asc' }, { priority: 'desc' }] })))
router.patch('/products/:id', manage, async (req, res) => {
  const input = z.object({ price: z.coerce.number().positive(), compareAt: z.coerce.number().positive().nullable().optional(), costPrice: z.coerce.number().nonnegative().optional() }).parse(req.body)
  const before = await prisma.product.findFirst({ where: { id: String(req.params.id), tenantId: tenant(req) } })
  if (!before) return res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' })
  const row = await prisma.product.update({ where: { id: before.id }, data: input })
  await prisma.priceHistory.create({ data: { tenantId: tenant(req), productId: row.id, oldPrice: before.price, newPrice: row.price, source: 'BASE_PRICE', changedBy: req.user!.id } })
  await cacheDelete('products:*')
  await audit(req, 'UPDATE', 'ProductPrice', row.id, before, row)
  res.json(row)
})
router.post('/rules', manage, async (req, res) => {
  const input = z.object({ productId: z.string(), customerId: z.string().optional(), groupCode: z.string().optional(), minQuantity: z.number().int().positive().default(1), price: z.number().positive(), startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional(), priority: z.number().int().default(0) }).parse(req.body)
  const product = await prisma.product.findFirst({ where: { id: input.productId, tenantId: tenant(req) } })
  if (!product) return res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' })
  const row = await prisma.priceRule.create({ data: { ...input, tenantId: tenant(req) } })
  await prisma.priceHistory.create({ data: { tenantId: tenant(req), productId: row.productId, ruleId: row.id, newPrice: row.price, source: row.customerId ? 'CONTRACT' : row.groupCode ? 'GROUP' : 'TIER', changedBy: req.user!.id } })
  await audit(req, 'CREATE', 'PriceRule', row.id, undefined, row)
  res.status(201).json(row)
})
router.patch('/rules/:id', manage, async (req, res) => {
  const input = z.object({ price: z.number().positive().optional(), minQuantity: z.number().int().positive().optional(), active: z.boolean().optional(), priority: z.number().int().optional(), startsAt: z.coerce.date().nullable().optional(), endsAt: z.coerce.date().nullable().optional() }).parse(req.body)
  const before = await prisma.priceRule.findFirst({ where: { id: String(req.params.id), tenantId: tenant(req) } })
  if (!before) return res.status(404).json({ message: 'Үнийн дүрэм олдсонгүй.' })
  const row = await prisma.priceRule.update({ where: { id: before.id }, data: input })
  if (input.price) await prisma.priceHistory.create({ data: { tenantId: tenant(req), productId: row.productId, ruleId: row.id, oldPrice: before.price, newPrice: row.price, source: 'RULE_UPDATE', changedBy: req.user!.id } })
  await audit(req, 'UPDATE', 'PriceRule', row.id, before, row)
  res.json(row)
})
router.delete('/rules/:id', manage, async (req, res) => { const row = await prisma.priceRule.findFirst({ where: { id: String(req.params.id), tenantId: tenant(req) } }); if (!row) return res.status(404).json({ message: 'Үнийн дүрэм олдсонгүй.' }); await prisma.priceRule.delete({ where: { id: row.id } }); await audit(req, 'DELETE', 'PriceRule', row.id, row, undefined); res.status(204).send() })
router.get('/promotions', async (req, res) => res.json(await prisma.promotion.findMany({ where: { tenantId: tenant(req) }, orderBy: { startsAt: 'desc' } })))
router.post('/promotions', manage, async (req, res) => {
  const input = z.object({ code: z.string().optional(), name: z.string().min(2), productId: z.string().optional(), categoryId: z.string().optional(), discountPct: z.number().positive().max(100).optional(), discountAmt: z.number().positive().optional(), minQuantity: z.number().int().positive().default(1), startsAt: z.coerce.date(), endsAt: z.coerce.date() }).refine((v) => Boolean(v.productId || v.categoryId), 'Product эсвэл category шаардлагатай').refine((v) => Boolean(v.discountPct || v.discountAmt), 'Хямдрал шаардлагатай').parse(req.body)
  const row = await prisma.promotion.create({ data: { ...input, tenantId: tenant(req) } })
  await audit(req, 'CREATE', 'Promotion', row.id, undefined, row)
  res.status(201).json(row)
})
router.patch('/promotions/:id', manage, async (req, res) => {
  const input = z.object({ code: z.string().nullable().optional(), name: z.string().min(2).optional(), productId: z.string().nullable().optional(), categoryId: z.string().nullable().optional(), discountPct: z.coerce.number().positive().max(100).nullable().optional(), discountAmt: z.coerce.number().positive().nullable().optional(), minQuantity: z.coerce.number().int().positive().optional(), startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional(), active: z.boolean().optional() }).parse(req.body)
  const before = await prisma.promotion.findFirst({ where: { id: String(req.params.id), tenantId: tenant(req) } })
  if (!before) return res.status(404).json({ message: 'Урамшуулал олдсонгүй.' })
  const row = await prisma.promotion.update({ where: { id: before.id }, data: input })
  await audit(req, 'UPDATE', 'Promotion', row.id, before, row)
  res.json(row)
})
router.delete('/promotions/:id', manage, async (req, res) => { const row = await prisma.promotion.findFirst({ where: { id: String(req.params.id), tenantId: tenant(req) } }); if (!row) return res.status(404).json({ message: 'Урамшуулал олдсонгүй.' }); await prisma.promotion.delete({ where: { id: row.id } }); await audit(req, 'DELETE', 'Promotion', row.id, row, undefined); res.status(204).send() })
router.post('/resolve', async (req, res) => {
  const input = z.object({ productId: z.string(), quantity: z.number().int().positive(), customerId: z.string().optional(), groupCode: z.string().optional() }).parse(req.body)
  res.json(await prisma.$transaction((tx) => resolvePrice(tx, { ...input, tenantId: tenant(req) })))
})
router.get('/history', async (req, res) => res.json(await prisma.priceHistory.findMany({ where: { tenantId: tenant(req) }, orderBy: { createdAt: 'desc' }, take: 200 })))
export default router
