import type { Prisma } from '@prisma/client'
export const subscriptionPlans = { MVP: { users: 5, products: 500, warehouses: 1 }, GROWTH: { users: 30, products: 10000, warehouses: 10 }, ENTERPRISE: { users: 100000, products: 1000000, warehouses: 1000 } } as const
export async function assertSubscriptionCapacity(tx: Prisma.TransactionClient, tenantId: string, resource: 'users' | 'products' | 'warehouses') {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }), plan = subscriptionPlans[(tenant.subscription in subscriptionPlans ? tenant.subscription : 'MVP') as keyof typeof subscriptionPlans]
  const used = resource === 'users' ? await tx.user.count({ where: { tenantId } }) : resource === 'products' ? await tx.product.count({ where: { tenantId } }) : await tx.warehouse.count({ where: { tenantId } })
  if (used >= plan[resource]) throw Object.assign(new Error(`${tenant.subscription} багцын ${resource} хязгаар (${plan[resource]}) хүрсэн.`), { status: 402 })
}
