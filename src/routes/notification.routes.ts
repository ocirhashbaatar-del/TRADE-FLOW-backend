import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
const router = Router(); router.use(authenticate)
router.get('/', async (req, res) => res.json(await prisma.notification.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 50 })))
router.patch('/:id/read', async (req, res) => { const result = await prisma.notification.updateMany({ where: { id: req.params.id, userId: req.user!.id }, data: { read: true } }); res.json(result) })
router.patch('/read-all', async (req, res) => { const result = await prisma.notification.updateMany({ where: { userId: req.user!.id, read: false }, data: { read: true } }); res.json(result) })
export default router
