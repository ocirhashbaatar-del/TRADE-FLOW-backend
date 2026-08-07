import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { findStorefrontTenant } from '../utils/storefront-tenant.js'
import { ProductChannel } from '@prisma/client'

const router = Router()

router.get('/', async (req, res) => {
  const { tenant } = z.object({ tenant: z.string().optional() }).parse(req.query)
  const selectedTenant = tenant
    ? await prisma.tenant.findFirst({ where: { slug: tenant, active: true } })
    : await findStorefrontTenant(req.hostname)
  if (!selectedTenant) return res.json([])

  const rows = await prisma.category.findMany({
    where: { tenantId: selectedTenant.id, products: { some: { active: true, tenantId: selectedTenant.id, channel: { in: [ProductChannel.BOTH, ProductChannel.B2C] } } } },
    include: { _count: { select: { products: { where: { active: true, tenantId: selectedTenant.id, channel: { in: [ProductChannel.BOTH, ProductChannel.B2C] } } } } } },
    orderBy: { name: 'asc' },
  })
  res.json(rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug, image: row.image, count: row._count.products })))
})

export default router
