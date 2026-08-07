import { Router } from 'express'
import { Role } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, authorize } from '../middleware/auth.js'
import { cacheDelete, cacheGet, cacheSet } from '../lib/redis.js'
import { findStorefrontTenant } from '../utils/storefront-tenant.js'

const router = Router()
const schema = z.object({ sku: z.string().trim().min(2).max(64).transform((value) => value.toUpperCase()), name: z.string().min(2), slug: z.string().min(2), description: z.string().min(5), price: z.coerce.number().positive(), compareAt: z.coerce.number().positive().optional(), stock: z.coerce.number().int().nonnegative(), image: z.string(), images: z.array(z.string()).default([]), tags: z.array(z.string()).default([]), featured: z.boolean().default(false), active: z.boolean().default(true), categoryId: z.string(), vendorId: z.string().optional() })
const shape = (p: any) => ({ id: p.id, name: p.name, category: p.category.name, vendor: p.vendor.name, price: Number(p.price), compareAt: p.compareAt ? Number(p.compareAt) : undefined, rating: p.rating, reviews: p.reviewCount, stock: p.stock, image: p.image, description: p.description, featured: p.featured, tags: p.tags })
const managementShape = (p: any) => ({ id: p.id, sku: p.sku, name: p.name, slug: p.slug, categoryId: p.categoryId, category: p.category.name, vendor: p.vendor.name, price: Number(p.price), compareAt: p.compareAt ? Number(p.compareAt) : undefined, stock: p.stock, image: p.image, description: p.description, featured: p.featured, active: p.active, updatedAt: p.updatedAt })

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

router.get('/', async (req, res) => {
  const query = z.object({ q: z.string().optional(), category: z.string().optional(), tenant: z.string().optional() }).parse(req.query)
  const selectedTenant = query.tenant ? await prisma.tenant.findFirst({ where: { slug: query.tenant, active: true } }) : await findStorefrontTenant()
  if (!selectedTenant) return res.json([])
  const key = `products:${selectedTenant.id}:${query.q ?? ''}:${query.category ?? ''}`
  const cached = await cacheGet(key); if (cached) return res.json(cached)
  const products = await prisma.product.findMany({ where: { tenantId: selectedTenant.id, active: true, ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }] } : {}), ...(query.category ? { category: { slug: query.category } } : {}) }, include: { category: true, vendor: true }, orderBy: [{ featured: 'desc' }, { createdAt: 'desc' }] })
  const result = products.map(shape); await cacheSet(key, result); res.json(result)
})
router.get('/:id', async (req, res) => { const product = await prisma.product.findUnique({ where: { id: String(req.params.id) }, include: { category: true, vendor: true } }); product ? res.json(shape(product)) : res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' }) })
router.post('/', authenticate, authorize(Role.ADMIN, Role.MANAGER, Role.VENDOR), async (req, res) => { if (!req.user!.tenantId) return res.status(403).json({ message: 'Tenant шаардлагатай.' }); const data = schema.parse(req.body); const category = await prisma.category.findFirst({ where: { id: data.categoryId, tenantId: req.user!.tenantId } }); if (!category) return res.status(400).json({ message: 'Ангилал буруу.' }); const duplicate = await prisma.product.findFirst({ where: { tenantId: req.user!.tenantId, sku: data.sku } }); if (duplicate) return res.status(409).json({ message: 'Энэ барааны код бүртгэлтэй байна.' }); const product = await prisma.product.create({ data: { ...data, tenantId: req.user!.tenantId, vendorId: data.vendorId ?? req.user!.id } }); await cacheDelete('products:*'); res.status(201).json(product) })
router.patch('/:id', authenticate, authorize(Role.ADMIN, Role.MANAGER, Role.VENDOR), async (req, res) => { const current = await prisma.product.findFirst({ where: { id: String(req.params.id), tenantId: req.user!.tenantId } }); if (!current) return res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' }); const data = schema.partial().parse(req.body); const product = await prisma.product.update({ where: { id: current.id }, data }); await cacheDelete('products:*'); res.json(product) })
router.delete('/:id', authenticate, authorize(Role.ADMIN, Role.MANAGER), async (req, res) => { const result = await prisma.product.updateMany({ where: { id: String(req.params.id), tenantId: req.user!.tenantId }, data: { active: false } }); if (!result.count) return res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' }); await cacheDelete('products:*'); res.status(204).send() })
export default router
