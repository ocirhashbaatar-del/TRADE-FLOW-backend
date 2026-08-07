import { Role, StockMovementType } from '@prisma/client'
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { audit } from '../lib/audit.js'
import { mapCatalogRows, parseCatalogFile } from '../lib/catalog-import.js'
import { applyStockMovement } from '../lib/inventory.js'
import { prisma } from '../lib/prisma.js'
import { cacheDelete } from '../lib/redis.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'

const router = Router()
router.use(authenticate, requireTenant, authorize(Role.ADMIN, Role.MANAGER, Role.VENDOR))
const tid = (req: Express.Request) => req.user!.tenantId!
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
const importRowSchema = z.object({ name: z.string().min(2), slug: z.string().min(2), sku: z.string().optional(), barcode: z.string().optional(), category: z.string().min(2), price: z.coerce.number().positive(), costPrice: z.coerce.number().nonnegative().default(0), stock: z.coerce.number().int().nonnegative().default(0), unit: z.string().default('ш'), packSize: z.coerce.number().int().positive().default(1), brand: z.string().optional(), channel: z.enum(['BOTH', 'B2B', 'B2C']).default('BOTH'), active: z.union([z.boolean(), z.enum(['true', 'false', 'TRUE', 'FALSE', '1', '0']).transform((value) => ['true', 'TRUE', '1'].includes(value))]).default(true) })

async function createsCategoryCycle(tenantId: string, id: string, parentId?: string | null) {
  let cursor = parentId
  const visited = new Set([id])
  while (cursor) {
    if (visited.has(cursor)) return true
    visited.add(cursor)
    cursor = (await prisma.category.findFirst({ where: { id: cursor, tenantId }, select: { parentId: true } }))?.parentId
  }
  return false
}

router.get('/categories', async (req, res) => res.json(await prisma.category.findMany({ where: { tenantId: tid(req) }, include: { _count: { select: { products: true } } }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })))
router.post('/categories', async (req, res) => {
  const input = z.object({ name: z.string().min(2), slug: z.string().regex(/^[a-z0-9-]+$/), parentId: z.string().nullable().optional(), image: z.string().nullable().optional(), sortOrder: z.number().int().nonnegative().default(0) }).parse(req.body)
  if (input.parentId && !await prisma.category.findFirst({ where: { id: input.parentId, tenantId: tid(req) } })) return res.status(400).json({ message: 'Эцэг ангилал буруу.' })
  const row = await prisma.category.create({ data: { ...input, tenantId: tid(req) } }); await audit(req, 'CREATE', 'Category', row.id, undefined, row); res.status(201).json(row)
})
router.patch('/categories/:id', async (req, res) => {
  const input = z.object({ name: z.string().min(2).optional(), slug: z.string().regex(/^[a-z0-9-]+$/).optional(), parentId: z.string().nullable().optional(), image: z.string().nullable().optional(), sortOrder: z.number().int().nonnegative().optional() }).parse(req.body)
  const tenantId = tid(req), id = String(req.params.id), current = await prisma.category.findFirst({ where: { id, tenantId } })
  if (!current) return res.status(404).json({ message: 'Ангилал олдсонгүй.' })
  if (input.parentId !== undefined && await createsCategoryCycle(tenantId, id, input.parentId)) return res.status(409).json({ message: 'Ангиллыг өөрийн дэд ангилал руу зөөж болохгүй.' })
  const row = await prisma.category.update({ where: { id }, data: input }); await audit(req, 'UPDATE', 'Category', row.id, current, row); res.json(row)
})
router.put('/categories/reorder', async (req, res) => {
  const input = z.array(z.object({ id: z.string(), parentId: z.string().nullable(), sortOrder: z.number().int().nonnegative() })).parse(req.body), tenantId = tid(req)
  for (const row of input) if (await createsCategoryCycle(tenantId, row.id, row.parentId)) return res.status(409).json({ message: 'Ангиллын модонд цикл үүсэх тул хадгалсангүй.' })
  await prisma.$transaction(input.map((row) => prisma.category.updateMany({ where: { id: row.id, tenantId }, data: { parentId: row.parentId, sortOrder: row.sortOrder } })))
  await audit(req, 'REORDER', 'Category', 'tree', undefined, input); res.json({ updated: input.length })
})
router.delete('/categories/:id', async (req, res) => { const id = String(req.params.id); if (await prisma.product.count({ where: { categoryId: id, tenantId: tid(req) } }) || await prisma.category.count({ where: { parentId: id, tenantId: tid(req) } })) return res.status(409).json({ message: 'Дэд ангилал эсвэл бараатай ангиллыг устгахгүй.' }); await prisma.category.deleteMany({ where: { id, tenantId: tid(req) } }); res.status(204).send() })

