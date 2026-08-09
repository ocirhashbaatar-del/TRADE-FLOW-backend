import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { stripe } from '../lib/services.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'
import crypto from 'node:crypto'
import bcrypt from 'bcrypt'
import { audit } from '../lib/audit.js'
import { OrderStatus, Role } from '@prisma/client'
import { transitionOrder } from '../lib/order-state.js'
import { env } from '../config/env.js'
import { checkQPayInvoice, createQPayInvoice, qpayConfigured } from '../lib/qpay.js'
import { postPayment } from '../lib/payment-posting.js'
import { assertPeriodOpen } from '../lib/period-lock.js'
import { isEnabled } from '../lib/feature-flags.js'

const router = Router()
const stripeCurrency = (env.STRIPE_CURRENCY || 'mnt').toLowerCase()

router.post('/intent', authenticate, async (req, res) => {
  if (!isEnabled('stripe') || !stripe) return res.status(503).json({ message: 'Stripe тохиргоо хийгдээгүй.' })
  const { orderId } = z.object({ orderId: z.string() }).parse(req.body)
  const order = await prisma.order.findFirst({ where: { id: orderId, userId: req.user!.id } })
  if (!order) return res.status(404).json({ message: 'Захиалга олдсонгүй.' })
  const intent = await stripe.paymentIntents.create({ amount: Math.round(Number(order.total) * 100), currency: stripeCurrency, metadata: { orderId: order.id, userId: req.user!.id }, automatic_payment_methods: { enabled: true } })
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
    payment_method_types: ['card'],
    customer_email: req.user!.email.includes('@guest.tradeflow.local') ? undefined : req.user!.email,
    line_items: [
      ...order.items.map((item) => ({ quantity: item.quantity, price_data: { currency: stripeCurrency, unit_amount: Math.round(Number(item.unitPrice) * 100), product_data: { name: item.product.name } } })),
      ...(Number(order.deliveryFee) > 0 ? [{ quantity: 1, price_data: { currency: stripeCurrency, unit_amount: Math.round(Number(order.deliveryFee) * 100), product_data: { name: 'Хүргэлтийн төлбөр' } } }] : []),
    ],
    metadata: { orderId: order.id, userId: req.user!.id },
    success_url: `${frontendUrl}/orders?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}/checkout?payment=cancelled`,
  })
  await prisma.order.update({ where: { id: order.id }, data: { stripePaymentId: session.id } })
  res.status(201).json({ url: session.url })
})
router.post('/webhook', async (req, res) => {
  if (!stripe) return res.status(503).json({ message: 'Stripe тохиргоо хийгдээгүй байна.' })
  const signature = req.headers['stripe-signature']
  const secret = env.STRIPE_WEBHOOK_SECRET
  const payload = (req as typeof req & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}))
  const signatureValue = Array.isArray(signature) ? signature[0] : signature

  try {
    const event = secret && signatureValue
      ? stripe.webhooks.constructEvent(payload, signatureValue, secret)
      : {
          id: req.body?.id ?? 'dev-webhook',
          type: req.body?.type ?? 'checkout.session.completed',
          data: { object: req.body?.data?.object ?? req.body },
        }

    const object = (event.data?.object ?? req.body?.data?.object ?? req.body) as { metadata?: { orderId?: string }; payment_status?: string; id?: string }
    const eventType = event.type
    const orderId = object.metadata?.orderId

    if (eventType === 'checkout.session.completed' || eventType === 'payment_intent.succeeded') {
      if (!orderId) return res.status(400).json({ message: 'Stripe event-д захиалга олдсонгүй.' })
      await prisma.$transaction(async (tx) => {
        const current = await tx.order.findFirstOrThrow({ where: { id: orderId } })
        await postPayment(tx, { tenantId: current.tenantId!, customerId: current.userId, amount: Number(current.total), method: 'STRIPE', reference: `STRIPE:${object.id ?? 'stripe-webhook'}`, recordedBy: current.userId })
        await tx.order.update({ where: { id: orderId }, data: { paymentStatus: 'SUCCEEDED' } })
        await transitionOrder(tx, { tenantId: current.tenantId!, orderId, to: OrderStatus.PAID, changedBy: current.userId, reason: 'Stripe төлбөр баталгаажсан' })
      })
    }

    res.json({ received: true, type: eventType })
  } catch (error) {
    console.error('Stripe webhook failed', error)
    res.status(400).json({ message: 'Stripe webhook-ийг боловсруулах боломжгүй.' })
  }
})

