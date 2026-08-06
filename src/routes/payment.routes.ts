import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { stripe } from '../lib/services.js'
import { authenticate } from '../middleware/auth.js'
import crypto from 'node:crypto'
import bcrypt from 'bcrypt'
import { audit } from '../lib/audit.js'

const router = Router()
router.post('/intent', authenticate, async (req, res) => {
  if (!stripe) return res.status(503).json({ message: 'Stripe тохиргоо хийгдээгүй.' })
  const { orderId } = z.object({ orderId: z.string() }).parse(req.body)
  const order = await prisma.order.findFirst({ where: { id: orderId, userId: req.user!.id } })
  if (!order) return res.status(404).json({ message: 'Захиалга олдсонгүй.' })
  const intent = await stripe.paymentIntents.create({ amount: Math.round(Number(order.total) * 100), currency: 'mnt', metadata: { orderId: order.id, userId: req.user!.id }, automatic_payment_methods: { enabled: true } })
  await prisma.order.update({ where: { id: order.id }, data: { stripePaymentId: intent.id } })
  res.json({ clientSecret: intent.client_secret })
})
router.post('/checkout-session', authenticate, async (req, res) => {
  if (!stripe) return res.status(503).json({ message: 'Stripe тохиргоо хийгдээгүй байна.' })
  const { orderId } = z.object({ orderId: z.string() }).parse(req.body)
  const order = await prisma.order.findFirst({ where: { id: orderId, userId: req.user!.id }, include: { items: { include: { product: true } } } })
  if (!order) return res.status(404).json({ message: 'Захиалга олдсонгүй.' })
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173'
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: req.user!.email.includes('@guest.tradeflow.local') ? undefined : req.user!.email,
    line_items: [
      ...order.items.map((item) => ({ quantity: item.quantity, price_data: { currency: 'mnt', unit_amount: Math.round(Number(item.unitPrice) * 100), product_data: { name: item.product.name } } })),
      ...(Number(order.deliveryFee) > 0 ? [{ quantity: 1, price_data: { currency: 'mnt', unit_amount: Math.round(Number(order.deliveryFee) * 100), product_data: { name: 'Хүргэлтийн төлбөр' } } }] : []),
    ],
    metadata: { orderId: order.id, userId: req.user!.id },
    success_url: `${frontendUrl}/orders?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}/checkout?payment=cancelled`,
  })
  await prisma.order.update({ where: { id: order.id }, data: { stripePaymentId: session.id } })
  res.status(201).json({ url: session.url })
})
router.post('/checkout-session/confirm', authenticate, async (req, res) => {
  if (!stripe) return res.status(503).json({ message: 'Stripe тохиргоо хийгдээгүй байна.' })
  const { sessionId } = z.object({ sessionId: z.string().min(5) }).parse(req.body)
  const session = await stripe.checkout.sessions.retrieve(sessionId)
  if (session.metadata?.userId !== req.user!.id) return res.status(403).json({ message: 'Төлбөрийн session-д хандах эрхгүй.' })
  if (session.payment_status !== 'paid' || !session.metadata.orderId) return res.status(409).json({ message: 'Төлбөр баталгаажаагүй байна.' })
  const order = await prisma.order.update({ where: { id: session.metadata.orderId }, data: { paymentStatus: 'SUCCEEDED', status: 'PAID' } })
  res.json({ paid: true, orderId: order.id })
})

