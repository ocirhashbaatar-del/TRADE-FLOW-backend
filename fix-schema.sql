
-- Idempotent fix: applies only what's missing from
-- 20260807203000_tenant_scope_inventory_variant and
-- 20260807223000_catalog_fulfillment_documents
-- Safe to run multiple times.
 
ALTER TABLE "CartItem" ADD COLUMN IF NOT EXISTS "variantId" TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS "CartItem_userId_productId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "CartItem_userId_productId_variantId_key" ON "CartItem"("userId", "productId", "variantId");
 
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "variantId" TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS "OrderItem_orderId_productId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "OrderItem_orderId_productId_variantId_key" ON "OrderItem"("orderId", "productId", "variantId");
 
ALTER TABLE "ProductVariant" ADD COLUMN IF NOT EXISTS "price" DECIMAL(12,2);
ALTER TABLE "PriceRule" ADD COLUMN IF NOT EXISTS "variantId" TEXT;
ALTER TABLE "ReturnRequest" ADD COLUMN IF NOT EXISTS "variantId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShipmentLine" ADD COLUMN IF NOT EXISTS "variantId" TEXT NOT NULL DEFAULT '';
 
DROP INDEX IF EXISTS "PriceRule_tenantId_productId_active_idx";
CREATE INDEX IF NOT EXISTS "PriceRule_tenantId_productId_variantId_active_idx" ON "PriceRule"("tenantId", "productId", "variantId", "active");
 
CREATE TABLE IF NOT EXISTS "SupplierPayment" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "supplierId" TEXT NOT NULL, "supplierPayableId" TEXT NOT NULL, "amount" DECIMAL(12,2) NOT NULL, "method" TEXT NOT NULL, "reference" TEXT NOT NULL, "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "recordedBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX IF NOT EXISTS "SupplierPayment_tenantId_reference_key" ON "SupplierPayment"("tenantId", "reference");
CREATE INDEX IF NOT EXISTS "SupplierPayment_tenantId_supplierId_paidAt_idx" ON "SupplierPayment"("tenantId", "supplierId", "paidAt");
 
ALTER TABLE "FinancialEntry" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'POSTING';
ALTER TABLE "FinancialEntry" ADD COLUMN IF NOT EXISTS "reversesId" TEXT;
CREATE INDEX IF NOT EXISTS "FinancialEntry_tenantId_reversesId_idx" ON "FinancialEntry"("tenantId", "reversesId");
 
ALTER TABLE "Category" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GoodsReceipt" ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT;
ALTER TABLE "GoodsReceipt" ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
 
CREATE TABLE IF NOT EXISTS "ProductImage" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "productId" TEXT NOT NULL,
  "url" TEXT NOT NULL, "publicId" TEXT, "alt" TEXT, "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProductImage_tenantId_productId_url_key" ON "ProductImage"("tenantId", "productId", "url");
CREATE INDEX IF NOT EXISTS "ProductImage_tenantId_productId_sortOrder_idx" ON "ProductImage"("tenantId", "productId", "sortOrder");
 
CREATE TABLE IF NOT EXISTS "WarehouseLocation" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "warehouseId" TEXT NOT NULL, "code" TEXT NOT NULL,
  "zone" TEXT, "aisle" TEXT, "rack" TEXT, "bin" TEXT, "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "WarehouseLocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WarehouseLocation_tenantId_warehouseId_code_key" ON "WarehouseLocation"("tenantId", "warehouseId", "code");
CREATE INDEX IF NOT EXISTS "WarehouseLocation_tenantId_warehouseId_sortOrder_idx" ON "WarehouseLocation"("tenantId", "warehouseId", "sortOrder");
 
CREATE TABLE IF NOT EXISTS "GoodsReceiptAttachment" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "goodsReceiptId" TEXT NOT NULL, "url" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL, "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoodsReceiptAttachment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "GoodsReceiptAttachment_tenantId_goodsReceiptId_idx" ON "GoodsReceiptAttachment"("tenantId", "goodsReceiptId");
 
CREATE TABLE IF NOT EXISTS "ShipmentEvent" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "shipmentId" TEXT NOT NULL, "status" TEXT NOT NULL,
  "note" TEXT, "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ShipmentEvent_tenantId_shipmentId_createdAt_idx" ON "ShipmentEvent"("tenantId", "shipmentId", "createdAt");
 
