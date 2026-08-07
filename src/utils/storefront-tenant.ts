import { prisma } from '../lib/prisma.js'

const configuredSlug = process.env.STOREFRONT_TENANT_SLUG?.trim() || 'tradeflow'

export async function findStorefrontTenant(hostname?: string) {
  const host = hostname?.split(':')[0]?.toLowerCase()
  if (host && !['localhost', '127.0.0.1'].includes(host)) {
    const domainTenant = await prisma.tenant.findFirst({ where: { domain: host, domainVerifiedAt: { not: null }, active: true } })
    if (domainTenant) return domainTenant
  }
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
