import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'
import { Sentry } from '../lib/observability.js'

export const notFound: RequestHandler = (req, res) => { res.status(404).json({ message: `Route олдсонгүй: ${req.method} ${req.originalUrl}` }) }
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error?.code === 'P2034') { res.status(409).json({ message: 'Зэрэг хүсэлтээс шалтгаалсан зөрчил гарлаа. Дахин оролдоно уу.', retryable: true }); return }
  if (error instanceof ZodError) { res.status(400).json({ message: 'Validation алдаа', errors: error.flatten() }); return }
  console.error(error)
  Sentry.captureException(error, { extra: { requestId: res.getHeader('x-request-id') } })
  res.status(Number(error.status) || 500).json({ message: error.message || 'Серверийн алдаа.' })
}
