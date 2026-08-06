import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, requireTenant } from '../middleware/auth.js'
const router = Router(); router.use(authenticate, requireTenant)
const tid = (req: Express.Request) => req.user!.tenantId!
router.get('/dashboard', async (req, res) => {
  const tenantId = tid(req), start = new Date(); start.setHours(0, 0, 0, 0)
  const [sales, newOrders, lowStock, expiring, receivables, recentOrders] = await Promise.all([
    prisma.order.aggregate({ where: { tenantId, createdAt: { gte: start }, status: { not: 'CANCELLED' } }, _sum: { total: true } }),
    prisma.order.count({ where: { tenantId, createdAt: { gte: start } } }),
    prisma.product.count({ where: { tenantId, active: true, stock: { lte: 5 } } }),
    prisma.stockBatch.count({ where: { tenantId, expiresAt: { gte: new Date(), lte: new Date(Date.now() + 30 * 86400000) }, quantity: { gt: 0 } } }),
    prisma.invoice.aggregate({ where: { tenantId, status: { in: ['OPEN', 'PARTIAL'] } }, _sum: { total: true } }),
    prisma.order.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 8 }),
  ])
  res.json({ metrics: { todaySales: Number(sales._sum.total ?? 0), newOrders, lowStock, expiringBatches: expiring, openReceivables: Number(receivables._sum.total ?? 0) }, recentOrders })
})
router.get('/sales', async (req, res) => {
  const rows = await prisma.order.findMany({ where: { tenantId: tid(req), status: { not: 'CANCELLED' } }, select: { channel: true, total: true, createdAt: true } })
  res.json(Object.values(rows.reduce<Record<string, { period: string; channel: string; revenue: number; orders: number }>>((a, r) => { const period = r.createdAt.toISOString().slice(0, 7), key = `${period}:${r.channel}`; a[key] ??= { period, channel: r.channel, revenue: 0, orders: 0 }; a[key].revenue += Number(r.total); a[key].orders++; return a }, {})))
})
router.get('/inventory', async (req, res) => { const rows = await prisma.inventoryBalance.findMany({ where: { tenantId: tid(req) } }); res.json(rows.map((r) => ({ ...r, available: r.onHand - r.reserved }))) })
router.get('/sales.csv', async (req, res) => { const rows = await prisma.order.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: 'desc' } }); res.type('text/csv').attachment('sales.csv').send('\uFEFFЗахиалга,Суваг,Төлөв,Нийт,Огноо\n' + rows.map((r) => [r.orderNumber, r.channel, r.status, r.total, r.createdAt.toISOString()].join(',')).join('\n')) })
export default router
