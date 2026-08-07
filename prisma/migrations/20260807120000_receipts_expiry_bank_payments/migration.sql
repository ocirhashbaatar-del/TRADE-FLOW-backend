ALTER TABLE "Product" ADD COLUMN "trackExpiry" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "QPayPayment" ADD COLUMN "senderInvoiceNo" TEXT;
ALTER TABLE "QPayPayment" ADD COLUMN "qrImage" TEXT;
ALTER TABLE "QPayPayment" ADD COLUMN "urls" JSONB;
UPDATE "QPayPayment" SET "senderInvoiceNo" = "invoiceId" WHERE "senderInvoiceNo" IS NULL;
ALTER TABLE "QPayPayment" ALTER COLUMN "senderInvoiceNo" SET NOT NULL;
CREATE UNIQUE INDEX "QPayPayment_senderInvoiceNo_key" ON "QPayPayment"("senderInvoiceNo");

CREATE TABLE "GoodsReceipt" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "code" TEXT NOT NULL,
  "purchaseOrderId" TEXT NOT NULL, "supplierId" TEXT NOT NULL, "warehouseId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'POSTED', "notes" TEXT, "receivedBy" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GoodsReceipt_tenantId_code_key" ON "GoodsReceipt"("tenantId", "code");
CREATE INDEX "GoodsReceipt_tenantId_purchaseOrderId_receivedAt_idx" ON "GoodsReceipt"("tenantId", "purchaseOrderId", "receivedAt");

CREATE TABLE "GoodsReceiptLine" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "goodsReceiptId" TEXT NOT NULL,
  "purchaseOrderLineId" TEXT NOT NULL, "productId" TEXT NOT NULL,
  "expectedQuantity" INTEGER NOT NULL, "receivedQuantity" INTEGER NOT NULL,
  "acceptedQuantity" INTEGER NOT NULL, "damagedQuantity" INTEGER NOT NULL DEFAULT 0,
  "discrepancyQuantity" INTEGER NOT NULL DEFAULT 0, "batchNumber" TEXT, "expiresAt" TIMESTAMP(3),
  "unitCost" DECIMAL(12,2) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GoodsReceiptLine_tenantId_goodsReceiptId_idx" ON "GoodsReceiptLine"("tenantId", "goodsReceiptId");
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExpiryAlert" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "batchId" TEXT NOT NULL,
  "alertType" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExpiryAlert_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExpiryAlert_batchId_alertType_key" ON "ExpiryAlert"("batchId", "alertType");
CREATE INDEX "ExpiryAlert_tenantId_expiresAt_idx" ON "ExpiryAlert"("tenantId", "expiresAt");

CREATE TABLE "BankTransfer" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "reference" TEXT NOT NULL,
  "orderId" TEXT, "customerId" TEXT NOT NULL, "amount" DECIMAL(12,2) NOT NULL,
  "bankName" TEXT NOT NULL, "senderAccount" TEXT, "proofUrl" TEXT,
  "transferredAt" TIMESTAMP(3) NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING',
  "submittedBy" TEXT NOT NULL, "reviewedBy" TEXT, "reviewedAt" TIMESTAMP(3),
  "rejectionReason" TEXT, "paymentRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BankTransfer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BankTransfer_tenantId_reference_key" ON "BankTransfer"("tenantId", "reference");
CREATE INDEX "BankTransfer_tenantId_status_transferredAt_idx" ON "BankTransfer"("tenantId", "status", "transferredAt");
