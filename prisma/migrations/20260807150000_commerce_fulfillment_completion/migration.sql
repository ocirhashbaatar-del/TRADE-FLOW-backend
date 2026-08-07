ALTER TABLE "Order" ADD COLUMN "couponCode" TEXT;
ALTER TABLE "Order" ADD COLUMN "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "deliveryZoneId" TEXT;
ALTER TABLE "Order" ADD COLUMN "trackingTokenHash" TEXT;
ALTER TABLE "Order" ADD COLUMN "creditApprovalStatus" TEXT;
ALTER TABLE "InventoryBalance" ADD COLUMN "pickLocation" TEXT;
CREATE UNIQUE INDEX "Order_trackingTokenHash_key" ON "Order"("trackingTokenHash");

CREATE TABLE "Coupon" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "code" TEXT NOT NULL, "type" TEXT NOT NULL, "value" DECIMAL(12,2) NOT NULL, "minSubtotal" DECIMAL(12,2) NOT NULL DEFAULT 0, "usageLimit" INTEGER, "usedCount" INTEGER NOT NULL DEFAULT 0, "startsAt" TIMESTAMP(3), "endsAt" TIMESTAMP(3), "active" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "Coupon_tenantId_code_key" ON "Coupon"("tenantId", "code");

CREATE TABLE "DeliveryZone" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "name" TEXT NOT NULL, "city" TEXT NOT NULL, "districts" TEXT[], "fee" DECIMAL(12,2) NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "DeliveryZone_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "DeliveryZone_tenantId_name_key" ON "DeliveryZone"("tenantId", "name");

CREATE TABLE "CreditApproval" ("id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "customerId" TEXT NOT NULL, "requestedBy" TEXT NOT NULL, "amount" DECIMAL(12,2) NOT NULL, "reason" TEXT, "status" TEXT NOT NULL DEFAULT 'PENDING', "reviewedBy" TEXT, "reviewedAt" TIMESTAMP(3), "orderId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "CreditApproval_pkey" PRIMARY KEY ("id"));
CREATE INDEX "CreditApproval_tenantId_status_idx" ON "CreditApproval"("tenantId", "status");
