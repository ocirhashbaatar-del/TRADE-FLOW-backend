import { Router } from 'express'
import { ProductChannel, Role, StockMovementType } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, authorize, optionalAuthenticate } from '../middleware/auth.js'
import { cacheDelete, cacheGet, cacheSet } from '../lib/redis.js'
import { findStorefrontTenant } from '../utils/storefront-tenant.js'
import { resolvePrice } from '../lib/price-resolver.js'
import { tenantWhere } from '../lib/tenant-scope.js'
import { assertSubscriptionCapacity } from '../lib/subscription.js'
import { applyStockMovement } from '../lib/inventory.js'

const router = Router()
const schema = z.object({ sku: z.string().trim().min(2).max(64).transform((value) => value.toUpperCase()), name: z.string().min(2), slug: z.string().min(2), description: z.string().min(5), price: z.coerce.number().positive(), compareAt: z.coerce.number().positive().optional(), stock: z.coerce.number().int().nonnegative(), image: z.string(), images: z.array(z.string()).default([]), tags: z.array(z.string()).default([]), featured: z.boolean().default(false), active: z.boolean().default(true), trackBatch: z.boolean().default(false), trackExpiry: z.boolean().default(false), categoryId: z.string(), vendorId: z.string().optional() }).refine((data) => !data.trackExpiry || data.trackBatch, { message: 'Expiry tracking ашиглах бол batch tracking мөн идэвхтэй байна.', path: ['trackExpiry'] })
const shape = (p: any, resolved?: { price: number; source: string }) => ({ id: p.id, name: p.name, category: p.category.name, vendor: p.vendor.name, price: resolved?.price ?? Number(p.price), priceSource: resolved?.source ?? 'RETAIL', compareAt: p.compareAt ? Number(p.compareAt) : undefined, rating: p.rating, reviews: p.reviewCount, stock: p.availableStock ?? p.stock, image: p.image, description: p.description, featured: p.featured, tags: p.tags })
const extendedFields = z.object({ barcode: z.string().trim().optional(), brand: z.string().trim().optional(), unit: z.string().min(1).default('ш'), packSize: z.coerce.number().int().positive().default(1), costPrice: z.coerce.number().nonnegative().default(0), vatRate: z.coerce.number().min(0).max(100).default(10), reorderPoint: z.coerce.number().int().nonnegative().default(0), channel: z.nativeEnum(ProductChannel).default(ProductChannel.BOTH) })
const managementShape = (p: any) => ({ id: p.id, sku: p.sku, barcode: p.barcode, brand: p.brand, unit: p.unit, packSize: p.packSize, costPrice: Number(p.costPrice), vatRate: Number(p.vatRate), reorderPoint: p.reorderPoint, channel: p.channel, trackBatch: p.trackBatch, trackExpiry: p.trackExpiry, images: p.images, name: p.name, slug: p.slug, categoryId: p.categoryId, category: p.category.name, vendor: p.vendor.name, price: Number(p.price), compareAt: p.compareAt ? Number(p.compareAt) : undefined, stock: p.stock, image: p.image, description: p.description, featured: p.featured, active: p.active, updatedAt: p.updatedAt })

