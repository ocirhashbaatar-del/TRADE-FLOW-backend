import { Router } from 'express'
import { Role } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, authorizePermission, requireTenant } from '../middleware/auth.js'
import { assertPeriodOpen } from '../lib/period-lock.js'
import { postPayment } from '../lib/payment-posting.js'
import PDFDocument from 'pdfkit'
import { sendMail } from '../lib/services.js'
import { audit } from '../lib/audit.js'

const router = Router()
router.use(authenticate, requireTenant, authorizePermission('finance', 'auto', Role.ADMIN, Role.MANAGER, Role.ACCOUNTANT))
const tid = (req: Express.Request) => req.user!.tenantId!

router.get('/invoices', async (req, res) => {
  const invoices = await prisma.invoice.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: 'desc' } })
  const [paid, credited] = await Promise.all([prisma.paymentAllocation.groupBy({ by: ['invoiceId'], where: { tenantId: tid(req) }, _sum: { amount: true } }), prisma.creditNote.groupBy({ by: ['invoiceId'], where: { tenantId: tid(req), invoiceId: { not: null }, status: 'ISSUED' }, _sum: { total: true } })])
  res.json(invoices.map((i) => { const amount = Number(paid.find((p) => p.invoiceId === i.id)?._sum.amount ?? 0), credit = Number(credited.find((p) => p.invoiceId === i.id)?._sum.total ?? 0); return { ...i, paid: amount, credited: credit, balance: Math.max(0, Number(i.total) - amount - credit) } }))
})
router.get('/credit-notes', async (req, res) => res.json(await prisma.creditNote.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: 'desc' } })))

router.get('/invoices/:id/pdf', async (req, res) => {
  const invoice = await prisma.invoice.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } })
  if (!invoice) return res.status(404).json({ message: 'Нэхэмжлэл олдсонгүй.' })
  const order = await prisma.order.findFirstOrThrow({ where: { id: invoice.orderId, tenantId: tid(req) }, include: { user: true, items: { include: { product: true } } } })
  const customer = await prisma.customerAccount.findFirst({ where: { tenantId: tid(req), userId: order.userId } })
  const doc = new PDFDocument({ margin: 42 }), chunks: Buffer[] = []
  doc.on('data', (chunk) => chunks.push(chunk)); doc.on('end', () => res.type('application/pdf').attachment(`${invoice.code}.pdf`).send(Buffer.concat(chunks)))
  doc.fontSize(22).text('TradeFlow Invoice').moveDown().fontSize(11).text(`Invoice: ${invoice.code}`).text(`Customer: ${customer?.name ?? order.user.name}`).text(`Payment term: ${customer ? `Credit, due ${invoice.dueDate?.toISOString().slice(0, 10) ?? 'on demand'}` : 'Prepaid'}`).text(`Contract/group: ${customer?.groupCode ?? 'Retail'}`).moveDown()
  for (const line of order.items) { const gross = Number(line.unitPrice) * line.quantity, vat = gross * Number(line.product.vatRate) / (100 + Number(line.product.vatRate)); doc.text(`${line.product.name} | ${line.quantity} x ${Number(line.unitPrice).toLocaleString()} | VAT ${Number(line.product.vatRate)}%: ${vat.toFixed(2)} | Gross: ${gross.toFixed(2)}`) }
  doc.moveDown().text(`Subtotal: ${Number(invoice.subtotal).toFixed(2)}`).text(`VAT total: ${Number(invoice.vat).toFixed(2)}`).fontSize(14).text(`TOTAL: ${Number(invoice.total).toFixed(2)}`); doc.end()
})

router.post('/invoices/:id/remind', async (req, res) => {
  const invoice = await prisma.invoice.findFirst({ where: { id: String(req.params.id), tenantId: tid(req), status: { in: ['OPEN', 'PARTIAL', 'PARTIALLY_CREDITED'] } } })
  if (!invoice) return res.status(404).json({ message: 'Төлөгдөөгүй нэхэмжлэл олдсонгүй.' })
  const order = await prisma.order.findFirstOrThrow({ where: { id: invoice.orderId, tenantId: tid(req) }, include: { user: true } })
  if (!order.user.email.includes('@guest.tradeflow.local')) await sendMail(order.user.email, `${invoice.code} төлбөрийн сануулга`, `<p>${invoice.code} нэхэмжлэлийн ${Number(invoice.total).toLocaleString()}₮ төлбөрийн хугацаа ${invoice.dueDate?.toISOString().slice(0, 10) ?? 'нэн даруй'}.</p>`)
  res.json({ message: 'Төлбөрийн сануулга илгээгдлээ.', invoiceId: invoice.id })
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
  const result = await prisma.$transaction((tx) => postPayment(tx, { ...input, tenantId, recordedBy: req.user!.id }), { isolationLevel: 'Serializable' })
  res.status(result.idempotent ? 200 : 201).json(result)
})

