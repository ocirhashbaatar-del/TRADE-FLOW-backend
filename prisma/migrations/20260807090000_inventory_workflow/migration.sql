CREATE TYPE "InventoryCountStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "StockTransferStatus" AS ENUM ('DRAFT', 'SHIPPED', 'RECEIVED', 'CANCELLED');

CREATE TABLE "InventoryCount" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "warehouseId" TEXT NOT NULL,
  "status" "InventoryCountStatus" NOT NULL DEFAULT 'PENDING',
  "createdBy" TEXT NOT NULL,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryCount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryCountLine" (
  "id" TEXT NOT NULL,
  "countId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "variantId" TEXT,
  "systemQty" INTEGER NOT NULL,
  "countedQty" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  CONSTRAINT "InventoryCountLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StockTransfer" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "fromWarehouseId" TEXT NOT NULL,
  "toWarehouseId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "variantId" TEXT,
  "quantity" INTEGER NOT NULL,
  "receivedQuantity" INTEGER,
  "reason" TEXT NOT NULL,
  "status" "StockTransferStatus" NOT NULL DEFAULT 'DRAFT',
  "createdBy" TEXT NOT NULL,
  "shippedBy" TEXT,
  "receivedBy" TEXT,
  "shippedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InventoryCount_tenantId_status_createdAt_idx" ON "InventoryCount"("tenantId", "status", "createdAt");
CREATE UNIQUE INDEX "InventoryCountLine_countId_productId_variantId_key" ON "InventoryCountLine"("countId", "productId", "variantId");
CREATE UNIQUE INDEX "StockTransfer_tenantId_reference_key" ON "StockTransfer"("tenantId", "reference");
CREATE INDEX "StockTransfer_tenantId_status_createdAt_idx" ON "StockTransfer"("tenantId", "status", "createdAt");
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "InventoryCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
