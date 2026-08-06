import { Router } from 'express'
import { Role } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'
import { assertPeriodOpen } from '../lib/period-lock.js'

const router = Router()
router.use(authenticate, requireTenant, authorize(Role.ADMIN, Role.MANAGER, Role.ACCOUNTANT))
const tid = (req: Express.Request) => req.user!.tenantId!

router.get('/invoices', async (req, res) => {
  const invoices = await prisma.invoice.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: 'desc' } })
  const paid = await prisma.paymentAllocation.groupBy({ by: ['invoiceId'], where: { tenantId: tid(req) }, _sum: { amount: true } })
  res.json(invoices.map((i) => { const amount = Number(paid.find((p) => p.invoiceId === i.id)?._sum.amount ?? 0); return { ...i, paid: amount, balance: Number(i.total) - amount } }))
})

router.post('/invoices/from-order/:orderId', async (req, res) => {
  const tenantId = tid(req)
  const order = await prisma.order.findFirst({ where: { id: req.params.orderId, tenantId }, include: { items: { include: { product: true } } } })
  if (!order) return res.status(404).json({ message: 'Захиалга олдсонгүй.' })
  const old = await prisma.invoice.findFirst({ where: { tenantId, orderId: order.id } }); if (old) return res.json(old)
  const vat = order.items.reduce((sum, line) => sum + Number(line.unitPrice) * line.quantity * Number(line.product.vatRate) / (100 + Number(line.product.vatRate)), 0)
  const invoice = await prisma.$transaction(async (tx) => {
    await assertPeriodOpen(tx, tenantId)
    const row = await tx.invoice.create({ data: { tenantId, orderId: order.id, code: `INV-${Date.now()}`, subtotal: order.subtotal, vat, total: order.total, dueDate: new Date(Date.now() + 30 * 86400000) } })
    const period = row.createdAt.toISOString().slice(0, 7)
    await tx.financialEntry.createMany({ data: [
      { tenantId, account: 'ACCOUNTS_RECEIVABLE', reference: row.code, debit: row.total, period, createdBy: req.user!.id },
      { tenantId, account: 'SALES_REVENUE', reference: row.code, credit: Number(row.total) - vat, period, createdBy: req.user!.id },
      { tenantId, account: 'VAT_PAYABLE', reference: row.code, credit: vat, period, createdBy: req.user!.id },
    ] })
    return row
  })
  res.status(201).json(invoice)
})

router.post('/payments', async (req, res) => {
  const input = z.object({ customerId: z.string(), amount: z.number().positive(), method: z.enum(['QPAY', 'BANK', 'CASH', 'STRIPE']), reference: z.string().min(3) }).parse(req.body)
  const tenantId = tid(req)
  const result = await prisma.$transaction(async (tx) => {
    await assertPeriodOpen(tx, tenantId)
    const duplicate = await tx.paymentRecord.findUnique({ where: { tenantId_reference: { tenantId, reference: input.reference } } })
    if (duplicate) return { payment: duplicate, allocated: 0, idempotent: true }
    const payment = await tx.paymentRecord.create({ data: { ...input, tenantId, recordedBy: req.user!.id } })
    const invoices = await tx.invoice.findMany({ where: { tenantId, status: { in: ['OPEN', 'PARTIAL'] } }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }] })
    let remaining = input.amount
    for (const invoice of invoices) {
      if (remaining <= 0) break
      const sum = await tx.paymentAllocation.aggregate({ where: { tenantId, invoiceId: invoice.id }, _sum: { amount: true } })
      const due = Number(invoice.total) - Number(sum._sum.amount ?? 0), amount = Math.min(due, remaining)
      if (amount <= 0) continue
      await tx.paymentAllocation.create({ data: { tenantId, paymentId: payment.id, invoiceId: invoice.id, amount } })
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: amount >= due ? 'PAID' : 'PARTIAL' } }); remaining -= amount
    }
    const period = payment.paidAt.toISOString().slice(0, 7)
    await tx.financialEntry.createMany({ data: [{ tenantId, account: input.method === 'CASH' ? 'CASH' : 'BANK', reference: input.reference, debit: input.amount, period, createdBy: req.user!.id }, { tenantId, account: 'ACCOUNTS_RECEIVABLE', reference: input.reference, credit: input.amount - remaining, period, createdBy: req.user!.id }] })
    return { payment, allocated: input.amount - remaining, unallocated: remaining, idempotent: false }
  }, { isolationLevel: 'Serializable' })
  res.status(result.idempotent ? 200 : 201).json(result)
})

router.get('/receivables/aging', async (req, res) => {
  const invoices = await prisma.invoice.findMany({ where: { tenantId: tid(req), status: { in: ['OPEN', 'PARTIAL'] } } })
  const allocations = await prisma.paymentAllocation.groupBy({ by: ['invoiceId'], where: { tenantId: tid(req) }, _sum: { amount: true } })
  const buckets = { current: 0, days30: 0, days60: 0, days90Plus: 0 }
  for (const i of invoices) { const balance = Number(i.total) - Number(allocations.find((a) => a.invoiceId === i.id)?._sum.amount ?? 0), age = Math.floor((Date.now() - i.createdAt.getTime()) / 86400000); if (age >= 90) buckets.days90Plus += balance; else if (age >= 60) buckets.days60 += balance; else if (age >= 30) buckets.days30 += balance; else buckets.current += balance }
  res.json({ buckets, total: Object.values(buckets).reduce((a, b) => a + b, 0) })
})
router.get('/ledger', async (req, res) => res.json(await prisma.financialEntry.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: 'desc' }, take: 500 })))
router.post('/periods/:period/lock', async (req, res) => res.status(201).json(await prisma.periodLock.create({ data: { tenantId: tid(req), period: z.string().regex(/^\d{4}-\d{2}$/).parse(req.params.period), lockedBy: req.user!.id } })))
router.get('/reconciliation/:date', async (req, res) => {
  const date = z.coerce.date().parse(req.params.date), start = new Date(date); start.setHours(0, 0, 0, 0); const end = new Date(start.getTime() + 86400000)
  const [payments, ledger] = await Promise.all([prisma.paymentRecord.aggregate({ where: { tenantId: tid(req), paidAt: { gte: start, lt: end } }, _sum: { amount: true } }), prisma.financialEntry.aggregate({ where: { tenantId: tid(req), account: { in: ['BANK', 'CASH'] }, createdAt: { gte: start, lt: end } }, _sum: { debit: true } })])
  const paymentTotal = Number(payments._sum.amount ?? 0), ledgerTotal = Number(ledger._sum.debit ?? 0)
  res.json({ date: start.toISOString().slice(0, 10), paymentTotal, ledgerTotal, difference: paymentTotal - ledgerTotal, reconciled: paymentTotal === ledgerTotal })
})
export default router
