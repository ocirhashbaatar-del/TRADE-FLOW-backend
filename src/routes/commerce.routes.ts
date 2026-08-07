import { Router } from 'express'
import { Role } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'
import { hashToken } from '../utils/auth.js'
import { findStorefrontTenant } from '../utils/storefront-tenant.js'

const router = Router()
router.get('/storefront-meta',async(req,res)=>{const tenant=await findStorefrontTenant(req.hostname);if(!tenant)return res.status(404).json({message:'Storefront олдсонгүй.'});res.json({name:tenant.name,slug:tenant.slug,domain:tenant.domain,logo:tenant.logo,primaryColor:tenant.primaryColor,canonical:`https://${tenant.domain??req.hostname}`})})
router.get('/sitemap.xml',async(req,res)=>{const tenant=await findStorefrontTenant(req.hostname);if(!tenant)return res.status(404).send('');const base=`https://${tenant.domain??req.hostname}`,[products,categories]=await Promise.all([prisma.product.findMany({where:{tenantId:tenant.id,active:true},select:{id:true,updatedAt:true}}),prisma.category.findMany({where:{tenantId:tenant.id},select:{slug:true}})]);const urls=[`<url><loc>${base}/</loc></url>`,`<url><loc>${base}/products</loc></url>`,...categories.map(x=>`<url><loc>${base}/products?category=${encodeURIComponent(x.slug)}</loc></url>`),...products.map(x=>`<url><loc>${base}/products/${x.id}</loc><lastmod>${x.updatedAt.toISOString()}</lastmod></url>`)];res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`)})
router.get('/robots.txt',async(req,res)=>{const tenant=await findStorefrontTenant(req.hostname),base=`https://${tenant?.domain??req.hostname}`;res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${base}/api/v1/commerce/sitemap.xml\n`)})

router.get('/track/:token', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { trackingTokenHash: hashToken(String(req.params.token)) }, select: { orderNumber: true, status: true, paymentStatus: true, updatedAt: true, statusHistory: { orderBy: { createdAt: 'asc' }, select: { toStatus: true, createdAt: true } } } })
  order ? res.json(order) : res.status(404).json({ message: 'Хүргэлтийн холбоос хүчингүй.' })
})

router.use(authenticate, requireTenant)
const tenantId = (req: Express.Request) => req.user!.tenantId!
router.get('/delivery-zones', async (req, res) => res.json(await prisma.deliveryZone.findMany({ where: { tenantId: tenantId(req), active: true }, orderBy: { name: 'asc' } })))
router.get('/coupons', authorize(Role.ADMIN, Role.MANAGER), async (req, res) => res.json(await prisma.coupon.findMany({ where: { tenantId: tenantId(req) }, orderBy: { createdAt: 'desc' } })))
router.post('/coupons', authorize(Role.ADMIN, Role.MANAGER), async (req, res) => {
  const input = z.object({ code: z.string().min(3).transform((v) => v.toUpperCase()), type: z.enum(['PERCENT', 'FIXED']), value: z.number().positive(), minSubtotal: z.number().nonnegative().default(0), usageLimit: z.number().int().positive().optional(), startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional(), active: z.boolean().default(true) }).parse(req.body)
  res.status(201).json(await prisma.coupon.create({ data: { ...input, tenantId: tenantId(req) } }))
})
router.post('/delivery-zones', authorize(Role.ADMIN, Role.MANAGER), async (req, res) => {
  const input = z.object({ name: z.string().min(2), city: z.string().min(2), districts: z.array(z.string().min(1)).min(1), fee: z.number().nonnegative(), active: z.boolean().default(true) }).parse(req.body)
  res.status(201).json(await prisma.deliveryZone.create({ data: { ...input, tenantId: tenantId(req) } }))
})
export default router
