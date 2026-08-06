import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
const router = Router(); router.use(authenticate)
router.get('/:userId', async (req, res) => { const messages = await prisma.message.findMany({ where: { OR: [{ senderId: req.user!.id, receiverId: req.params.userId }, { senderId: req.params.userId, receiverId: req.user!.id }] }, orderBy: { createdAt: 'asc' }, take: 100 }); res.json(messages) })
export default router
