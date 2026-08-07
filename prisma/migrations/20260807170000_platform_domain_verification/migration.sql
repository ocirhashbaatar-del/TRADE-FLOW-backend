ALTER TABLE "Tenant" ADD COLUMN "domainVerificationToken" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "domainVerifiedAt" TIMESTAMP(3);
