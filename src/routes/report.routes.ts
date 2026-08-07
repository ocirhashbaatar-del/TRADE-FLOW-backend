import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, requireTenant } from '../middleware/auth.js'
import PDFDocument from 'pdfkit'
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
router.get('/operations', async (req, res) => {
  const tenantId = tid(req), since = new Date(Date.now() - 90 * 86400000)
  const [products, sales, recentMovements, supplierLinks, purchaseOrders, receipts, orderItems] = await Promise.all([
    prisma.product.findMany({ where: { tenantId, active: true } }), prisma.stockMovement.findMany({ where: { tenantId, type: 'SALE', createdAt: { gte: since } } }), prisma.stockMovement.findMany({ where: { tenantId, createdAt: { gte: since } }, select: { productId: true } }), prisma.productSupplier.findMany({ where: { tenantId, active: true } }), prisma.purchaseOrder.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }), prisma.goodsReceipt.findMany({ where: { tenantId }, include: { lines: true } }), prisma.orderItem.findMany({ where: { order: { tenantId, status: { not: 'CANCELLED' }, createdAt: { gte: since } } }, include: { product: true } }),
  ])
  const sold = new Map<string, number>(); sales.forEach((row) => sold.set(row.productId, (sold.get(row.productId) ?? 0) + Math.abs(row.quantity)))
  const inventoryTurnover = products.map((product) => ({ productId: product.id, name: product.name, sold90Days: sold.get(product.id) ?? 0, averageInventory: product.stock, turnover: product.stock > 0 ? (sold.get(product.id) ?? 0) / product.stock : 0 }))
  const touched = new Set(recentMovements.map((row) => row.productId)); const deadStock = products.filter((product) => product.stock > 0 && !touched.has(product.id)).map((product) => ({ productId: product.id, name: product.name, stock: product.stock, value: product.stock * Number(product.costPrice) }))
  const supplierPerformance = supplierLinks.map((link) => { const pos = purchaseOrders.filter((po) => po.supplierId === link.supplierId), supplierReceipts = receipts.filter((row) => row.supplierId === link.supplierId); return { supplierId: link.supplierId, purchaseOrders: pos.length, receipts: supplierReceipts.length, discrepancy: supplierReceipts.flatMap((row) => row.lines).reduce((sum, line) => sum + Math.abs(line.discrepancyQuantity), 0), lastPurchasedAt: link.lastPurchasedAt } })
  const expectedPO = purchaseOrders.filter((po) => ['SENT', 'PARTIALLY_RECEIVED'].includes(po.status)).map((po) => ({ id: po.id, code: po.code, supplierId: po.supplierId, expectedAt: po.expectedAt, status: po.status }))
  const marginByProduct = Object.values(orderItems.reduce<Record<string, { productId: string; name: string; revenue: number; cost: number; margin: number }>>((acc, line) => { const row = acc[line.productId] ??= { productId: line.productId, name: line.product.name, revenue: 0, cost: 0, margin: 0 }; row.revenue += Number(line.unitPrice) * line.quantity; row.cost += Number(line.product.costPrice) * line.quantity; row.margin = row.revenue - row.cost; return acc }, {}))
  const costChanges = products.map((product) => { const latest = supplierLinks.filter((link) => link.productId === product.id).sort((a, b) => Number(b.lastPurchasedAt ?? 0) - Number(a.lastPurchasedAt ?? 0))[0]; return { productId: product.id, name: product.name, currentCost: Number(product.costPrice), supplierCost: Number(latest?.unitCost ?? 0), difference: Number(product.costPrice) - Number(latest?.unitCost ?? 0) } })
  res.json({ periodDays: 90, inventoryTurnover, deadStock, supplierPerformance, costChanges, expectedPO, marginByProduct })
})
router.get('/operations.pdf', async (req, res) => {
  const tenantId = tid(req), products = await prisma.product.findMany({ where: { tenantId, active: true }, orderBy: { stock: 'desc' } }), orders = await prisma.order.findMany({ where: { tenantId, status: { not: 'CANCELLED' } } })
  const doc = new PDFDocument({ margin: 42 }), chunks: Buffer[] = []
  doc.on('data', (chunk) => chunks.push(chunk)); doc.on('end', () => res.type('application/pdf').attachment('tradeflow-operations-report.pdf').send(Buffer.concat(chunks)))
  doc.fontSize(22).text('TradeFlow Operations Report').fontSize(10).text(`Generated: ${new Date().toISOString()}`).moveDown().fontSize(13).text(`Revenue: ${orders.reduce((sum, row) => sum + Number(row.total), 0).toLocaleString()} MNT`).text(`Orders: ${orders.length}`).text(`Inventory value: ${products.reduce((sum, row) => sum + row.stock * Number(row.costPrice), 0).toLocaleString()} MNT`).moveDown().fontSize(15).text('Inventory').fontSize(9); products.slice(0, 100).forEach((row) => doc.text(`${row.name} | stock ${row.stock} | cost ${Number(row.costPrice).toLocaleString()} | value ${(row.stock * Number(row.costPrice)).toLocaleString()}`)); doc.end()
})
export default router
