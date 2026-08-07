import { Router } from 'express'
import { PurchaseOrderStatus, Role, StockMovementType } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { audit } from '../lib/audit.js'
import { applyStockMovement } from '../lib/inventory.js'
import PDFDocument from 'pdfkit'
import { sendMail } from '../lib/services.js'
import { authenticate, authorizePermission, requireTenant } from '../middleware/auth.js'
import { assertPeriodOpen } from '../lib/period-lock.js'
import { transitionPurchaseOrder } from '../lib/purchase-order-state.js'

const router = Router()
router.use(authenticate, requireTenant, authorizePermission('procurement', 'auto', Role.ADMIN, Role.MANAGER, Role.VENDOR))
const tenant = (req: Express.Request) => req.user!.tenantId!
async function purchaseOrderPdf(id: string, tenantId: string) {
  const po = await prisma.purchaseOrder.findFirst({ where: { id, tenantId } })
  if (!po) return null
  const [supplier, lines] = await Promise.all([prisma.supplier.findUnique({ where: { id: po.supplierId } }), prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id, tenantId } })])
  return new Promise<{ buffer: Buffer; po: typeof po; supplier: typeof supplier }>((resolve) => {
    const doc = new PDFDocument({ margin: 48 }), chunks: Buffer[] = []
    doc.on('data', (chunk) => chunks.push(chunk)); doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), po, supplier }))
    doc.fontSize(22).text('TradeFlow Purchase Order').moveDown().fontSize(12).text(`PO: ${po.code}`).text(`Supplier: ${supplier?.name ?? po.supplierId}`).text(`Status: ${po.status}`).moveDown()
    lines.forEach((line) => doc.text(`${line.productId}  qty: ${line.orderedQty}  unit cost: ${line.unitCost}`))
    doc.moveDown().text(`Total: ${lines.reduce((sum, line) => sum + line.orderedQty * Number(line.unitCost), 0).toLocaleString()} MNT`); doc.end()
  })
}

