ALTER TABLE "Category" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GoodsReceipt" ADD COLUMN "reviewedBy" TEXT;
ALTER TABLE "GoodsReceipt" ADD COLUMN "reviewedAt" TIMESTAMP(3);

CREATE TABLE "ProductImage" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "productId" TEXT NOT NULL,
  "url" TEXT NOT NULL, "publicId" TEXT, "alt" TEXT, "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProductImage_tenantId_productId_url_key" ON "ProductImage"("tenantId", "productId", "url");
CREATE INDEX "ProductImage_tenantId_productId_sortOrder_idx" ON "ProductImage"("tenantId", "productId", "sortOrder");

CREATE TABLE "WarehouseLocation" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "warehouseId" TEXT NOT NULL, "code" TEXT NOT NULL,
  "zone" TEXT, "aisle" TEXT, "rack" TEXT, "bin" TEXT, "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "WarehouseLocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WarehouseLocation_tenantId_warehouseId_code_key" ON "WarehouseLocation"("tenantId", "warehouseId", "code");
CREATE INDEX "WarehouseLocation_tenantId_warehouseId_sortOrder_idx" ON "WarehouseLocation"("tenantId", "warehouseId", "sortOrder");

CREATE TABLE "GoodsReceiptAttachment" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "goodsReceiptId" TEXT NOT NULL, "url" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL, "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoodsReceiptAttachment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GoodsReceiptAttachment_tenantId_goodsReceiptId_idx" ON "GoodsReceiptAttachment"("tenantId", "goodsReceiptId");

CREATE TABLE "ShipmentEvent" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "shipmentId" TEXT NOT NULL, "status" TEXT NOT NULL,
  "note" TEXT, "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ShipmentEvent_tenantId_shipmentId_createdAt_idx" ON "ShipmentEvent"("tenantId", "shipmentId", "createdAt");

CREATE TABLE "DeliveryManifest" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "code" TEXT NOT NULL, "partnerCode" TEXT NOT NULL,
  "shipmentIds" TEXT[], "status" TEXT NOT NULL DEFAULT 'DRAFT', "handedOffBy" TEXT, "handedOffAt" TIMESTAMP(3),
  "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliveryManifest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeliveryManifest_tenantId_code_key" ON "DeliveryManifest"("tenantId", "code");
CREATE INDEX "DeliveryManifest_tenantId_status_createdAt_idx" ON "DeliveryManifest"("tenantId", "status", "createdAt");

ALTER TABLE "OrderItem" ADD COLUMN "grossAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN "vatAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN "netAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN "contractNumber" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "paymentTerms" TEXT;

CREATE TABLE "ReminderDeliveryLog" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "invoiceId" TEXT NOT NULL, "channel" TEXT NOT NULL, "recipient" TEXT NOT NULL, "status" TEXT NOT NULL, "error" TEXT, "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdBy" TEXT, CONSTRAINT "ReminderDeliveryLog_pkey" PRIMARY KEY ("id"));
CREATE INDEX "ReminderDeliveryLog_tenantId_invoiceId_sentAt_idx" ON "ReminderDeliveryLog"("tenantId", "invoiceId", "sentAt");
CREATE TABLE "Refund" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "returnRequestId" TEXT NOT NULL, "paymentId" TEXT, "amount" DECIMAL(12,2) NOT NULL, "method" TEXT NOT NULL, "reference" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "processedBy" TEXT, "processedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Refund_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "Refund_tenantId_reference_key" ON "Refund"("tenantId", "reference");
CREATE INDEX "Refund_tenantId_returnRequestId_idx" ON "Refund"("tenantId", "returnRequestId");
CREATE TABLE "SavedOrderTemplate" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "customerId" TEXT NOT NULL, "name" TEXT NOT NULL, "lines" JSONB NOT NULL, "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "SavedOrderTemplate_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "SavedOrderTemplate_tenantId_customerId_name_key" ON "SavedOrderTemplate"("tenantId", "customerId", "name");
CREATE INDEX "SavedOrderTemplate_tenantId_customerId_idx" ON "SavedOrderTemplate"("tenantId", "customerId");

CREATE TABLE "PlanChangeHistory" ("id" TEXT NOT NULL,"tenantId" TEXT NOT NULL,"fromPlan" TEXT NOT NULL,"toPlan" TEXT NOT NULL,"changedBy" TEXT NOT NULL,"reason" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "PlanChangeHistory_pkey" PRIMARY KEY("id"));
CREATE INDEX "PlanChangeHistory_tenantId_createdAt_idx" ON "PlanChangeHistory"("tenantId","createdAt");
CREATE TABLE "TenantExportJob" ("id" TEXT NOT NULL,"tenantId" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'READY',"requestedBy" TEXT NOT NULL,"expiresAt" TIMESTAMP(3) NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "TenantExportJob_pkey" PRIMARY KEY("id"));
CREATE INDEX "TenantExportJob_tenantId_createdAt_idx" ON "TenantExportJob"("tenantId","createdAt");
CREATE TABLE "PlatformIncident" ("id" TEXT NOT NULL,"tenantId" TEXT,"severity" TEXT NOT NULL,"source" TEXT NOT NULL,"title" TEXT NOT NULL,"details" JSONB,"acknowledged" BOOLEAN NOT NULL DEFAULT false,"resolvedAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "PlatformIncident_pkey" PRIMARY KEY("id"));
CREATE INDEX "PlatformIncident_acknowledged_createdAt_idx" ON "PlatformIncident"("acknowledged","createdAt");
ALTER TABLE "Notification" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Notification_idempotencyKey_key" ON "Notification"("idempotencyKey");
CREATE TABLE "NotificationPreference" ("id" TEXT NOT NULL,"userId" TEXT NOT NULL,"type" "NotificationType" NOT NULL,"inApp" BOOLEAN NOT NULL DEFAULT true,"email" BOOLEAN NOT NULL DEFAULT false,"sms" BOOLEAN NOT NULL DEFAULT false,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY("id"));
CREATE UNIQUE INDEX "NotificationPreference_userId_type_key" ON "NotificationPreference"("userId","type");
