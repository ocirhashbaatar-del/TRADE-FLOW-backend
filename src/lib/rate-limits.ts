import rateLimit from 'express-rate-limit'

/**
 * Application-specific rate limits (12.4 Security release gate).
 *
 * In addition to the coarse global `/api` limit, these targeted limits protect
 * brute-force, enumeration, and replay-prone endpoints:
 *   - auth/OTP:  confirm + register + request/verify
 *   - OAuth:     start + callback + exchange
 *   - checkout:  order submission (POST /api/v1/orders)
 *   - QPay:      payment callback (replay protection augmentation)
 *
 * All are per-IP, in-memory by default (Redis-backed in production if a store
 * is configured). Limits are deliberately low for sensitive endpoints.
 */
const standard = { standardHeaders: 'draft-8' } as const

/** Phone OTP request / verify — prevents SMS bombing and code brute-force. */
export const otpRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, message: { message: 'Хэт олон OTP хүсэлт илгээлээ. Түр хүлээгээд дахин оролдоно уу.' }, ...standard })

/** Identity-provider OAuth start/callback/exchange — prevents token/replay abuse. */
export const oauthRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, message: { message: 'Хэт олон OAuth хүсэлт илгээлээ. Түр хүлээгээд дахин оролдоно уу.' }, ...standard })

/** Checkout / order creation — reduces oversell bursts and DoS. */
export const checkoutRateLimit = rateLimit({ windowMs: 60 * 1000, limit: 15, message: { message: 'Захиалга хэт олон удаа илгээлээ. Түр хүлээгээд дахин оролдоно уу.' }, ...standard })

/** QPay callback — throttles aggressive/replayed provider callbacks. */
export const qpayCallbackRateLimit = rateLimit({ windowMs: 60 * 1000, limit: 30, message: { message: 'QPay callback-ийн хэт олон хүсэлт илгээлээ.' }, ...standard })
