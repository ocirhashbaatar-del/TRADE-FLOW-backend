import { PrismaClient } from '@prisma/client'
import { tenantContext } from './tenant-context.js'

const tenantModels = new Set([
  'User', 'Category', 'Product', 'RolePermission', 'StaffInvitation', 'AuditLog', 'ProductVariant', 'PriceRule',
  'Promotion', 'PriceHistory', 'Warehouse', 'InventoryBalance', 'StockMovement', 'StockBatch', 'StockReservation',
  'InventoryCount', 'StockTransfer', 'Shipment', 'ShipmentLine', 'SupplierRelationship', 'PurchaseOrder',
  'PurchaseOrderLine', 'Invoice', 'PaymentRecord', 'PaymentAllocation', 'QPayPayment', 'EbarimtReceipt',
  'FinancialEntry', 'PeriodLock', 'CustomerAccount', 'CustomerInvitation', 'ReturnRequest', 'SupplierPayable', 'Order',
])

const scopedWhere = (model: string, args: any) => {
  const tenantId = tenantContext.getStore()?.tenantId
  if (tenantId && tenantModels.has(model)) args.where = { ...(args.where ?? {}), tenantId }
  return args
}
const scopedCreate = (model: string, args: any) => {
  const tenantId = tenantContext.getStore()?.tenantId
  if (tenantId && tenantModels.has(model)) {
    if (Array.isArray(args.data)) args.data = args.data.map((row: object) => ({ ...row, tenantId }))
    else args.data = { ...(args.data ?? {}), tenantId }
  }
  return args
}

const basePrisma = new PrismaClient()
export const prisma: PrismaClient = basePrisma.$extends({
  query: {
    $allModels: {
      findMany({ model, args, query }) { return query(scopedWhere(model, args)) },
      findFirst({ model, args, query }) { return query(scopedWhere(model, args)) },
      count({ model, args, query }) { return query(scopedWhere(model, args)) },
      aggregate({ model, args, query }) { return query(scopedWhere(model, args)) },
      updateMany({ model, args, query }) { return query(scopedWhere(model, args)) },
      deleteMany({ model, args, query }) { return query(scopedWhere(model, args)) },
      create({ model, args, query }) { return query(scopedCreate(model, args)) },
      createMany({ model, args, query }) { return query(scopedCreate(model, args)) },
    },
  },
}) as unknown as PrismaClient
