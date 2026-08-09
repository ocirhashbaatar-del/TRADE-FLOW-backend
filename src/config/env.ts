import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES: z.string().default('15m'),
  JWT_REFRESH_EXPIRES: z.string().default('7d'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(), GITHUB_CLIENT_SECRET: z.string().optional(),
  FACEBOOK_CLIENT_ID: z.string().optional(), FACEBOOK_CLIENT_SECRET: z.string().optional(),
  BACKEND_PUBLIC_URL: z.string().default('http://localhost:4000'),
  AUTH_CALLBACK_URL: z.string().default('http://localhost:5173/auth/callback'),
  SENTRY_DSN: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  CLOUDINARY_CLOUD_NAME: z.string().optional(), CLOUDINARY_API_KEY: z.string().optional(), CLOUDINARY_API_SECRET: z.string().optional(),
  ASSET_SOURCE_DIR: z.string().default('../Supply/public/images'),
  STRIPE_SECRET_KEY: z.string().optional(), STRIPE_WEBHOOK_SECRET: z.string().optional(), STRIPE_CURRENCY: z.string().default('usd'),
QPAY_BASE_URL: z.string().url().default('https://merchant-sandbox.qpay.mn'), QPAY_CLIENT_ID: z.string().optional(), QPAY_CLIENT_SECRET: z.string().optional(), QPAY_INVOICE_CODE: z.string().optional(), QPAY_CALLBACK_TOKEN: z.string().min(24).optional(),
  SMTP_HOST: z.string().optional(), SMTP_PORT: z.coerce.number().default(587), SMTP_USER: z.string().optional(), SMTP_PASS: z.string().optional(), MAIL_FROM: z.string().default('TradeFlow <noreply@tradeflow.mn>'),
  // Production startup must never run the demo seed unless explicitly enabled.
  SEED_PRODUCTION_ALLOWED: z.string().default('false'),
  // Feature flags for high-risk modules (see docs/ENV_MATRIX.md).
  FEATURE_FLAG_STRIPE: z.string().default('true'),
  FEATURE_FLAG_OAUTH: z.string().default('true'),
  FEATURE_FLAG_QPAY: z.string().default('true'),
  FEATURE_FLAG_E_BARIMT: z.string().default('true'),
  FEATURE_FLAG_DELIVERY_PARTNER: z.string().default('false'),
})

export const env = schema.parse(process.env)
export const frontendOrigins = env.FRONTEND_URL.split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean)
