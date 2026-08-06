import { Router } from 'express'
import { Role, StockMovementType } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { audit } from '../lib/audit.js'
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
    return { balance, movement }
  })
  await audit(req, 'ADJUST', 'InventoryBalance', input.productId, undefined, row)
  res.status(201).json(row)
})
router.post('/transfers', staff, async (req, res) => {
  const input = z.object({ fromWarehouseId: z.string(), toWarehouseId: z.string(), productId: z.string(), variantId: z.string().optional(), quantity: z.number().int().positive(), reason: z.string().min(3) }).parse(req.body)
  const tenantId = req.user!.tenantId!, variantId = input.variantId ?? ''
  const result = await prisma.$transaction(async (tx) => {
    const warehouses = await tx.warehouse.count({ where: { tenantId, id: { in: [input.fromWarehouseId, input.toWarehouseId] }, active: true } })
    if (warehouses !== 2 || input.fromWarehouseId === input.toWarehouseId) throw Object.assign(new Error('Агуулахын сонголт буруу.'), { status: 400 })
    const moved = await tx.inventoryBalance.updateMany({ where: { tenantId, warehouseId: input.fromWarehouseId, productId: input.productId, variantId, onHand: { gte: input.quantity } }, data: { onHand: { decrement: input.quantity } } })
    if (!moved.count) throw Object.assign(new Error('Шилжүүлэх үлдэгдэл хүрэлцэхгүй.'), { status: 409 })
    await tx.inventoryBalance.upsert({ where: { tenantId_warehouseId_productId_variantId: { tenantId, warehouseId: input.toWarehouseId, productId: input.productId, variantId } }, create: { tenantId, warehouseId: input.toWarehouseId, productId: input.productId, variantId, onHand: input.quantity }, update: { onHand: { increment: input.quantity } } })
    const reference = `TR-${Date.now()}`
    await tx.stockMovement.createMany({ data: [
      { tenantId, warehouseId: input.fromWarehouseId, productId: input.productId, variantId: input.variantId, type: StockMovementType.TRANSFER_OUT, quantity: -input.quantity, reference, reason: input.reason, createdBy: req.user!.id },
      { tenantId, warehouseId: input.toWarehouseId, productId: input.productId, variantId: input.variantId, type: StockMovementType.TRANSFER_IN, quantity: input.quantity, reference, reason: input.reason, createdBy: req.user!.id },
    ] })
    return { reference, quantity: input.quantity }
  }, { isolationLevel: 'Serializable' })
  await audit(req, 'TRANSFER', 'InventoryBalance', input.productId, undefined, result)
  res.status(201).json(result)
})
router.post('/counts', staff, async (req, res) => {
  const input = z.object({ warehouseId: z.string(), lines: z.array(z.object({ productId: z.string(), variantId: z.string().optional(), counted: z.number().int().nonnegative(), reason: z.string().min(3) })).min(1) }).parse(req.body)
  const tenantId = req.user!.tenantId!
  const adjustments = await prisma.$transaction(async (tx) => {
    const rows = []
    for (const line of input.lines) {
      const variantId = line.variantId ?? ''
      const balance = await tx.inventoryBalance.findUnique({ where: { tenantId_warehouseId_productId_variantId: { tenantId, warehouseId: input.warehouseId, productId: line.productId, variantId } } })
      const difference = line.counted - (balance?.onHand ?? 0)
      if (balance) await tx.inventoryBalance.update({ where: { id: balance.id }, data: { onHand: line.counted } })
      else await tx.inventoryBalance.create({ data: { tenantId, warehouseId: input.warehouseId, productId: line.productId, variantId, onHand: line.counted } })
      if (difference) await tx.stockMovement.create({ data: { tenantId, warehouseId: input.warehouseId, productId: line.productId, variantId: line.variantId, type: StockMovementType.ADJUSTMENT, quantity: difference, reason: `Тооллого: ${line.reason}`, createdBy: req.user!.id } })
      rows.push({ productId: line.productId, system: balance?.onHand ?? 0, counted: line.counted, difference })
    }
    return rows
  })
  res.status(201).json(adjustments)
})
router.get('/reorder-suggestions', async (req, res) => {
  const tenantId = req.user!.tenantId!
  const products = await prisma.product.findMany({ where: { tenantId, active: true, reorderPoint: { gt: 0 } } })
  res.json(products.filter((p) => p.stock <= p.reorderPoint).map((p) => ({ productId: p.id, name: p.name, stock: p.stock, reorderPoint: p.reorderPoint, suggestedQuantity: Math.max(p.packSize, p.reorderPoint * 2 - p.stock) })))
})
export default router
