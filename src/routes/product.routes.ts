import { Router } from 'express'
import { Role } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, authorize } from '../middleware/auth.js'
import { cacheDelete, cacheGet, cacheSet } from '../lib/redis.js'

const router = Router()
const schema = z.object({ name: z.string().min(2), slug: z.string().min(2), description: z.string().min(5), price: z.coerce.number().positive(), compareAt: z.coerce.number().positive().optional(), stock: z.coerce.number().int().nonnegative(), image: z.string(), images: z.array(z.string()).default([]), tags: z.array(z.string()).default([]), featured: z.boolean().default(false), categoryId: z.string(), vendorId: z.string().optional() })
const shape = (p: any) => ({ id: p.id, name: p.name, category: p.category.name, vendor: p.vendor.name, price: Number(p.price), compareAt: p.compareAt ? Number(p.compareAt) : undefined, rating: p.rating, reviews: p.reviewCount, stock: p.stock, image: p.image, description: p.description, featured: p.featured, tags: p.tags })

router.get('/', async (req, res) => {
  const query = z.object({ q: z.string().optional(), category: z.string().optional(), tenant: z.string().optional() }).parse(req.query)
  const selectedTenant = query.tenant ? await prisma.tenant.findUnique({ where: { slug: query.tenant } }) : await prisma.tenant.findFirst({ where: { active: true }, orderBy: { createdAt: 'asc' } })
  if (!selectedTenant) return res.json([])
  const key = `products:${selectedTenant.id}:${query.q ?? ''}:${query.category ?? ''}`
  const cached = await cacheGet(key); if (cached) return res.json(cached)
  const products = await prisma.product.findMany({ where: { tenantId: selectedTenant.id, active: true, ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { description: { contains: query.q, mode: 'insensitive' } }] } : {}), ...(query.category ? { category: { slug: query.category } } : {}) }, include: { category: true, vendor: true }, orderBy: [{ featured: 'desc' }, { createdAt: 'desc' }] })
  const result = products.map(shape); await cacheSet(key, result); res.json(result)
})
router.get('/:id', async (req, res) => { const product = await prisma.product.findUnique({ where: { id: String(req.params.id) }, include: { category: true, vendor: true } }); product ? res.json(shape(product)) : res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' }) })
router.post('/', authenticate, authorize(Role.ADMIN, Role.MANAGER, Role.VENDOR), async (req, res) => { if (!req.user!.tenantId) return res.status(403).json({ message: 'Tenant шаардлагатай.' }); const data = schema.parse(req.body); const product = await prisma.product.create({ data: { ...data, tenantId: req.user!.tenantId, vendorId: data.vendorId ?? req.user!.id } }); await cacheDelete('products:*'); res.status(201).json(product) })
router.patch('/:id', authenticate, authorize(Role.ADMIN, Role.MANAGER, Role.VENDOR), async (req, res) => { const current = await prisma.product.findFirst({ where: { id: String(req.params.id), tenantId: req.user!.tenantId } }); if (!current) return res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' }); const data = schema.partial().parse(req.body); const product = await prisma.product.update({ where: { id: current.id }, data }); await cacheDelete('products:*'); res.json(product) })
router.delete('/:id', authenticate, authorize(Role.ADMIN, Role.MANAGER), async (req, res) => { const result = await prisma.product.updateMany({ where: { id: String(req.params.id), tenantId: req.user!.tenantId }, data: { active: false } }); if (!result.count) return res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' }); await cacheDelete('products:*'); res.status(204).send() })
export default router
