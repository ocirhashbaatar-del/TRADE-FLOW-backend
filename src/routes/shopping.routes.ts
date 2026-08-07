import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()
router.use(authenticate)

const availableStock = async (productId: string, variantId: string, fallback: number) => {
  const balances = await prisma.inventoryBalance.aggregate({ where: { productId, variantId }, _sum: { onHand: true, reserved: true } })
  return Math.max(0, Math.min(fallback, (balances._sum.onHand ?? fallback) - (balances._sum.reserved ?? 0)))
}

const productShape = (product: any) => ({
  id: product.id,
  name: product.name,
  category: product.category.name,
  vendor: product.vendor.name,
  price: Number(product.price),
  compareAt: product.compareAt ? Number(product.compareAt) : undefined,
  rating: product.rating,
  reviews: product.reviewCount,
  stock: product.stock,
  image: product.image,
  description: product.description,
  featured: product.featured,
  tags: product.tags,
})

router.get('/', async (req, res) => {
  const [cart, saved] = await Promise.all([
    prisma.cartItem.findMany({ where: { userId: req.user!.id, product: { active: true } }, include: { product: { include: { category: true, vendor: true } } }, orderBy: { createdAt: 'asc' } }),
    prisma.savedProduct.findMany({ where: { userId: req.user!.id, product: { active: true } }, orderBy: { createdAt: 'desc' } }),
  ])
  const variants = await prisma.productVariant.findMany({ where: { id: { in: cart.map((item) => item.variantId).filter(Boolean) } } })
  res.json({ cart: cart.map((item) => ({ ...productShape(item.product), id: item.variantId ? `${item.productId}:${item.variantId}` : item.productId, productId: item.productId, variantId: item.variantId || undefined, variant: variants.find((variant) => variant.id === item.variantId), qty: item.quantity })), savedProductIds: saved.map((item) => item.productId) })
})

router.post('/cart/:productId', async (req, res) => {
  const { quantity, variantId = '' } = z.object({ quantity: z.coerce.number().int().min(1).max(99).default(1), variantId: z.string().optional() }).parse(req.body)
  const productId = String(req.params.productId)
  const product = await prisma.product.findFirst({ where: { id: productId, active: true } })
  if (!product) return res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' })
  if (variantId && !await prisma.productVariant.findFirst({ where: { id: variantId, productId, active: true } })) return res.status(404).json({ message: 'Бүтээгдэхүүний хувилбар олдсонгүй.' })
  const current = await prisma.cartItem.findUnique({ where: { userId_productId_variantId: { userId: req.user!.id, productId, variantId } } })
  const available = await availableStock(productId, variantId, product.stock)
  if ((current?.quantity ?? 0) + quantity > available) return res.status(409).json({ message: `Нөөцөд зөвхөн ${available} ширхэг байна.` })
  const item = await prisma.cartItem.upsert({
    where: { userId_productId_variantId: { userId: req.user!.id, productId, variantId } },
    update: { quantity: { increment: quantity } },
    create: { userId: req.user!.id, productId, variantId, quantity },
  })
  res.status(201).json({ quantity: item.quantity })
})

router.patch('/cart/:productId', async (req, res) => {
  const { quantity, variantId = '' } = z.object({ quantity: z.coerce.number().int().min(1).max(99), variantId: z.string().optional() }).parse(req.body)
  const productId = String(req.params.productId)
  const product = await prisma.product.findFirst({ where: { id: productId, active: true } })
  if (!product) return res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' })
  const available = await availableStock(productId, variantId, product.stock)
  if (quantity > available) return res.status(409).json({ message: `Нөөцөд зөвхөн ${available} ширхэг байна.` })
  const result = await prisma.cartItem.updateMany({ where: { userId: req.user!.id, productId, variantId }, data: { quantity } })
  result.count ? res.json({ quantity }) : res.status(404).json({ message: 'Сагсны бараа олдсонгүй.' })
})

router.delete('/cart/:productId', async (req, res) => {
  await prisma.cartItem.deleteMany({ where: { userId: req.user!.id, productId: String(req.params.productId), variantId: String(req.query.variantId ?? '') } })
  res.status(204).send()
})

router.delete('/cart', async (req, res) => {
  await prisma.cartItem.deleteMany({ where: { userId: req.user!.id } })
  res.status(204).send()
})

router.put('/saved/:productId', async (req, res) => {
  const productId = String(req.params.productId)
  const product = await prisma.product.findFirst({ where: { id: productId, active: true } })
  if (!product) return res.status(404).json({ message: 'Бүтээгдэхүүн олдсонгүй.' })
  await prisma.savedProduct.upsert({ where: { userId_productId: { userId: req.user!.id, productId } }, update: {}, create: { userId: req.user!.id, productId } })
  res.status(204).send()
})

router.delete('/saved/:productId', async (req, res) => {
  await prisma.savedProduct.deleteMany({ where: { userId: req.user!.id, productId: String(req.params.productId) } })
  res.status(204).send()
})

export default router