router.get('/products/:productId/variants', async (req, res) => res.json(await prisma.productVariant.findMany({ where: { tenantId: tid(req), productId: String(req.params.productId) }, orderBy: { createdAt: 'desc' } })))
router.post('/products/:productId/variants', async (req, res) => { const input = z.object({ sku: z.string().min(1), barcode: z.string().optional(), name: z.string().min(1), options: z.record(z.string(), z.string()), price: z.coerce.number().positive().optional() }).parse(req.body); const product = await prisma.product.findFirst({ where: { id: String(req.params.productId), tenantId: tid(req) } }); if (!product) return res.status(404).json({ message: 'Бараа олдсонгүй.' }); const row = await prisma.productVariant.create({ data: { ...input, productId: product.id, tenantId: tid(req) } }); await audit(req, 'CREATE', 'ProductVariant', row.id, undefined, row); res.status(201).json(row) })
router.patch('/variants/:id', async (req, res) => { const input = z.object({ sku: z.string().min(1).optional(), barcode: z.string().nullable().optional(), name: z.string().min(1).optional(), options: z.record(z.string(), z.string()).optional(), price: z.coerce.number().positive().nullable().optional(), active: z.boolean().optional() }).parse(req.body); const current = await prisma.productVariant.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } }); if (!current) return res.status(404).json({ message: 'Хувилбар олдсонгүй.' }); res.json(await prisma.productVariant.update({ where: { id: current.id }, data: input })) })
router.get('/barcode/:code', async (req, res) => { const tenantId = tid(req), code = String(req.params.code).trim(), variant = await prisma.productVariant.findFirst({ where: { tenantId, barcode: code, active: true } }); const product = await prisma.product.findFirst({ where: { tenantId, active: true, OR: [{ barcode: code }, ...(variant ? [{ id: variant.productId }] : [])] } }); if (!product) return res.status(404).json({ message: 'Энэ barcode-тай бараа олдсонгүй.' }); res.json({ product, variant }) })

router.get('/products/:productId/images', async (req, res) => res.json(await prisma.productImage.findMany({ where: { tenantId: tid(req), productId: String(req.params.productId) }, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] })))
router.post('/products/:productId/images', async (req, res) => {
  const input = z.object({ url: z.string().url(), publicId: z.string().optional(), alt: z.string().optional(), isPrimary: z.boolean().default(false) }).parse(req.body), tenantId = tid(req), productId = String(req.params.productId)
  if (!await prisma.product.findFirst({ where: { id: productId, tenantId } })) return res.status(404).json({ message: 'Бараа олдсонгүй.' })
  const row = await prisma.$transaction(async (tx) => { if (input.isPrimary) await tx.productImage.updateMany({ where: { tenantId, productId }, data: { isPrimary: false } }); const count = await tx.productImage.count({ where: { tenantId, productId } }); const image = await tx.productImage.create({ data: { ...input, tenantId, productId, sortOrder: count, isPrimary: input.isPrimary || count === 0 } }); if (image.isPrimary) await tx.product.update({ where: { id: productId }, data: { image: image.url } }); return image })
  await audit(req, 'CREATE', 'ProductImage', row.id, undefined, row); res.status(201).json(row)
})
router.put('/products/:productId/images/reorder', async (req, res) => {
  const tenantId = tid(req), productId = String(req.params.productId), input = z.object({ imageIds: z.array(z.string()).min(1), primaryId: z.string() }).parse(req.body)
  if (!input.imageIds.includes(input.primaryId)) return res.status(400).json({ message: 'Үндсэн зураг жагсаалтад байх ёстой.' })
  await prisma.$transaction(async (tx) => { const images = await tx.productImage.findMany({ where: { tenantId, productId, id: { in: input.imageIds } } }); if (images.length !== input.imageIds.length) throw Object.assign(new Error('Зургийн жагсаалт буруу.'), { status: 400 }); await tx.productImage.updateMany({ where: { tenantId, productId }, data: { isPrimary: false } }); for (const [sortOrder, id] of input.imageIds.entries()) await tx.productImage.update({ where: { id }, data: { sortOrder, isPrimary: id === input.primaryId } }); const ordered = input.imageIds.map((id) => images.find((image) => image.id === id)!); await tx.product.update({ where: { id: productId }, data: { image: ordered.find((image) => image.id === input.primaryId)!.url, images: ordered.map((image) => image.url) } }) }); res.json({ updated: input.imageIds.length })
})
router.delete('/images/:id', async (req, res) => { const tenantId = tid(req), current = await prisma.productImage.findFirst({ where: { id: String(req.params.id), tenantId } }); if (!current) return res.status(404).json({ message: 'Зураг олдсонгүй.' }); await prisma.productImage.delete({ where: { id: current.id } }); const next = await prisma.productImage.findFirst({ where: { tenantId, productId: current.productId }, orderBy: { sortOrder: 'asc' } }); if (current.isPrimary && next) { await prisma.productImage.update({ where: { id: next.id }, data: { isPrimary: true } }); await prisma.product.update({ where: { id: current.productId }, data: { image: next.url } }) } res.status(204).send() })

