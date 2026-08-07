ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'CONFIRMED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'READY';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_SHIPPED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_DELIVERED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'RETURNED';
CREATE TYPE "BackorderStatus" AS ENUM ('NONE', 'OPEN', 'FULFILLED', 'CANCELLED');

ALTER TABLE "OrderItem" ADD COLUMN "appliedPriceSource" TEXT NOT NULL DEFAULT 'RETAIL';
ALTER TABLE "OrderItem" ADD COLUMN "shippedQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN "returnedQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN "backorderedQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN "backorderStatus" "BackorderStatus" NOT NULL DEFAULT 'NONE';
UPDATE "OrderItem" item SET "shippedQuantity" = item."quantity" FROM "Order" orders WHERE orders."id" = item."orderId" AND orders."status" IN ('SHIPPED', 'DELIVERED');

CREATE TABLE "OrderStatusHistory" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "fromStatus" "OrderStatus" NOT NULL,
  "toStatus" "OrderStatus" NOT NULL,
  "reason" TEXT,
  "changedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderStatusHistory_tenantId_orderId_createdAt_idx" ON "OrderStatusHistory"("tenantId", "orderId", "createdAt");
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProductSupplier" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "preferred" BOOLEAN NOT NULL DEFAULT false,
  "minOrderQty" INTEGER NOT NULL DEFAULT 1,
  "usualOrderQty" INTEGER,
  "leadTimeDays" INTEGER NOT NULL DEFAULT 0,
  "unitCost" DECIMAL(12,2) NOT NULL,
  "lastPurchasedAt" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductSupplier_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductSupplier_tenantId_productId_supplierId_key" ON "ProductSupplier"("tenantId", "productId", "supplierId");
CREATE INDEX "ProductSupplier_tenantId_productId_preferred_idx" ON "ProductSupplier"("tenantId", "productId", "preferred");

CREATE TABLE "CreditNote" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "invoiceId" TEXT,
  "orderId" TEXT NOT NULL,
  "returnRequestId" TEXT NOT NULL,
  "subtotal" DECIMAL(12,2) NOT NULL,
  "vat" DECIMAL(12,2) NOT NULL,
  "total" DECIMAL(12,2) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ISSUED',
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreditNote_returnRequestId_key" ON "CreditNote"("returnRequestId");
CREATE UNIQUE INDEX "CreditNote_tenantId_code_key" ON "CreditNote"("tenantId", "code");
CREATE INDEX "CreditNote_tenantId_orderId_idx" ON "CreditNote"("tenantId", "orderId");
ALTER TABLE "ReturnRequest" ADD COLUMN "creditNoteId" TEXT;
