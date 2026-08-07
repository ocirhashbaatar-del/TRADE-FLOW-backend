DROP INDEX IF EXISTS "Product_tenantId_sku_idx";
CREATE UNIQUE INDEX "Product_tenantId_sku_key" ON "Product"("tenantId", "sku");
