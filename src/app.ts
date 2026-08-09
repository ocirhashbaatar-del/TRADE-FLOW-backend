import compression from 'compression'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import morgan from 'morgan'
import swaggerUi from 'swagger-ui-express'
import { env, frontendOrigins } from './config/env.js'
import authRoutes from './routes/auth.routes.js'
import categoryRoutes from './routes/category.routes.js'
import chatRoutes from './routes/chat.routes.js'
import notificationRoutes from './routes/notification.routes.js'
import orderRoutes from './routes/order.routes.js'
import paymentRoutes from './routes/payment.routes.js'
import productRoutes from './routes/product.routes.js'
import uploadRoutes from './routes/upload.routes.js'
import assetRoutes from './routes/asset.routes.js'
import inventoryRoutes from './routes/inventory.routes.js'
import procurementRoutes from './routes/procurement.routes.js'
import pricingRoutes from './routes/pricing.routes.js'
import fulfillmentRoutes from './routes/fulfillment.routes.js'
import financeRoutes from './routes/finance.routes.js'
import reportRoutes from './routes/report.routes.js'
import b2bRoutes from './routes/b2b.routes.js'
import deliveryRoutes from './routes/delivery.routes.js'
import adminRoutes from './routes/admin.routes.js'
import catalogRoutes from './routes/catalog.routes.js'
import shoppingRoutes from './routes/shopping.routes.js'
import transportRoutes from './routes/transport.routes.js'
import commerceRoutes from './routes/commerce.routes.js'
import platformExportRoutes from './routes/platform-export.routes.js'
import { errorHandler, notFound } from './middleware/error.js'
import { openApiSpec } from './swagger.js'
import { requestContext } from './middleware/request-context.js'
import { notifyTenant } from './socket.js'
import { prisma } from './lib/prisma.js'
import { checkoutRateLimit, qpayCallbackRateLimit } from './lib/rate-limits.js'

export const app = express()
app.set('trust proxy', 1)
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors({
  origin: (origin, callback) => callback(null, !origin || frontendOrigins.includes(origin.replace(/\/$/, ''))),
  credentials: true,
}))
app.use(compression())
app.use(requestContext)
app.use(cookieParser())
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))
app.use((req, res, next) => {
  res.on('finish', () => {
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
    const realtimeRequest = req as typeof req & { realtimeEmitted?: boolean }
    if (mutation && res.statusCode >= 200 && res.statusCode < 300 && req.user?.tenantId && !realtimeRequest.realtimeEmitted) {
      notifyTenant(req.user.tenantId, 'entity.updated', { action: req.method, entityType: req.path.split('/').filter(Boolean)[2] ?? 'resource', entityId: req.params.id ?? '', actorId: req.user.id })
      void prisma.auditLog.create({ data: { tenantId: req.user.tenantId, actorId: req.user.id, action: req.method, entityType: req.baseUrl.split('/').filter(Boolean).at(-1) ?? 'resource', entityId: String(req.params.id ?? req.path), after: { path: req.originalUrl, status: res.statusCode } } }).catch(() => undefined)
    }
  })
  next()
})
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'))
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-8' }))
app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok', service: 'tradeflow-api', timestamp: new Date().toISOString() }))
app.use('/api/v1/platform-export', platformExportRoutes)
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, { customSiteTitle: 'TradeFlow API Docs' }))
app.use('/api/v1/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8' }), authRoutes)
app.use('/api/v1/products', productRoutes)
app.use('/api/v1/categories', categoryRoutes)
app.use('/api/v1/shopping', shoppingRoutes)
app.use('/api/v1/transport', transportRoutes)
app.use('/api/v1/orders', checkoutRateLimit, orderRoutes)
app.use('/api/v1/payments', qpayCallbackRateLimit, paymentRoutes)
app.use('/api/v1/notifications', notificationRoutes)
app.use('/api/v1/chat', chatRoutes)
app.use('/api/v1/uploads', uploadRoutes)
app.use('/api/v1/assets', assetRoutes)
app.use('/api/v1/inventory', inventoryRoutes)
app.use('/api/v1/procurement', procurementRoutes)
app.use('/api/v1/pricing', pricingRoutes)
app.use('/api/v1/fulfillment', fulfillmentRoutes)
app.use('/api/v1/finance', financeRoutes)
app.use('/api/v1/reports', reportRoutes)
app.use('/api/v1/b2b', b2bRoutes)
app.use('/api/v1/deliveries', deliveryRoutes)
app.use('/api/v1/admin', adminRoutes)
app.use('/api/v1/catalog', catalogRoutes)
app.use('/api/v1/commerce', commerceRoutes)
app.use(notFound)
app.use(errorHandler)
