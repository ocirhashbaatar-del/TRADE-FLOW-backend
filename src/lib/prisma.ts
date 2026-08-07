import { PrismaClient } from '@prisma/client'
import { tenantContext } from './tenant-context.js'

const tenantModels = new Set([
  'User', 'Category', 'Product', 'RolePermission', 'StaffInvitation', 'AuditLog', 'ProductVariant', 'PriceRule',
  'Promotion', 'PriceHistory', 'Warehouse', 'InventoryBalance', 'StockMovement', 'StockBatch', 'StockReservation',
  'InventoryCount', 'StockTransfer', 'Shipment', 'ShipmentLine', 'SupplierRelationship', 'PurchaseOrder',
  'PurchaseOrderLine', 'Invoice', 'PaymentRecord', 'PaymentAllocation', 'QPayPayment', 'EbarimtReceipt',
  'FinancialEntry', 'PeriodLock', 'CustomerAccount', 'CustomerInvitation', 'ReturnRequest', 'SupplierPayable', 'Order',
  'OrderStatusHistory', 'ProductSupplier', 'CreditNote',
  'GoodsReceipt', 'GoodsReceiptLine', 'ExpiryAlert', 'BankTransfer', 'SupplierPayment',
  'Coupon', 'DeliveryZone', 'CreditApproval', 'ProductImage', 'WarehouseLocation', 'GoodsReceiptAttachment',
  'ShipmentEvent', 'DeliveryManifest',
  'ReminderDeliveryLog', 'Refund', 'SavedOrderTemplate',
])
const appendOnlyModels = new Set(['AuditLog', 'StockMovement', 'FinancialEntry', 'PaymentAllocation', 'SupplierPayment'])
const assertMutable = (model: string) => { if (process.env.NODE_ENV !== 'test' && appendOnlyModels.has(model)) throw new Error(`${model} append-only тул update/delete хийх боломжгүй.`) }

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

const scopedUpsert = (model: string, args: any) => {
  scopedWhere(model, args)
  args.create = scopedCreate(model, { data: args.create }).data
  return args
}

const basePrisma = new PrismaClient()
export const prisma: PrismaClient = basePrisma.$extends({
  query: {
    $allModels: {
      findMany({ model, args, query }) { return query(scopedWhere(model, args)) },
      findFirst({ model, args, query }) { return query(scopedWhere(model, args)) },
      findFirstOrThrow({ model, args, query }) { return query(scopedWhere(model, args)) },
      findUnique({ model, args, query }) { return query(scopedWhere(model, args)) },
      findUniqueOrThrow({ model, args, query }) { return query(scopedWhere(model, args)) },
      count({ model, args, query }) { return query(scopedWhere(model, args)) },
      aggregate({ model, args, query }) { return query(scopedWhere(model, args)) },
      groupBy({ model, args, query }) { return query(scopedWhere(model, args)) },
      updateMany({ model, args, query }) { assertMutable(model); return query(scopedWhere(model, args)) },
      deleteMany({ model, args, query }) { assertMutable(model); return query(scopedWhere(model, args)) },
      update({ model, args, query }) { assertMutable(model); return query(scopedWhere(model, args)) },
      delete({ model, args, query }) { assertMutable(model); return query(scopedWhere(model, args)) },
      upsert({ model, args, query }) { assertMutable(model); return query(scopedUpsert(model, args)) },
      create({ model, args, query }) { return query(scopedCreate(model, args)) },
      createMany({ model, args, query }) { return query(scopedCreate(model, args)) },
    },
  },
}) as unknown as PrismaClient