router.post('/otp/request', async (req, res) => {
  const { phone } = z.object({ phone: z.string().min(8).max(20) }).parse(req.body)
  const code = String(crypto.randomInt(100000, 999999))
  const challenge = await prisma.otpChallenge.create({ data: { phone, codeHash: await bcrypt.hash(code, 10), expiresAt: new Date(Date.now() + 5 * 60000) } })
  res.status(201).json({ challengeId: challenge.id, expiresIn: 300, ...(process.env.NODE_ENV !== 'production' ? { devCode: code } : {}) })
})
router.post('/otp/verify', async (req, res) => {
  const input = z.object({ challengeId: z.string(), code: z.string().length(6) }).parse(req.body)
  const row = await prisma.otpChallenge.findUnique({ where: { id: input.challengeId } })
  if (!row || row.verifiedAt || row.expiresAt < new Date() || row.attempts >= 5) return res.status(400).json({ message: 'OTP хүчингүй.' })
  await prisma.otpChallenge.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } })
  if (!await bcrypt.compare(input.code, row.codeHash)) return res.status(400).json({ message: 'OTP код буруу.' })
  await prisma.otpChallenge.update({ where: { id: row.id }, data: { verifiedAt: new Date() } })
  res.json({ verified: true, phone: row.phone })
})
router.post('/qpay/invoice', authenticate, async (req, res) => {
  const { orderId } = z.object({ orderId: z.string() }).parse(req.body)
  const staff = ['ADMIN','MANAGER','ACCOUNTANT'].includes(req.user!.role)
  const order = await prisma.order.findFirst({ where: { id: orderId, tenantId: req.user!.tenantId, ...(staff ? {} : { userId: req.user!.id }) } })
  if (!order) return res.status(404).json({ message: 'Захиалга олдсонгүй.' })
  const invoiceId = `QP-${order.orderNumber}`, qrData = `qpay://pay?invoice=${encodeURIComponent(invoiceId)}&amount=${order.total}`
  const row = await prisma.qPayPayment.upsert({ where: { invoiceId }, update: {}, create: { tenantId: order.tenantId!, orderId: order.id, invoiceId, amount: order.total, qrData } })
  res.status(201).json(row)
})
router.post('/qpay/callback', async (req, res) => {
  const input = z.object({ invoiceId: z.string(), paymentId: z.string(), status: z.enum(['PAID','FAILED']) }).parse(req.body)
  const current = await prisma.qPayPayment.findUnique({ where: { invoiceId: input.invoiceId } })
  if (!current) return res.status(404).json({ message: 'QPay invoice олдсонгүй.' })
  if (current.status === 'PAID') return res.json({ idempotent: true, status: current.status })
  const row = await prisma.qPayPayment.update({ where: { id: current.id }, data: { paymentId: input.paymentId, status: input.status, callbackRaw: req.body, paidAt: input.status === 'PAID' ? new Date() : null } })
  if (input.status === 'PAID') await prisma.order.update({ where: { id: row.orderId }, data: { paymentStatus: 'SUCCEEDED', status: 'PAID' } })
  res.json({ idempotent: false, status: row.status })
})
router.post('/ebarimt/:orderId', authenticate, async (req, res) => {
  const staff = ['ADMIN','MANAGER','ACCOUNTANT'].includes(req.user!.role)
  const order = await prisma.order.findFirst({ where: { id: String(req.params.orderId), tenantId: req.user!.tenantId, ...(staff ? {} : { userId: req.user!.id }) }, include: { items: { include: { product: true } } } })
  if (!order) return res.status(404).json({ message: 'Захиалга олдсонгүй.' })
  const vat = order.items.reduce((sum, item) => sum + Number(item.unitPrice) * item.quantity * Number(item.product.vatRate) / (100 + Number(item.product.vatRate)), 0)
  const receipt = await prisma.ebarimtReceipt.upsert({ where: { orderId: order.id }, update: {}, create: { tenantId: order.tenantId!, orderId: order.id, receiptNo: `EB-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`, subtotal: order.subtotal, vat, total: order.total } })
  await audit(req, 'GENERATE', 'EbarimtReceipt', receipt.id, undefined, receipt)
  res.status(201).json(receipt)
})
router.get('/ebarimt/:orderId', authenticate, async (req, res) => { const row = await prisma.ebarimtReceipt.findFirst({ where: { orderId: String(req.params.orderId), tenantId: req.user!.tenantId! } }); row ? res.json(row) : res.status(404).json({ message: 'Баримт олдсонгүй.' }) })
export default router