router.get('/receivables/aging', async (req, res) => {
  const invoices = await prisma.invoice.findMany({ where: { tenantId: tid(req), status: { in: ['OPEN', 'PARTIAL'] } } })
  const [allocations, credits] = await Promise.all([prisma.paymentAllocation.groupBy({ by: ['invoiceId'], where: { tenantId: tid(req) }, _sum: { amount: true } }), prisma.creditNote.groupBy({ by: ['invoiceId'], where: { tenantId: tid(req), invoiceId: { not: null }, status: 'ISSUED' }, _sum: { total: true } })])
  const buckets = { current: 0, days30: 0, days60: 0, days90Plus: 0 }
  for (const i of invoices) { const balance = Math.max(0, Number(i.total) - Number(allocations.find((a) => a.invoiceId === i.id)?._sum.amount ?? 0) - Number(credits.find((a) => a.invoiceId === i.id)?._sum.total ?? 0)), age = Math.floor((Date.now() - i.createdAt.getTime()) / 86400000); if (age >= 90) buckets.days90Plus += balance; else if (age >= 60) buckets.days60 += balance; else if (age >= 30) buckets.days30 += balance; else buckets.current += balance }
  res.json({ buckets, total: Object.values(buckets).reduce((a, b) => a + b, 0) })
})
router.get('/ledger', async (req, res) => res.json(await prisma.financialEntry.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: 'desc' }, take: 500 })))
router.post('/ledger/:id/reverse', async (req, res) => {
  const input = z.object({ reason: z.string().min(3) }).parse(req.body), tenantId = tid(req)
  const row = await prisma.$transaction(async (tx) => {
    const original = await tx.financialEntry.findFirst({ where: { id: String(req.params.id), tenantId } })
    if (!original) throw Object.assign(new Error('Санхүүгийн бичилт олдсонгүй.'), { status: 404 })
    if (await tx.financialEntry.findFirst({ where: { tenantId, reversesId: original.id } })) throw Object.assign(new Error('Энэ бичилт аль хэдийн буцаагдсан.'), { status: 409 })
    const period = await assertPeriodOpen(tx, tenantId)
    return tx.financialEntry.create({ data: { tenantId, account: original.account, reference: `REV:${original.reference}:${input.reason}`, debit: original.credit, credit: original.debit, period, kind: 'REVERSAL', reversesId: original.id, createdBy: req.user!.id } })
  })
  res.status(201).json(row)
})
router.post('/periods/:period/lock', async (req, res) => { const period = z.string().regex(/^\d{4}-\d{2}$/).parse(req.params.period); const row = await prisma.periodLock.create({ data: { tenantId: tid(req), period, lockedBy: req.user!.id } }); await audit(req, 'LOCK', 'PeriodLock', row.id, undefined, row); res.status(201).json(row) })
router.get('/reconciliation/:date', async (req, res) => {
  const date = z.coerce.date().parse(req.params.date), start = new Date(date); start.setHours(0, 0, 0, 0); const end = new Date(start.getTime() + 86400000)
  const [payments, ledger] = await Promise.all([prisma.paymentRecord.aggregate({ where: { tenantId: tid(req), paidAt: { gte: start, lt: end } }, _sum: { amount: true } }), prisma.financialEntry.aggregate({ where: { tenantId: tid(req), account: { in: ['BANK', 'CASH'] }, createdAt: { gte: start, lt: end } }, _sum: { debit: true } })])
  const paymentTotal = Number(payments._sum.amount ?? 0), ledgerTotal = Number(ledger._sum.debit ?? 0)
  res.json({ date: start.toISOString().slice(0, 10), paymentTotal, ledgerTotal, difference: paymentTotal - ledgerTotal, reconciled: paymentTotal === ledgerTotal })
})
export default router