CREATE TABLE IF NOT EXISTS "DeliveryManifest" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "code" TEXT NOT NULL, "partnerCode" TEXT NOT NULL,
  "shipmentIds" TEXT[], "status" TEXT NOT NULL DEFAULT 'DRAFT', "handedOffBy" TEXT, "handedOffAt" TIMESTAMP(3),
  "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliveryManifest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryManifest_tenantId_code_key" ON "DeliveryManifest"("tenantId", "code");
CREATE INDEX IF NOT EXISTS "DeliveryManifest_tenantId_status_createdAt_idx" ON "DeliveryManifest"("tenantId", "status", "createdAt");
 
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "grossAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "vatAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "netAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "contractNumber" TEXT;
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "paymentTerms" TEXT;
 
CREATE TABLE IF NOT EXISTS "ReminderDeliveryLog" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "invoiceId" TEXT NOT NULL, "channel" TEXT NOT NULL, "recipient" TEXT NOT NULL, "status" TEXT NOT NULL, "error" TEXT, "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdBy" TEXT, CONSTRAINT "ReminderDeliveryLog_pkey" PRIMARY KEY ("id"));
CREATE INDEX IF NOT EXISTS "ReminderDeliveryLog_tenantId_invoiceId_sentAt_idx" ON "ReminderDeliveryLog"("tenantId", "invoiceId", "sentAt");
 
CREATE TABLE IF NOT EXISTS "Refund" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "returnRequestId" TEXT NOT NULL, "paymentId" TEXT, "amount" DECIMAL(12,2) NOT NULL, "method" TEXT NOT NULL, "reference" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "processedBy" TEXT, "processedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Refund_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX IF NOT EXISTS "Refund_tenantId_reference_key" ON "Refund"("tenantId", "reference");
CREATE INDEX IF NOT EXISTS "Refund_tenantId_returnRequestId_idx" ON "Refund"("tenantId", "returnRequestId");
 
CREATE TABLE IF NOT EXISTS "SavedOrderTemplate" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "customerId" TEXT NOT NULL, "name" TEXT NOT NULL, "lines" JSONB NOT NULL, "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "SavedOrderTemplate_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX IF NOT EXISTS "SavedOrderTemplate_tenantId_customerId_name_key" ON "SavedOrderTemplate"("tenantId", "customerId", "name");
CREATE INDEX IF NOT EXISTS "SavedOrderTemplate_tenantId_customerId_idx" ON "SavedOrderTemplate"("tenantId", "customerId");
 
CREATE TABLE IF NOT EXISTS "PlanChangeHistory" ("id" TEXT NOT NULL,"tenantId" TEXT NOT NULL,"fromPlan" TEXT NOT NULL,"toPlan" TEXT NOT NULL,"changedBy" TEXT NOT NULL,"reason" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "PlanChangeHistory_pkey" PRIMARY KEY("id"));
CREATE INDEX IF NOT EXISTS "PlanChangeHistory_tenantId_createdAt_idx" ON "PlanChangeHistory"("tenantId","createdAt");
 
CREATE TABLE IF NOT EXISTS "TenantExportJob" ("id" TEXT NOT NULL,"tenantId" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'READY',"requestedBy" TEXT NOT NULL,"expiresAt" TIMESTAMP(3) NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "TenantExportJob_pkey" PRIMARY KEY("id"));
CREATE INDEX IF NOT EXISTS "TenantExportJob_tenantId_createdAt_idx" ON "TenantExportJob"("tenantId","createdAt");
 
CREATE TABLE IF NOT EXISTS "PlatformIncident" ("id" TEXT NOT NULL,"tenantId" TEXT,"severity" TEXT NOT NULL,"source" TEXT NOT NULL,"title" TEXT NOT NULL,"details" JSONB,"acknowledged" BOOLEAN NOT NULL DEFAULT false,"resolvedAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "PlatformIncident_pkey" PRIMARY KEY("id"));
CREATE INDEX IF NOT EXISTS "PlatformIncident_acknowledged_createdAt_idx" ON "PlatformIncident"("acknowledged","createdAt");
 
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Notification_idempotencyKey_key" ON "Notification"("idempotencyKey");
 
CREATE TABLE IF NOT EXISTS "NotificationPreference" ("id" TEXT NOT NULL,"userId" TEXT NOT NULL,"type" "NotificationType" NOT NULL,"inApp" BOOLEAN NOT NULL DEFAULT true,"email" BOOLEAN NOT NULL DEFAULT false,"sms" BOOLEAN NOT NULL DEFAULT false,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY("id"));
CREATE UNIQUE INDEX IF NOT EXISTS "NotificationPreference_userId_type_key" ON "NotificationPreference"("userId","type");
 