router.get('/suppliers', async (req, res) => {
  const links = await prisma.supplierRelationship.findMany({ where: { tenantId: tenant(req), active: true } })
  const suppliers = await prisma.supplier.findMany({ where: { id: { in: links.map((link) => link.supplierId) } } })
  res.json(suppliers.map((supplier) => ({ ...supplier, relationship: links.find((link) => link.supplierId === supplier.id) })))
})
router.post('/suppliers', async (req, res) => {
  const input = z.object({ registrationNo: z.string().min(5), name: z.string().min(2), phone: z.string().optional(), email: z.email().optional(), address: z.string().optional(), category: z.string().optional(), paymentTerms: z.string().default('PREPAID'), creditDays: z.number().int().nonnegative().default(0) }).parse(req.body)
  const supplier = await prisma.supplier.upsert({ where: { registrationNo: input.registrationNo }, update: { name: input.name, phone: input.phone, email: input.email, address: input.address, category: input.category }, create: { registrationNo: input.registrationNo, name: input.name, phone: input.phone, email: input.email, address: input.address, category: input.category } })
  await prisma.supplierRelationship.upsert({ where: { tenantId_supplierId: { tenantId: tenant(req), supplierId: supplier.id } }, update: { paymentTerms: input.paymentTerms, creditDays: input.creditDays, active: true }, create: { tenantId: tenant(req), supplierId: supplier.id, paymentTerms: input.paymentTerms, creditDays: input.creditDays } })
  await audit(req, 'CREATE', 'Supplier', supplier.id, undefined, supplier)
  res.status(201).json(supplier)
})
router.get('/product-suppliers', async (req, res) => res.json(await prisma.productSupplier.findMany({ where: { tenantId: tenant(req), active: true }, orderBy: [{ productId: 'asc' }, { preferred: 'desc' }] })))
router.put('/suppliers/:supplierId/products/:productId', async (req, res) => {
  const input = z.object({ preferred: z.boolean().default(false), minOrderQty: z.number().int().positive().default(1), usualOrderQty: z.number().int().positive().optional(), leadTimeDays: z.number().int().nonnegative().default(0), unitCost: z.number().positive(), active: z.boolean().default(true) }).parse(req.body)
  const tenantId = tenant(req), supplierId = String(req.params.supplierId), productId = String(req.params.productId)
  const [relationship, product] = await Promise.all([prisma.supplierRelationship.findUnique({ where: { tenantId_supplierId: { tenantId, supplierId } } }), prisma.product.findFirst({ where: { id: productId, tenantId } })])
  if (!relationship || !product) return res.status(404).json({ message: 'Нийлүүлэгч эсвэл бүтээгдэхүүн олдсонгүй.' })
  const row = await prisma.$transaction(async (tx) => {
    if (input.preferred) await tx.productSupplier.updateMany({ where: { tenantId, productId, preferred: true }, data: { preferred: false } })
    return tx.productSupplier.upsert({ where: { tenantId_productId_supplierId: { tenantId, productId, supplierId } }, update: input, create: { ...input, tenantId, productId, supplierId } })
  })
  await audit(req, 'UPSERT', 'ProductSupplier', row.id, undefined, row)
  res.json(row)
})
router.get('/purchase-orders', async (req, res) => {
  const rows = await prisma.purchaseOrder.findMany({ where: { tenantId: tenant(req) }, orderBy: { createdAt: 'desc' } })
  const lines = await prisma.purchaseOrderLine.findMany({ where: { tenantId: tenant(req), purchaseOrderId: { in: rows.map((row) => row.id) } } })
  res.json(rows.map((row) => ({ ...row, lines: lines.filter((line) => line.purchaseOrderId === row.id) })))
})
router.get('/goods-receipts', async (req, res) => res.json(await prisma.goodsReceipt.findMany({ where: { tenantId: tenant(req) }, include: { lines: true }, orderBy: { receivedAt: 'desc' } })))
router.post('/purchase-orders/:id/transition', async (req, res) => { const input = z.object({ status: z.nativeEnum(PurchaseOrderStatus), confirmed: z.literal(true) }).parse(req.body); const row = await prisma.$transaction((tx) => transitionPurchaseOrder(tx, { tenantId: tenant(req), id: String(req.params.id), to: input.status })); await audit(req, 'TRANSITION', 'PurchaseOrder', row.id, undefined, row); res.json(row) })
router.post('/goods-receipts/:id/attachments', async (req, res) => { const input = z.object({ url: z.string().url(), mimeType: z.string().min(3) }).parse(req.body), tenantId = tenant(req), id = String(req.params.id); if (!await prisma.goodsReceipt.findFirst({ where: { id, tenantId } })) return res.status(404).json({ message: 'Хүлээн авалтын баримт олдсонгүй.' }); res.status(201).json(await prisma.goodsReceiptAttachment.create({ data: { tenantId, goodsReceiptId: id, ...input, createdBy: req.user!.id } })) })
router.post('/goods-receipts/:id/review', authorizePermission('procurement', 'update', Role.ADMIN, Role.MANAGER), async (req, res) => { const { approved } = z.object({ approved: z.boolean() }).parse(req.body), tenantId = tenant(req), id = String(req.params.id); const current = await prisma.goodsReceipt.findFirst({ where: { id, tenantId } }); if (!current) return res.status(404).json({ message: 'Хүлээн авалтын баримт олдсонгүй.' }); const row = await prisma.goodsReceipt.update({ where: { id }, data: { status: approved ? 'APPROVED' : 'REJECTED', reviewedBy: req.user!.id, reviewedAt: new Date() } }); await audit(req, approved ? 'APPROVE' : 'REJECT', 'GoodsReceipt', id, current, row); res.json(row) })
router.post('/purchase-orders', async (req, res) => {
  const input = z.object({ supplierId: z.string(), warehouseId: z.string(), expectedAt: z.coerce.date().optional(), notes: z.string().optional(), lines: z.array(z.object({ productId: z.string(), variantId: z.string().optional(), quantity: z.number().int().positive(), unitCost: z.number().positive() })).min(1) }).parse(req.body)
  const tenantId = tenant(req)
  const row = await prisma.$transaction(async (tx) => {
    const [relationship, warehouse] = await Promise.all([tx.supplierRelationship.findUnique({ where: { tenantId_supplierId: { tenantId, supplierId: input.supplierId } } }), tx.warehouse.findFirst({ where: { id: input.warehouseId, tenantId } })])
    if (!relationship || !warehouse) throw Object.assign(new Error('Нийлүүлэгч эсвэл агуулах олдсонгүй.'), { status: 404 })
    const po = await tx.purchaseOrder.create({ data: { tenantId, code: `PO-${Date.now()}`, supplierId: input.supplierId, warehouseId: input.warehouseId, expectedAt: input.expectedAt, notes: input.notes, createdBy: req.user!.id } })
    await tx.purchaseOrderLine.createMany({ data: input.lines.map((line) => ({ tenantId, purchaseOrderId: po.id, productId: line.productId, variantId: line.variantId, orderedQty: line.quantity, unitCost: line.unitCost })) })
    for (const line of input.lines) {
      const existingLinks = await tx.productSupplier.count({ where: { tenantId, productId: line.productId, active: true } })
      await tx.productSupplier.upsert({ where: { tenantId_productId_supplierId: { tenantId, productId: line.productId, supplierId: input.supplierId } }, update: { unitCost: line.unitCost, usualOrderQty: line.quantity, active: true }, create: { tenantId, productId: line.productId, supplierId: input.supplierId, preferred: existingLinks === 0, unitCost: line.unitCost, usualOrderQty: line.quantity } })
    }
    return po
  })
  await audit(req, 'CREATE', 'PurchaseOrder', row.id, undefined, row)
  res.status(201).json(row)
})
router.post('/purchase-orders/:id/receive', async (req, res) => {
  const input = z.object({ notes: z.string().optional(), lines: z.array(z.object({ lineId: z.string(), quantity: z.number().int().positive(), batchNumber: z.string().trim().min(1).optional(), expiresAt: z.coerce.date().optional(), damaged: z.number().int().nonnegative().default(0) }).refine((line) => line.damaged <= line.quantity, 'Гэмтсэн тоо хүлээн авсан тооноос их байж болохгүй.')).min(1) }).parse(req.body)
  const tenantId = tenant(req)
  const result = await prisma.$transaction(async (tx) => {
    await assertPeriodOpen(tx, tenantId)
    const po = await tx.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } })
    if (po?.status === PurchaseOrderStatus.DRAFT) throw Object.assign(new Error('PO-г review хийж SENT төлөвт оруулсны дараа хүлээн авна.'), { status: 409 })
    if (!po || po.status === PurchaseOrderStatus.CLOSED || po.status === PurchaseOrderStatus.CANCELLED) throw Object.assign(new Error('PO хүлээн авах боломжгүй.'), { status: 409 })
    const receipt = await tx.goodsReceipt.create({ data: { tenantId, code: `GR-${Date.now()}`, purchaseOrderId: po.id, supplierId: po.supplierId, warehouseId: po.warehouseId, notes: input.notes, receivedBy: req.user!.id } })
    for (const received of input.lines) {
      const line = await tx.purchaseOrderLine.findFirst({ where: { id: received.lineId, purchaseOrderId: po.id, tenantId } })
      if (!line || line.receivedQty + received.quantity > line.orderedQty) throw Object.assign(new Error('Хүлээн авалтын тоо PO-оос хэтэрсэн.'), { status: 409 })
      const product = await tx.product.findFirstOrThrow({ where: { id: line.productId, tenantId } })
      if (product.trackBatch && !received.batchNumber) throw Object.assign(new Error(`${product.name}: batch дугаар заавал оруулна.`), { status: 400 })
      if (product.trackExpiry && !received.expiresAt) throw Object.assign(new Error(`${product.name}: дуусах хугацаа заавал оруулна.`), { status: 400 })
      if (received.expiresAt && received.expiresAt <= new Date()) throw Object.assign(new Error(`${product.name}: хугацаа дууссан бараа хүлээн авах боломжгүй.`), { status: 400 })
      const accepted = received.quantity - received.damaged
      const expected = line.orderedQty - line.receivedQty
      const previousBalance = await tx.inventoryBalance.findUnique({ where: { tenantId_warehouseId_productId_variantId: { tenantId, warehouseId: po.warehouseId, productId: line.productId, variantId: line.variantId ?? '' } } })
      await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { receivedQty: { increment: received.quantity } } })
      await tx.goodsReceiptLine.create({ data: { tenantId, goodsReceiptId: receipt.id, purchaseOrderLineId: line.id, productId: line.productId, expectedQuantity: expected, receivedQuantity: received.quantity, acceptedQuantity: accepted, damagedQuantity: received.damaged, discrepancyQuantity: received.quantity - expected, batchNumber: received.batchNumber, expiresAt: received.expiresAt, unitCost: line.unitCost } })
      await applyStockMovement(tx, { tenantId, warehouseId: po.warehouseId, productId: line.productId, variantId: line.variantId, type: StockMovementType.RECEIPT, quantity: accepted, unitCost: Number(line.unitCost), reference: po.code, createdBy: req.user!.id })
      if (received.batchNumber) await tx.stockBatch.upsert({ where: { tenantId_warehouseId_productId_batchNumber: { tenantId, warehouseId: po.warehouseId, productId: line.productId, batchNumber: received.batchNumber } }, create: { tenantId, warehouseId: po.warehouseId, productId: line.productId, variantId: line.variantId, batchNumber: received.batchNumber, expiresAt: received.expiresAt, quantity: accepted }, update: { quantity: { increment: accepted }, expiresAt: received.expiresAt } })
      const previousQty = previousBalance?.onHand ?? 0
      const weightedCost = previousQty + accepted > 0 ? (Number(product.costPrice) * previousQty + Number(line.unitCost) * accepted) / (previousQty + accepted) : Number(line.unitCost)
      await tx.product.update({ where: { id: product.id }, data: { costPrice: weightedCost } })
      await tx.productSupplier.updateMany({ where: { tenantId, productId: product.id, supplierId: po.supplierId }, data: { lastPurchasedAt: new Date(), unitCost: line.unitCost } })
    }
    const allLines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id, tenantId } })
    const receiptTotal = input.lines.reduce((sum, received) => { const line = allLines.find((row) => row.id === received.lineId); return sum + (line ? received.quantity * Number(line.unitCost) : 0) }, 0)
    if (receiptTotal > 0) await tx.supplierPayable.create({ data: { tenantId, supplierId: po.supplierId, purchaseOrderId: po.id, amount: receiptTotal, dueDate: new Date(Date.now() + 30 * 86400000) } })
    const complete = allLines.every((line) => line.receivedQty >= line.orderedQty)
    const updated = await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: complete ? PurchaseOrderStatus.RECEIVED : PurchaseOrderStatus.PARTIALLY_RECEIVED } })
    return { ...updated, goodsReceipt: receipt }
  })
  await audit(req, 'RECEIVE', 'PurchaseOrder', result.id, undefined, result)
  await audit(req, 'CREATE', 'GoodsReceipt', result.goodsReceipt.id, undefined, result.goodsReceipt)
  res.json(result)
})
router.get('/purchase-orders/:id/pdf', async (req, res) => { const result = await purchaseOrderPdf(String(req.params.id), tenant(req)); if (!result) return res.status(404).json({ message: 'PO олдсонгүй.' }); res.type('application/pdf').attachment(`${result.po.code}.pdf`).send(result.buffer) })
router.post('/purchase-orders/:id/email', async (req, res) => { const result = await purchaseOrderPdf(String(req.params.id), tenant(req)); if (!result?.supplier?.email) return res.status(404).json({ message: 'Нийлүүлэгчийн имэйл олдсонгүй.' }); await sendMail(result.supplier.email, `${result.po.code} худалдан авалтын захиалга`, '<p>Хавсралтаар худалдан авалтын захиалгыг илгээлээ.</p>', [{ filename: `${result.po.code}.pdf`, content: result.buffer, contentType: 'application/pdf' }]); res.json({ message: 'PO имэйлээр илгээгдлээ.' }) })
router.get('/payables', async (req, res) => res.json(await prisma.supplierPayable.findMany({ where: { tenantId: tenant(req) }, orderBy: { createdAt: 'desc' } })))
router.post('/payables/:id/pay', async (req, res) => {
  const input = z.object({ amount: z.number().positive(), method: z.enum(['BANK', 'CASH']).default('BANK'), reference: z.string().min(3), paidAt: z.coerce.date().optional() }).parse(req.body)
  const tenantId = tenant(req)
  const result = await prisma.$transaction(async (tx) => {
    await assertPeriodOpen(tx, tenantId, input.paidAt ?? new Date())
    const duplicate = await tx.supplierPayment.findUnique({ where: { tenantId_reference: { tenantId, reference: input.reference } } })
    if (duplicate) return { payment: duplicate, idempotent: true }
    const current = await tx.supplierPayable.findFirst({ where: { id: String(req.params.id), tenantId } })
    if (!current || Number(current.paidAmount) + input.amount > Number(current.amount)) throw Object.assign(new Error('Төлбөрийн дүн буруу.'), { status: 409 })
    const payment = await tx.supplierPayment.create({ data: { tenantId, supplierId: current.supplierId, supplierPayableId: current.id, amount: input.amount, method: input.method, reference: input.reference, paidAt: input.paidAt, recordedBy: req.user!.id } })
    const payable = await tx.supplierPayable.update({ where: { id: current.id }, data: { paidAmount: { increment: input.amount }, status: Number(current.paidAmount) + input.amount >= Number(current.amount) ? 'PAID' : 'PARTIAL' } })
    const period = payment.paidAt.toISOString().slice(0, 7)
    await tx.financialEntry.createMany({ data: [{ tenantId, account: 'ACCOUNTS_PAYABLE', reference: input.reference, debit: input.amount, period, createdBy: req.user!.id }, { tenantId, account: input.method, reference: input.reference, credit: input.amount, period, createdBy: req.user!.id }] })
    return { payment, payable, idempotent: false }
  }, { isolationLevel: 'Serializable' })
  await audit(req, 'PAY', 'SupplierPayable', String(req.params.id), undefined, result)
  res.status(result.idempotent ? 200 : 201).json(result)
})
export default router