router.post('/checkout-session/confirm', authenticate, async (req, res) => {
  if (!stripe) return res.status(503).json({ message: 'Stripe тохиргоо хийгдээгүй байна.' })
  const { sessionId } = z.object({ sessionId: z.string().min(5) }).parse(req.body)
  const session = await stripe.checkout.sessions.retrieve(sessionId)
  if (session.metadata?.userId !== req.user!.id) return res.status(403).json({ message: 'Төлбөрийн session-д хандах эрхгүй.' })
  if (session.payment_status !== 'paid' || !session.metadata.orderId) return res.status(409).json({ message: 'Төлбөр баталгаажаагүй байна.' })
  const order = await prisma.$transaction(async (tx) => {
    const current = await tx.order.findFirstOrThrow({ where: { id: session.metadata!.orderId!, userId: req.user!.id } })
    await postPayment(tx, { tenantId: current.tenantId!, customerId: current.userId, amount: Number(current.total), method: 'STRIPE', reference: `STRIPE:${session.id}`, recordedBy: req.user!.id })
    await tx.order.update({ where: { id: session.metadata!.orderId! }, data: { paymentStatus: 'SUCCEEDED' } })
    return transitionOrder(tx, { tenantId: req.user!.tenantId!, orderId: session.metadata!.orderId!, to: OrderStatus.PAID, changedBy: req.user!.id, reason: 'Stripe төлбөр баталгаажсан' })
  })
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
  if (!isEnabled('qpay') || !qpayConfigured()) return res.status(503).json({ message: 'QPay production тохиргоо дутуу байна.' })
  const { orderId } = z.object({ orderId: z.string() }).parse(req.body)
  const staff = ['ADMIN','MANAGER','ACCOUNTANT'].includes(req.user!.role)
  const order = await prisma.order.findFirst({ where: { id: orderId, tenantId: req.user!.tenantId, ...(staff ? {} : { userId: req.user!.id }) } })
  if (!order) return res.status(404).json({ message: 'Захиалга олдсонгүй.' })
  const previous = await prisma.qPayPayment.findFirst({ where: { orderId: order.id, status: 'PENDING' } })
  if (previous) return res.json(previous)
  const senderInvoiceNo = `TF-${order.orderNumber}-${Date.now()}`
  const callbackUrl = `${env.BACKEND_PUBLIC_URL}/api/v1/payments/qpay/callback?token=${encodeURIComponent(env.QPAY_CALLBACK_TOKEN!)}&senderInvoiceNo=${encodeURIComponent(senderInvoiceNo)}`
  const invoice = await createQPayInvoice({ senderInvoiceNo, amount: Number(order.total), description: `${order.orderNumber} захиалгын төлбөр`, callbackUrl })
  const row = await prisma.qPayPayment.create({ data: { tenantId: order.tenantId!, orderId: order.id, invoiceId: invoice.invoiceId, senderInvoiceNo, amount: order.total, qrData: invoice.qrText, qrImage: invoice.qrImage, urls: invoice.urls } })
  res.status(201).json(row)
})
router.post('/qpay/callback', async (req, res) => {
  const input = z.object({ token: z.string(), senderInvoiceNo: z.string() }).parse(req.query)
  const expected = env.QPAY_CALLBACK_TOKEN ?? ''
  if (!expected || input.token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(input.token), Buffer.from(expected))) return res.status(401).json({ message: 'QPay callback token буруу.' })
  const current = await prisma.qPayPayment.findUnique({ where: { senderInvoiceNo: input.senderInvoiceNo } })
  if (!current) return res.status(404).json({ message: 'QPay invoice олдсонгүй.' })
  if (current.status === 'PAID') return res.json({ idempotent: true, status: current.status })
  const verified = await checkQPayInvoice(current.invoiceId)
  if (!verified.paid || verified.paidAmount < Number(current.amount)) return res.status(409).json({ message: 'QPay төлбөр бүрэн баталгаажаагүй байна.' })
  await prisma.$transaction(async (tx) => {
    const row = await tx.qPayPayment.update({ where: { id: current.id }, data: { paymentId: verified.paymentId, status: 'PAID', callbackRaw: verified.raw, paidAt: new Date() } })
    const order = await tx.order.findUniqueOrThrow({ where: { id: row.orderId } })
    await postPayment(tx, { tenantId: order.tenantId!, customerId: order.userId, amount: Number(row.amount), method: 'QPAY', reference: `QPAY:${row.paymentId ?? row.invoiceId}` })
    await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'SUCCEEDED' } })
    await transitionOrder(tx, { tenantId: order.tenantId!, orderId: order.id, to: OrderStatus.PAID, reason: 'QPay төлбөр баталгаажсан' })
  })
  res.json({ idempotent: false, status: 'PAID' })
})
router.post('/bank-transfers', authenticate, requireTenant, async (req, res) => {
  const input = z.object({ orderId: z.string(), reference: z.string().min(3), amount: z.number().positive(), bankName: z.string().min(2), senderAccount: z.string().optional(), proofUrl: z.string().url().optional(), transferredAt: z.coerce.date() }).parse(req.body)
  const staff = [Role.ADMIN, Role.MANAGER, Role.ACCOUNTANT].some((role) => role === req.user!.role)
  const order = await prisma.order.findFirst({ where: { id: input.orderId, tenantId: req.user!.tenantId!, ...(staff ? {} : { userId: req.user!.id }) } })
  if (!order) return res.status(404).json({ message: 'Захиалга олдсонгүй.' })
  const customer = await prisma.customerAccount.findFirst({ where: { tenantId: order.tenantId!, userId: order.userId } })
  const row = await prisma.bankTransfer.create({ data: { ...input, tenantId: order.tenantId!, customerId: customer?.id ?? order.userId, submittedBy: req.user!.id } })
  res.status(201).json(row)
})
router.get('/bank-transfers', authenticate, requireTenant, async (req, res) => {
  const staff = [Role.ADMIN, Role.MANAGER, Role.ACCOUNTANT].some((role) => role === req.user!.role)
  res.json(await prisma.bankTransfer.findMany({ where: { tenantId: req.user!.tenantId!, ...(staff ? {} : { submittedBy: req.user!.id }) }, orderBy: { createdAt: 'desc' } }))
})
router.post('/bank-transfers/:id/approve', authenticate, requireTenant, authorize(Role.ADMIN, Role.MANAGER, Role.ACCOUNTANT), async (req, res) => {
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.bankTransfer.findFirst({ where: { id: String(req.params.id), tenantId: req.user!.tenantId! } })
    if (!current) throw Object.assign(new Error('Банкны шилжүүлэг олдсонгүй.'), { status: 404 })
    if (current.status !== 'PENDING') throw Object.assign(new Error('Энэ шилжүүлгийг өмнө нь шийдвэрлэсэн байна.'), { status: 409 })
    const posted = await postPayment(tx, { tenantId: current.tenantId, customerId: current.customerId, amount: Number(current.amount), method: 'BANK', reference: `BANK:${current.reference}`, recordedBy: req.user!.id, paidAt: current.transferredAt })
    const row = await tx.bankTransfer.update({ where: { id: current.id }, data: { status: 'APPROVED', reviewedBy: req.user!.id, reviewedAt: new Date(), paymentRecordId: posted.payment.id } })
    if (current.orderId) {
      const order = await tx.order.findUnique({ where: { id: current.orderId } })
      if (order && Number(current.amount) >= Number(order.total)) {
        await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'SUCCEEDED' } })
        await transitionOrder(tx, { tenantId: current.tenantId, orderId: order.id, to: OrderStatus.PAID, changedBy: req.user!.id, reason: 'Банкны шилжүүлэг баталгаажсан' })
      }
    }
    return row
  }, { isolationLevel: 'Serializable' })
  res.json(result)
})
router.post('/bank-transfers/:id/reject', authenticate, requireTenant, authorize(Role.ADMIN, Role.MANAGER, Role.ACCOUNTANT), async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body)
  const current = await prisma.bankTransfer.findFirst({ where: { id: String(req.params.id), tenantId: req.user!.tenantId!, status: 'PENDING' } })
  if (!current) return res.status(404).json({ message: 'Хүлээгдэж буй шилжүүлэг олдсонгүй.' })
  res.json(await prisma.bankTransfer.update({ where: { id: current.id }, data: { status: 'REJECTED', rejectionReason: reason, reviewedBy: req.user!.id, reviewedAt: new Date() } }))
})
router.post('/ebarimt/:orderId', authenticate, async (req, res) => {
  if (!isEnabled('eBarimt')) return res.status(503).json({ message: 'E-barimt үйлчилгээ түр хаалттай.' })
  const staff = ['ADMIN','MANAGER','ACCOUNTANT'].includes(req.user!.role)
  const order = await prisma.order.findFirst({ where: { id: String(req.params.orderId), tenantId: req.user!.tenantId, ...(staff ? {} : { userId: req.user!.id }) }, include: { items: { include: { product: true } } } })
  if (!order) return res.status(404).json({ message: 'Захиалга олдсонгүй.' })
  const vat = order.items.reduce((sum, item) => sum + Number(item.unitPrice) * item.quantity * Number(item.product.vatRate) / (100 + Number(item.product.vatRate)), 0)
  const receipt = await prisma.$transaction(async (tx) => { await assertPeriodOpen(tx, order.tenantId!); return tx.ebarimtReceipt.upsert({ where: { orderId: order.id }, update: {}, create: { tenantId: order.tenantId!, orderId: order.id, receiptNo: `EB-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`, subtotal: order.subtotal, vat, total: order.total } }) })
  await audit(req, 'GENERATE', 'EbarimtReceipt', receipt.id, undefined, receipt)
  res.status(201).json(receipt)
})
router.get('/ebarimt/:orderId', authenticate, async (req, res) => { const row = await prisma.ebarimtReceipt.findFirst({ where: { orderId: String(req.params.orderId), tenantId: req.user!.tenantId! } }); row ? res.json(row) : res.status(404).json({ message: 'Баримт олдсонгүй.' }) })
export default router