router.get('/manage', authenticate, authorize(Role.ADMIN, Role.MANAGER, Role.VENDOR), async (req, res) => {
  if (!req.user!.tenantId) return res.status(403).json({ message: 'Tenant шаардлагатай.' })
  const query = z.object({ q: z.string().optional(), page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query)
  const where = { tenantId: req.user!.tenantId, ...(req.user!.role === Role.VENDOR ? { vendorId: req.user!.id } : {}), ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' as const } }, { sku: { contains: query.q, mode: 'insensitive' as const } }] } : {}) }
  const [rows, total] = await Promise.all([
    prisma.product.findMany({ where, include: { category: true, vendor: true }, orderBy: { updatedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    prisma.product.count({ where }),
  ])
  res.json({ data: rows.map(managementShape), total, page: query.page, pageSize: query.pageSize })
})

router.get('/', optionalAuthenticate, async (req, res) => {
  const query = z.object({ q: z.string().optional(), category: z.string().optional(), tenant: z.string().optional() }).parse(req.query)
  const selectedTenant = query.tenant ? await prisma.tenant.findFirst({ where: { slug: query.tenant, active: true } }) : await findStorefrontTenant(req.hostname)
  if (!selectedTenant) return res.json([])
  const customer = req.user?.tenantId === selectedTenant.id ? await prisma.customerAccount.findFirst({ where: tenantWhere(selectedTenant.id, { userId: req.user.id, active: true }) }) : null
  const key = `products:${selectedTenant.id}:${query.q ?? ''}:${query.category ?? ''}`
  if (!customer) { const cached = await cacheGet(key); if (cached) return res.json(cached) }

  const now = new Date()
  const products = await prisma.product.findMany({ where: tenantWhere(selectedTenant.id, { active: true, channel: { in: [ProductChannel.BOTH, ProductChannel.B2C] }, ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' as const } }, { description: { contains: query.q, mode: 'insensitive' as const } }] } : {}), ...(query.category ? { category: { slug: query.category, tenantId: selectedTenant.id } } : {}) }), include: { category: true, vendor: true }, orderBy: [{ featured: 'desc' }, { createdAt: 'desc' }] })
  const productIds = products.map((product) => product.id)
  const categoryIds = [...new Set(products.map((product) => product.categoryId))]

  const [balances, rules, promotions] = await Promise.all([
    prisma.inventoryBalance.groupBy({ by: ['productId'], where: { tenantId: selectedTenant.id, productId: { in: productIds } }, _sum: { onHand: true, reserved: true } }),
    prisma.priceRule.findMany({ where: { tenantId: selectedTenant.id, productId: { in: productIds }, active: true, variantId: null, minQuantity: { lte: 1 }, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }] }, orderBy: [{ priority: 'desc' }, { minQuantity: 'desc' }] }),
    prisma.promotion.findMany({ where: { tenantId: selectedTenant.id, active: true, minQuantity: { lte: 1 }, OR: [{ productId: { in: productIds } }, { categoryId: { in: categoryIds } }], startsAt: { lte: now }, endsAt: { gte: now } }, orderBy: { discountPct: 'desc' } }),
  ])

  const result = products.map((product) => {
    const balance = balances.find((row) => row.productId === product.id)
    const productRules = rules.filter((rule) => rule.productId === product.id)
    const selected = productRules.find((rule) => customer?.id && rule.customerId === customer.id)
      ?? productRules.find((rule) => customer?.groupCode && rule.groupCode === customer.groupCode)
      ?? productRules.find((rule) => !rule.customerId && !rule.groupCode)
    const basePrice = Number(selected?.price ?? product.price)
    const promotion = promotions.find((promo) => promo.productId === product.id || promo.categoryId === product.categoryId)
    const discounted = promotion ? Math.max(0, basePrice - (promotion.discountAmt ? Number(promotion.discountAmt) : basePrice * Number(promotion.discountPct ?? 0) / 100)) : basePrice
    const ruleType = selected?.customerId ? 'CONTRACT' : selected?.groupCode ? 'GROUP' : 'TIER'
    const priceSource = promotion ? `PROMOTION:${promotion.id}` : selected ? `RULE:${ruleType}:${selected.id}` : 'RETAIL'
    return shape({ ...product, availableStock: Math.max(0, Number(balance?._sum.onHand ?? 0) - Number(balance?._sum.reserved ?? 0)) }, { price: discounted, source: priceSource })
  })

  if (!customer) await cacheSet(key, result)
  res.json(result)
})

router.get('/:id', optionalAuthenticate, async (req, res) => {
  const query = z.object({ tenant: z.string().optional(), quantity: z.coerce.number().int().positive().default(1), variantId: z.string().optional(), channel: z.enum(['B2C', 'B2B']).default('B2C') }).parse(req.query)
  const selectedTenant = query.tenant ? await prisma.tenant.findFirst({ where: { slug: query.tenant, active: true } }) : await findStorefrontTenant(req.hostname)
  if (!selectedTenant) return res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' })
  const customer = req.user?.tenantId === selectedTenant.id ? await prisma.customerAccount.findFirst({ where: tenantWhere(selectedTenant.id, { userId: req.user.id, active: true }) }) : null
  if (query.channel === 'B2B' && !customer) return res.status(403).json({ message: 'B2B каталог үзэх эрхгүй.' })
  const result = await prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({ where: tenantWhere(selectedTenant.id, { id: String(req.params.id), active: true, channel: { in: [ProductChannel.BOTH, query.channel === 'B2B' ? ProductChannel.B2B : ProductChannel.B2C] } }), include: { category: true, vendor: true } })
    if (!product) return null
    const variants = await tx.productVariant.findMany({ where: { tenantId: selectedTenant.id, productId: product.id, active: true }, orderBy: { createdAt: 'asc' } })
    const balances = await tx.inventoryBalance.groupBy({ by: ['variantId'], where: { tenantId: selectedTenant.id, productId: product.id }, _sum: { onHand: true, reserved: true } })
    const price = await resolvePrice(tx, { tenantId: selectedTenant.id, productId: product.id, variantId: query.variantId, quantity: query.quantity, customerId: customer?.id, groupCode: customer?.groupCode ?? undefined })
    const availableStock = balances.reduce((sum, balance) => sum + Number(balance._sum.onHand ?? 0) - Number(balance._sum.reserved ?? 0), 0)
    return { ...shape({ ...product, availableStock: Math.max(0, availableStock) }, price), purchaseChannel: query.channel, variants: variants.map((variant) => { const balance = balances.find((row) => row.variantId === variant.id); return { ...variant, price: variant.price ? Number(variant.price) : Number(product.price), stock: Math.max(0, Number(balance?._sum.onHand ?? 0) - Number(balance?._sum.reserved ?? 0)) } }) }
  })
  result ? res.json(result) : res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' })
})
router.post('/', authenticate, authorize(Role.ADMIN, Role.MANAGER, Role.VENDOR), async (req, res) => {
  if (!req.user!.tenantId) return res.status(403).json({ message: 'Tenant шаардлагатай.' })
  const data = schema.and(extendedFields).parse(req.body), tenantId = req.user!.tenantId
  const product = await prisma.$transaction(async (tx) => {
    await assertSubscriptionCapacity(tx, tenantId, 'products')
    const category = await tx.category.findFirst({ where: { id: data.categoryId, tenantId } })
    if (!category) throw Object.assign(new Error('Ангилал буруу.'), { status: 400 })
    const duplicate = await tx.product.findFirst({ where: { tenantId, sku: data.sku } })
    if (duplicate) throw Object.assign(new Error('Энэ барааны код бүртгэлтэй байна.'), { status: 409 })
    let warehouse = await tx.warehouse.findFirst({ where: { tenantId, active: true }, orderBy: { createdAt: 'asc' } })
    if (data.stock > 0 && !warehouse) warehouse = await tx.warehouse.create({ data: { tenantId, code: 'MAIN', name: 'Үндсэн агуулах', type: 'WAREHOUSE' } })
    const created = await tx.product.create({ data: { ...data, tenantId, vendorId: data.vendorId ?? req.user!.id } })
    if (warehouse && data.stock > 0) {
      await applyStockMovement(tx, { tenantId, warehouseId: warehouse.id, productId: created.id, type: StockMovementType.ADJUSTMENT, quantity: data.stock, reference: `PRODUCT:${created.id}`, reason: 'Бүтээгдэхүүний эхний үлдэгдэл', createdBy: req.user!.id })
    }
    return created
  }, { maxWait: 10000, timeout: 30000 })
  await cacheDelete('products:*')
  res.status(201).json(product)
})
router.patch('/:id', authenticate, authorize(Role.ADMIN, Role.MANAGER, Role.VENDOR), async (req, res) => {
  const tenantId = req.user!.tenantId!, id = String(req.params.id), data = schema.partial().and(extendedFields.partial()).parse(req.body)
  const product = await prisma.$transaction(async (tx) => {
    const current = await tx.product.findFirst({ where: { id, tenantId } })
    if (!current) throw Object.assign(new Error('Бүтээгдэхүүн олдсонгүй.'), { status: 404 })
    const { stock, ...productData } = data
    if (stock !== undefined && stock !== current.stock) {
      const warehouse = await tx.warehouse.findFirst({ where: { tenantId, active: true }, orderBy: { createdAt: 'asc' } })
      if (!warehouse) throw Object.assign(new Error('Үлдэгдэл засахын өмнө агуулах үүсгэнэ үү.'), { status: 409 })
      const balance = await tx.inventoryBalance.findUnique({ where: { tenantId_warehouseId_productId_variantId: { tenantId, warehouseId: warehouse.id, productId: id, variantId: '' } } })
      const total = await tx.inventoryBalance.aggregate({ where: { tenantId, productId: id }, _sum: { onHand: true } })
      const difference = stock - (total._sum.onHand ?? 0)
      if ((balance?.onHand ?? 0) + difference < (balance?.reserved ?? 0)) throw Object.assign(new Error('Шинэ үлдэгдэл идэвхтэй reservation-оос бага байна.'), { status: 409 })
      if (difference) await applyStockMovement(tx, { tenantId, warehouseId: warehouse.id, productId: id, type: StockMovementType.ADJUSTMENT, quantity: difference, reference: `PRODUCT:${id}`, reason: 'Бүтээгдэхүүний үлдэгдэл засвар', createdBy: req.user!.id })
    }
    return tx.product.update({ where: { id }, data: productData })
  }, { isolationLevel: 'Serializable' })
  await cacheDelete('products:*')
  res.json(product)
})
router.delete('/:id', authenticate, authorize(Role.ADMIN, Role.MANAGER), async (req, res) => { const result = await prisma.product.updateMany({ where: { id: String(req.params.id), tenantId: req.user!.tenantId }, data: { active: false } }); if (!result.count) return res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' }); await cacheDelete('products:*'); res.status(204).send() })
export default router
