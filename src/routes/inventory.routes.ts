import { Router } from 'express'
import { InventoryCountStatus, NotificationType, Role, StockMovementType, StockTransferStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { audit } from '../lib/audit.js'
import { syncProductStock } from '../lib/inventory.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'

const router = Router()
router.use(authenticate, requireTenant)
const staff = authorize(Role.ADMIN, Role.MANAGER, Role.EMPLOYEE, Role.VENDOR)

router.get('/warehouses', async (req, res) => {
  res.json(await prisma.warehouse.findMany({ where: { tenantId: req.user!.tenantId! }, orderBy: { name: 'asc' } }))
})
router.post('/warehouses', staff, async (req, res) => {
  const input = z.object({ code: z.string().min(1), name: z.string().min(2), address: z.string().optional(), type: z.string().default('WAREHOUSE') }).parse(req.body)
  const row = await prisma.warehouse.create({ data: { ...input, tenantId: req.user!.tenantId! } })
  await audit(req, 'CREATE', 'Warehouse', row.id, undefined, row)
  res.status(201).json(row)
})
router.get('/balances', async (req, res) => {
  const query = z.object({ warehouseId: z.string().optional(), lowStock: z.coerce.boolean().optional() }).parse(req.query)
  const rows = await prisma.inventoryBalance.findMany({ where: { tenantId: req.user!.tenantId!, ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}) } })
  res.json(rows.map((row) => ({ ...row, available: row.onHand - row.reserved })))
})
router.get('/movements', async (req, res) => {
  res.json(await prisma.stockMovement.findMany({ where: { tenantId: req.user!.tenantId! }, orderBy: { createdAt: 'desc' }, take: 200 }))
})
router.post('/adjustments', staff, async (req, res) => {
  const input = z.object({ warehouseId: z.string(), productId: z.string(), variantId: z.string().optional(), quantity: z.number().int().refine((value) => value !== 0), reason: z.string().min(3) }).parse(req.body)
  const tenantId = req.user!.tenantId!
  const row = await prisma.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId, tenantId } })
    const product = await tx.product.findFirst({ where: { id: input.productId, tenantId } })
    if (!warehouse || !product) throw Object.assign(new Error('Агуулах эсвэл бүтээгдэхүүн олдсонгүй.'), { status: 404 })
    const balance = await tx.inventoryBalance.upsert({
      where: { tenantId_warehouseId_productId_variantId: { tenantId, warehouseId: input.warehouseId, productId: input.productId, variantId: input.variantId ?? '' } },
      create: { tenantId, warehouseId: input.warehouseId, productId: input.productId, variantId: input.variantId ?? '', onHand: input.quantity },
      update: { onHand: { increment: input.quantity } },
    })
    if (balance.onHand < 0) throw Object.assign(new Error('Үлдэгдэл сөрөг болох боломжгүй.'), { status: 409 })
    const movement = await tx.stockMovement.create({ data: { tenantId, warehouseId: input.warehouseId, productId: input.productId, variantId: input.variantId, type: StockMovementType.ADJUSTMENT, quantity: input.quantity, reason: input.reason, createdBy: req.user!.id } })
    await syncProductStock(tx, tenantId, input.productId)
    return { balance, movement }
  })
  await audit(req, 'ADJUST', 'InventoryBalance', input.productId, undefined, row)
  res.status(201).json(row)
})
router.post('/transfers', staff, async (req, res) => {
  const input = z.object({ fromWarehouseId: z.string(), toWarehouseId: z.string(), productId: z.string(), variantId: z.string().optional(), quantity: z.number().int().positive(), reason: z.string().min(3) }).parse(req.body)
  const tenantId = req.user!.tenantId!
  const result = await prisma.$transaction(async (tx) => {
    const warehouses = await tx.warehouse.count({ where: { tenantId, id: { in: [input.fromWarehouseId, input.toWarehouseId] }, active: true } })
    if (warehouses !== 2 || input.fromWarehouseId === input.toWarehouseId) throw Object.assign(new Error('Агуулахын сонголт буруу.'), { status: 400 })
    const product = await tx.product.findFirst({ where: { id: input.productId, tenantId, active: true } })
    if (!product) throw Object.assign(new Error('Бүтээгдэхүүн олдсонгүй.'), { status: 404 })
    return tx.stockTransfer.create({ data: { ...input, tenantId, reference: `TR-${Date.now()}`, createdBy: req.user!.id } })
  })
  await audit(req, 'CREATE', 'StockTransfer', result.id, undefined, result)
  res.status(201).json(result)
})
router.get('/transfers', async (req, res) => {
  res.json(await prisma.stockTransfer.findMany({ where: { tenantId: req.user!.tenantId! }, orderBy: { createdAt: 'desc' } }))
})
router.post('/transfers/:id/ship', staff, async (req, res) => {
  const tenantId = req.user!.tenantId!, id = String(req.params.id)
  const result = await prisma.$transaction(async (tx) => {
    const transfer = await tx.stockTransfer.findFirst({ where: { id, tenantId, status: StockTransferStatus.DRAFT } })
    if (!transfer) throw Object.assign(new Error('Илгээх боломжтой шилжүүлэг олдсонгүй.'), { status: 404 })
    const variantId = transfer.variantId ?? ''
    const balance = await tx.inventoryBalance.findUnique({ where: { tenantId_warehouseId_productId_variantId: { tenantId, warehouseId: transfer.fromWarehouseId, productId: transfer.productId, variantId } } })
    if (!balance || balance.onHand - balance.reserved < transfer.quantity) throw Object.assign(new Error('Шилжүүлэх боломжит үлдэгдэл хүрэлцэхгүй.'), { status: 409 })
    const moved = await tx.inventoryBalance.updateMany({ where: { id: balance.id, onHand: balance.onHand, reserved: balance.reserved }, data: { onHand: { decrement: transfer.quantity } } })
    if (!moved.count) throw Object.assign(new Error('Үлдэгдэл өөрчлөгдсөн тул дахин оролдоно уу.'), { status: 409 })
    await tx.stockMovement.create({ data: { tenantId, warehouseId: transfer.fromWarehouseId, productId: transfer.productId, variantId: transfer.variantId, type: StockMovementType.TRANSFER_OUT, quantity: -transfer.quantity, reference: transfer.reference, reason: transfer.reason, createdBy: req.user!.id } })
    await syncProductStock(tx, tenantId, transfer.productId)
    return tx.stockTransfer.update({ where: { id }, data: { status: StockTransferStatus.SHIPPED, shippedBy: req.user!.id, shippedAt: new Date() } })
  }, { isolationLevel: 'Serializable' })
  await audit(req, 'SHIP', 'StockTransfer', id, undefined, result)
  res.json(result)
})
router.post('/transfers/:id/receive', staff, async (req, res) => {
  const input = z.object({ receivedQuantity: z.number().int().nonnegative().optional() }).parse(req.body)
  const tenantId = req.user!.tenantId!, id = String(req.params.id)
  const result = await prisma.$transaction(async (tx) => {
    const transfer = await tx.stockTransfer.findFirst({ where: { id, tenantId, status: StockTransferStatus.SHIPPED } })
    if (!transfer) throw Object.assign(new Error('Хүлээн авах боломжтой шилжүүлэг олдсонгүй.'), { status: 404 })
    const receivedQuantity = input.receivedQuantity ?? transfer.quantity
    if (receivedQuantity > transfer.quantity) throw Object.assign(new Error('Хүлээн авсан тоо илгээсэн тооноос их байж болохгүй.'), { status: 400 })
    const variantId = transfer.variantId ?? ''
    await tx.inventoryBalance.upsert({ where: { tenantId_warehouseId_productId_variantId: { tenantId, warehouseId: transfer.toWarehouseId, productId: transfer.productId, variantId } }, create: { tenantId, warehouseId: transfer.toWarehouseId, productId: transfer.productId, variantId, onHand: receivedQuantity }, update: { onHand: { increment: receivedQuantity } } })
    await tx.stockMovement.create({ data: { tenantId, warehouseId: transfer.toWarehouseId, productId: transfer.productId, variantId: transfer.variantId, type: StockMovementType.TRANSFER_IN, quantity: receivedQuantity, reference: transfer.reference, reason: receivedQuantity === transfer.quantity ? transfer.reason : `${transfer.reason}; зөрүү: ${transfer.quantity - receivedQuantity}`, createdBy: req.user!.id } })
    await syncProductStock(tx, tenantId, transfer.productId)
    return tx.stockTransfer.update({ where: { id }, data: { status: StockTransferStatus.RECEIVED, receivedQuantity, receivedBy: req.user!.id, receivedAt: new Date() } })
  }, { isolationLevel: 'Serializable' })
  await audit(req, 'RECEIVE', 'StockTransfer', id, undefined, result)
  res.json(result)
})
router.post('/counts', staff, async (req, res) => {
  const input = z.object({ warehouseId: z.string(), note: z.string().optional(), lines: z.array(z.object({ productId: z.string(), variantId: z.string().optional(), counted: z.number().int().nonnegative(), reason: z.string().min(3) })).min(1) }).parse(req.body)
  const tenantId = req.user!.tenantId!
  const count = await prisma.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId, tenantId, active: true } })
    if (!warehouse) throw Object.assign(new Error('Агуулах олдсонгүй.'), { status: 404 })
    const lines = []
    for (const line of input.lines) {
      const variantId = line.variantId ?? ''
      const balance = await tx.inventoryBalance.findUnique({ where: { tenantId_warehouseId_productId_variantId: { tenantId, warehouseId: input.warehouseId, productId: line.productId, variantId } } })
      lines.push({ productId: line.productId, variantId: line.variantId, systemQty: balance?.onHand ?? 0, countedQty: line.counted, reason: line.reason })
    }
    return tx.inventoryCount.create({ data: { tenantId, warehouseId: input.warehouseId, createdBy: req.user!.id, note: input.note, lines: { create: lines } }, include: { lines: true } })
  })
  await audit(req, 'CREATE', 'InventoryCount', count.id, undefined, count)
  res.status(201).json(count)
})
router.get('/counts', async (req, res) => res.json(await prisma.inventoryCount.findMany({ where: { tenantId: req.user!.tenantId! }, include: { lines: true }, orderBy: { createdAt: 'desc' } })))
router.post('/counts/:id/approve', authorize(Role.ADMIN, Role.MANAGER), async (req, res) => {
  const tenantId = req.user!.tenantId!, id = String(req.params.id)
  const result = await prisma.$transaction(async (tx) => {
    const count = await tx.inventoryCount.findFirst({ where: { id, tenantId, status: InventoryCountStatus.PENDING }, include: { lines: true } })
    if (!count) throw Object.assign(new Error('Батлах боломжтой тооллого олдсонгүй.'), { status: 404 })
    for (const line of count.lines) {
      const variantId = line.variantId ?? ''
      const balance = await tx.inventoryBalance.findUnique({ where: { tenantId_warehouseId_productId_variantId: { tenantId, warehouseId: count.warehouseId, productId: line.productId, variantId } } })
      const current = balance?.onHand ?? 0
      const difference = line.countedQty - current
      if (balance && line.countedQty < balance.reserved) throw Object.assign(new Error('Тоолсон үлдэгдэл идэвхтэй reservation-оос бага байна.'), { status: 409 })
      if (balance) await tx.inventoryBalance.update({ where: { id: balance.id }, data: { onHand: line.countedQty } })
      else await tx.inventoryBalance.create({ data: { tenantId, warehouseId: count.warehouseId, productId: line.productId, variantId, onHand: line.countedQty } })
      if (difference) await tx.stockMovement.create({ data: { tenantId, warehouseId: count.warehouseId, productId: line.productId, variantId: line.variantId, type: StockMovementType.ADJUSTMENT, quantity: difference, reference: `COUNT:${count.id}`, reason: `Батлагдсан тооллого: ${line.reason}`, createdBy: req.user!.id } })
      await syncProductStock(tx, tenantId, line.productId)
    }
    return tx.inventoryCount.update({ where: { id }, data: { status: InventoryCountStatus.APPROVED, reviewedBy: req.user!.id, reviewedAt: new Date() }, include: { lines: true } })
  }, { isolationLevel: 'Serializable' })
  await audit(req, 'APPROVE', 'InventoryCount', id, undefined, result)
  res.json(result)
})
router.post('/counts/:id/reject', authorize(Role.ADMIN, Role.MANAGER), async (req, res) => {
  const tenantId = req.user!.tenantId!, id = String(req.params.id)
  const result = await prisma.inventoryCount.updateMany({ where: { id, tenantId, status: InventoryCountStatus.PENDING }, data: { status: InventoryCountStatus.REJECTED, reviewedBy: req.user!.id, reviewedAt: new Date() } })
  if (!result.count) return res.status(404).json({ message: 'Татгалзах боломжтой тооллого олдсонгүй.' })
  res.json({ id, status: InventoryCountStatus.REJECTED })
})
router.get('/reorder-suggestions', async (req, res) => {
  const tenantId = req.user!.tenantId!
  const products = await prisma.product.findMany({ where: { tenantId, active: true, reorderPoint: { gt: 0 } } })
  const [balances, supplierLinks] = await Promise.all([prisma.inventoryBalance.findMany({ where: { tenantId, productId: { in: products.map((p) => p.id) } } }), prisma.productSupplier.findMany({ where: { tenantId, productId: { in: products.map((p) => p.id) }, active: true }, orderBy: [{ preferred: 'desc' }, { lastPurchasedAt: 'desc' }] })])
  const suggestions = products.map((product) => {
    const available = balances.filter((row) => row.productId === product.id).reduce((sum, row) => sum + row.onHand - row.reserved, 0)
    const supplier = supplierLinks.find((row) => row.productId === product.id)
    const calculated = Math.max(product.packSize, product.reorderPoint * 2 - available)
    return { productId: product.id, name: product.name, available, reorderPoint: product.reorderPoint, suggestedQuantity: Math.max(calculated, supplier?.minOrderQty ?? 1, supplier?.usualOrderQty ?? 0), supplier }
  }).filter((row) => row.available <= row.reorderPoint)
  res.json(suggestions)
})
router.post('/reorder-suggestions/draft-pos', staff, async (req, res) => {
  const input = z.object({ warehouseId: z.string(), productIds: z.array(z.string()).min(1).optional() }).parse(req.body)
  const tenantId = req.user!.tenantId!
  const result = await prisma.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId, tenantId, active: true } })
    if (!warehouse) throw Object.assign(new Error('Агуулах олдсонгүй.'), { status: 404 })
    const products = await tx.product.findMany({ where: { tenantId, active: true, reorderPoint: { gt: 0 }, ...(input.productIds ? { id: { in: input.productIds } } : {}) } })
    const balances = await tx.inventoryBalance.findMany({ where: { tenantId, productId: { in: products.map((row) => row.id) } } })
    const links = await tx.productSupplier.findMany({ where: { tenantId, productId: { in: products.map((row) => row.id) }, active: true }, orderBy: [{ preferred: 'desc' }, { lastPurchasedAt: 'desc' }] })
    const groups = new Map<string, Array<{ productId: string; quantity: number; unitCost: number }>>()
    for (const product of products) {
      const available = balances.filter((row) => row.productId === product.id).reduce((sum, row) => sum + row.onHand - row.reserved, 0)
      if (available > product.reorderPoint) continue
      const link = links.find((row) => row.productId === product.id)
      if (!link) throw Object.assign(new Error(`${product.name}: preferred supplier тохируулаагүй.`), { status: 409 })
      const quantity = Math.max(product.packSize, product.reorderPoint * 2 - available, link.minOrderQty, link.usualOrderQty ?? 0)
      groups.set(link.supplierId, [...(groups.get(link.supplierId) ?? []), { productId: product.id, quantity, unitCost: Number(link.unitCost) }])
    }
    const purchaseOrders = []
    let sequence = 0
    for (const [supplierId, lines] of groups) {
      const po = await tx.purchaseOrder.create({ data: { tenantId, code: `PO-R-${Date.now()}-${++sequence}`, supplierId, warehouseId: warehouse.id, status: 'DRAFT', notes: 'Reorder suggestion-оос автоматаар үүссэн', createdBy: req.user!.id, expectedAt: new Date(Date.now() + Math.max(...lines.map((line) => links.find((link) => link.productId === line.productId)?.leadTimeDays ?? 0)) * 86400000) } })
      await tx.purchaseOrderLine.createMany({ data: lines.map((line) => ({ tenantId, purchaseOrderId: po.id, productId: line.productId, orderedQty: line.quantity, unitCost: line.unitCost })) })
      purchaseOrders.push(po)
    }
    if (!purchaseOrders.length) throw Object.assign(new Error('Draft PO үүсгэх reorder suggestion алга.'), { status: 409 })
    const recipients = await tx.user.findMany({ where: { tenantId, role: { in: [Role.ADMIN, Role.MANAGER] } }, select: { id: true } })
    await tx.notification.createMany({ data: recipients.map((user) => ({ userId: user.id, title: 'Draft PO үүслээ', description: `${purchaseOrders.length} draft PO reorder suggestion-оос үүслээ.`, type: NotificationType.INVENTORY })) })
    return purchaseOrders
  }, { isolationLevel: 'Serializable' })
  await audit(req, 'CREATE_DRAFT_PO', 'PurchaseOrder', result.map((row) => row.id).join(','), undefined, result)
  res.status(201).json(result)
})
export default router
