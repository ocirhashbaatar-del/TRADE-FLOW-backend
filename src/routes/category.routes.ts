import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
const router = Router()
router.get('/', async (_req, res) => { const rows = await prisma.category.findMany({ where: { products: { some: { active: true } } }, include: { _count: { select: { products: { where: { active: true } } } } }, orderBy: { name: 'asc' } }); res.json(rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug, image: row.image, count: row._count.products }))) })
export default router
