import { Role, StockMovementType } from '@prisma/client'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { audit } from '../lib/audit.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'
import { cacheDelete } from '../lib/redis.js'
import { applyStockMovement } from '../lib/inventory.js'

const router = Router()
router.use(authenticate, requireTenant, authorize(Role.ADMIN, Role.MANAGER, Role.VENDOR))
const tid = (req: Express.Request) => req.user!.tenantId!

router.get('/categories', async (req, res) => res.json(await prisma.category.findMany({ where: { tenantId: tid(req) }, include: { _count: { select: { products: true } } }, orderBy: { name: 'asc' } })))
router.post('/categories', async (req, res) => { const input = z.object({ name: z.string().min(2), slug: z.string().regex(/^[a-z0-9-]+$/), parentId: z.string().nullable().optional(), image: z.string().nullable().optional() }).parse(req.body); if (input.parentId && !await prisma.category.findFirst({ where: { id: input.parentId, tenantId: tid(req) } })) return res.status(400).json({ message: 'Эцэг ангилал буруу.' }); const row = await prisma.category.create({ data: { ...input, tenantId: tid(req) } }); await audit(req, 'CREATE', 'Category', row.id, undefined, row); res.status(201).json(row) })
router.patch('/categories/:id', async (req, res) => { const input = z.object({ name: z.string().min(2).optional(), slug: z.string().regex(/^[a-z0-9-]+$/).optional(), parentId: z.string().nullable().optional(), image: z.string().nullable().optional() }).parse(req.body); const current = await prisma.category.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } }); if (!current) return res.status(404).json({ message: 'Ангилал олдсонгүй.' }); const row = await prisma.category.update({ where: { id: current.id }, data: input }); await audit(req, 'UPDATE', 'Category', row.id, current, row); res.json(row) })
router.delete('/categories/:id', async (req, res) => { const id = String(req.params.id); if (await prisma.product.count({ where: { categoryId: id, tenantId: tid(req) } }) || await prisma.category.count({ where: { parentId: id, tenantId: tid(req) } })) return res.status(409).json({ message: 'Дэд ангилал эсвэл бараатай ангиллыг устгахгүй.' }); await prisma.category.deleteMany({ where: { id, tenantId: tid(req) } }); res.status(204).send() })

router.get('/products/:productId/variants', async (req, res) => res.json(await prisma.productVariant.findMany({ where: { tenantId: tid(req), productId: String(req.params.productId) }, orderBy: { createdAt: 'desc' } })))
router.post('/products/:productId/variants', async (req, res) => { const input = z.object({ sku: z.string().min(1), barcode: z.string().optional(), name: z.string().min(1), options: z.record(z.string(), z.string()), price: z.coerce.number().positive().optional() }).parse(req.body); const product = await prisma.product.findFirst({ where: { id: String(req.params.productId), tenantId: tid(req) } }); if (!product) return res.status(404).json({ message: 'Бараа олдсонгүй.' }); const row = await prisma.productVariant.create({ data: { ...input, productId: product.id, tenantId: tid(req) } }); await audit(req, 'CREATE', 'ProductVariant', row.id, undefined, row); res.status(201).json(row) })
router.patch('/variants/:id', async (req, res) => { const input = z.object({ sku: z.string().min(1).optional(), barcode: z.string().nullable().optional(), name: z.string().min(1).optional(), options: z.record(z.string(), z.string()).optional(), price: z.coerce.number().positive().nullable().optional(), active: z.boolean().optional() }).parse(req.body); const current = await prisma.productVariant.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } }); if (!current) return res.status(404).json({ message: 'Хувилбар олдсонгүй.' }); res.json(await prisma.productVariant.update({ where: { id: current.id }, data: input })) })

router.get('/export.csv', async (req, res) => { const rows = await prisma.product.findMany({ where: { tenantId: tid(req) }, include: { category: true } }); const esc = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`; const header = ['name','slug','sku','barcode','category','price','costPrice','stock','unit','packSize','brand','channel','active']; res.type('text/csv').attachment('tradeflow-products.csv').send('\uFEFF' + header.join(',') + '\n' + rows.map((row) => [row.name,row.slug,row.sku,row.barcode,row.category.name,row.price,row.costPrice,row.stock,row.unit,row.packSize,row.brand,row.channel,row.active].map(esc).join(',')).join('\n')) })
router.post('/import', async (req, res) => {
  const rows = z.array(z.object({ name: z.string().min(2), slug: z.string().min(2), sku: z.string().optional(), barcode: z.string().optional(), category: z.string().min(2), price: z.coerce.number().positive(), costPrice: z.coerce.number().nonnegative().default(0), stock: z.coerce.number().int().nonnegative().default(0), unit: z.string().default('ш'), packSize: z.coerce.number().int().positive().default(1), brand: z.string().optional(), channel: z.enum(['BOTH','B2B','B2C']).default('BOTH'), active: z.coerce.boolean().default(true) })).parse(req.body)
  const tenantId = tid(req)
  const warehouse = await prisma.warehouse.findFirst({ where: { tenantId, active: true }, orderBy: { createdAt: 'asc' } })
  if (rows.some((item) => item.stock > 0) && !warehouse) return res.status(409).json({ message: 'Эхний үлдэгдэл импортлохын өмнө агуулах үүсгэнэ үү.' })
  let imported = 0
  for (const item of rows) await prisma.$transaction(async (tx) => {
    const categorySlug = item.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const category = await tx.category.upsert({ where: { tenantId_slug: { tenantId, slug: categorySlug } }, update: { name: item.category }, create: { name: item.category, slug: categorySlug, tenantId } })
    const { stock, category: _category, ...data } = item
    const product = await tx.product.upsert({ where: { tenantId_slug: { tenantId, slug: item.slug } }, update: { ...data, categoryId: category.id, tenantId }, create: { ...data, categoryId: category.id, tenantId, description: item.name, image: '/images/product-placeholder.svg', images: [], tags: [], vendorId: req.user!.id } })
    const balance = await tx.inventoryBalance.aggregate({ where: { tenantId, productId: product.id }, _sum: { onHand: true } })
    const difference = stock - Number(balance._sum.onHand ?? 0)
    if (difference && warehouse) await applyStockMovement(tx, { tenantId, warehouseId: warehouse.id, productId: product.id, type: StockMovementType.ADJUSTMENT, quantity: difference, reference: `IMPORT:${product.id}`, reason: 'Каталог импортын opening balance', createdBy: req.user!.id })
    imported++
  })
  await cacheDelete('products:*'); await audit(req, 'IMPORT', 'Product', 'bulk', undefined, { imported }); res.status(201).json({ imported })
})

export default router
