ALTER TABLE "CartItem" ADD COLUMN "variantId" TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS "CartItem_userId_productId_key";
CREATE UNIQUE INDEX "CartItem_userId_productId_variantId_key" ON "CartItem"("userId", "productId", "variantId");

ALTER TABLE "OrderItem" ADD COLUMN "variantId" TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS "OrderItem_orderId_productId_key";
CREATE UNIQUE INDEX "OrderItem_orderId_productId_variantId_key" ON "OrderItem"("orderId", "productId", "variantId");

ALTER TABLE "ProductVariant" ADD COLUMN "price" DECIMAL(12,2);
ALTER TABLE "PriceRule" ADD COLUMN "variantId" TEXT;
ALTER TABLE "ReturnRequest" ADD COLUMN "variantId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShipmentLine" ADD COLUMN "variantId" TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "PriceRule_tenantId_productId_active_idx";
CREATE INDEX "PriceRule_tenantId_productId_variantId_active_idx" ON "PriceRule"("tenantId", "productId", "variantId", "active");

CREATE TABLE "SupplierPayment" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "supplierId" TEXT NOT NULL, "supplierPayableId" TEXT NOT NULL, "amount" DECIMAL(12,2) NOT NULL, "method" TEXT NOT NULL, "reference" TEXT NOT NULL, "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "recordedBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "SupplierPayment_tenantId_reference_key" ON "SupplierPayment"("tenantId", "reference");
CREATE INDEX "SupplierPayment_tenantId_supplierId_paidAt_idx" ON "SupplierPayment"("tenantId", "supplierId", "paidAt");

ALTER TABLE "FinancialEntry" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'POSTING';
ALTER TABLE "FinancialEntry" ADD COLUMN "reversesId" TEXT;
CREATE INDEX "FinancialEntry_tenantId_reversesId_idx" ON "FinancialEntry"("tenantId", "reversesId");
