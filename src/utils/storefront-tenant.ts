import { prisma } from '../lib/prisma.js'

const configuredSlug = process.env.STOREFRONT_TENANT_SLUG?.trim() || 'tradeflow'

export async function findStorefrontTenant() {
  const configured = await prisma.tenant.findFirst({ where: { slug: configuredSlug, active: true } })
  if (configured) return configured

  const catalogProduct = await prisma.product.findFirst({
    where: { active: true, tenantId: { not: null } },
    select: { tenantId: true },
    orderBy: { createdAt: 'asc' },
  })
  if (catalogProduct?.tenantId) {
    const catalogTenant = await prisma.tenant.findFirst({ where: { id: catalogProduct.tenantId, active: true } })
    if (catalogTenant) return catalogTenant
  }

  return prisma.tenant.findFirst({ where: { active: true }, orderBy: { createdAt: 'asc' } })
}
