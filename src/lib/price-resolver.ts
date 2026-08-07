import type { Prisma } from '@prisma/client'

type Db = Prisma.TransactionClient
export async function resolvePrice(db: Db, input: { tenantId: string; productId: string; variantId?: string; quantity: number; customerId?: string; groupCode?: string }) {
  const now = new Date()
  const product = await db.product.findFirstOrThrow({ where: { id: input.productId, tenantId: input.tenantId, active: true } })
  const rules = await db.priceRule.findMany({
    where: {
      tenantId: input.tenantId,
      productId: input.productId,
      active: true,
      OR: input.variantId ? [{ variantId: input.variantId }, { variantId: null }] : [{ variantId: null }],
      minQuantity: { lte: input.quantity },
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
    },
    orderBy: [{ priority: 'desc' }, { minQuantity: 'desc' }],
  })
  const selected = rules.find((rule) => input.customerId && rule.customerId === input.customerId)
    ?? rules.find((rule) => input.groupCode && rule.groupCode === input.groupCode)
    ?? rules.find((rule) => !rule.customerId && !rule.groupCode)
  const variant = input.variantId ? await db.productVariant.findFirstOrThrow({ where: { id: input.variantId, productId: input.productId, tenantId: input.tenantId, active: true } }) : null
  const basePrice = Number(selected?.price ?? variant?.price ?? product.price)
  const promotion = await db.promotion.findFirst({
    where: {
      tenantId: input.tenantId, active: true, minQuantity: { lte: input.quantity },
      OR: [{ productId: input.productId }, { categoryId: product.categoryId }],
      startsAt: { lte: now }, endsAt: { gte: now },
    },
    orderBy: { discountPct: 'desc' },
  })
  const discounted = promotion ? Math.max(0, basePrice - (promotion.discountAmt ? Number(promotion.discountAmt) : basePrice * Number(promotion.discountPct ?? 0) / 100)) : basePrice
  const ruleType = selected?.customerId ? 'CONTRACT' : selected?.groupCode ? 'GROUP' : 'TIER'
  return { price: discounted, source: promotion ? `PROMOTION:${promotion.id}` : selected ? `RULE:${ruleType}:${selected.id}` : 'RETAIL' }
}