router.get('/export.csv', async (req, res) => { const rows = await prisma.product.findMany({ where: { tenantId: tid(req) }, include: { category: true } }); const esc = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`; const header = ['name', 'slug', 'sku', 'barcode', 'category', 'price', 'costPrice', 'stock', 'unit', 'packSize', 'brand', 'channel', 'active']; res.type('text/csv').attachment('tradeflow-products.csv').send('\uFEFF' + header.join(',') + '\n' + rows.map((row) => [row.name, row.slug, row.sku, row.barcode, row.category.name, row.price, row.costPrice, row.stock, row.unit, row.packSize, row.brand, row.channel, row.active].map(esc).join(',')).join('\n')) })
router.post('/import/preview', fileUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'CSV эсвэл XLSX файл сонгоно уу.' })
  if (!/\.(csv|xlsx)$/i.test(req.file.originalname)) return res.status(400).json({ message: 'Зөвхөн CSV эсвэл XLSX файл зөвшөөрнө.' })
  const parsed = await parseCatalogFile(req.file.buffer, req.file.mimetype), mapping = req.body.mapping ? z.record(z.string(), z.string()).parse(JSON.parse(String(req.body.mapping))) : {}, rows = mapCatalogRows(parsed.rows, mapping)
  const preview = rows.map((row, index) => { const result = importRowSchema.safeParse(row); return { row: index + 2, data: row, errors: result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) } })
  res.json({ columns: parsed.columns, mapping, total: preview.length, valid: preview.filter((row) => !row.errors.length).length, rows: preview.slice(0, 200) })
})
router.post('/import', async (req, res) => {
  const rows = z.array(importRowSchema).parse(req.body), tenantId = tid(req), warehouse = await prisma.warehouse.findFirst({ where: { tenantId, active: true }, orderBy: { createdAt: 'asc' } })
  if (rows.some((item) => item.stock > 0) && !warehouse) return res.status(409).json({ message: 'Эхний үлдэгдэл импортлохын өмнө агуулах үүсгэнэ үү.' })
  let imported = 0
  for (const item of rows) await prisma.$transaction(async (tx) => { const categorySlug = item.category.toLowerCase().replace(/[^a-z0-9]+/g, '-'); const category = await tx.category.upsert({ where: { tenantId_slug: { tenantId, slug: categorySlug } }, update: { name: item.category }, create: { name: item.category, slug: categorySlug, tenantId } }); const { stock, category: _category, ...data } = item; const product = await tx.product.upsert({ where: { tenantId_slug: { tenantId, slug: item.slug } }, update: { ...data, categoryId: category.id, tenantId }, create: { ...data, categoryId: category.id, tenantId, description: item.name, image: '/images/product-placeholder.svg', images: [], tags: [], vendorId: req.user!.id } }); const balance = await tx.inventoryBalance.aggregate({ where: { tenantId, productId: product.id }, _sum: { onHand: true } }); const difference = stock - Number(balance._sum.onHand ?? 0); if (difference && warehouse) await applyStockMovement(tx, { tenantId, warehouseId: warehouse.id, productId: product.id, type: StockMovementType.ADJUSTMENT, quantity: difference, reference: `IMPORT:${product.id}`, reason: 'Каталог импортын opening balance', createdBy: req.user!.id }); imported += 1 })
  await cacheDelete('products:*'); await audit(req, 'IMPORT', 'Product', 'bulk', undefined, { imported }); res.status(201).json({ imported })
})

export default router
