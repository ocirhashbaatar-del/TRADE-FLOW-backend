import crypto from 'node:crypto'
import type { RequestHandler } from 'express'
import { tenantContext } from '../lib/tenant-context.js'
export const requestContext: RequestHandler = (req, res, next) => {
  const requestId = String(req.headers['x-request-id'] ?? crypto.randomUUID())
  res.setHeader('x-request-id', requestId)
  const started = performance.now()
  res.on('finish', () => console.log(JSON.stringify({ level: 'info', type: 'http', requestId, tenantId: req.user?.tenantId, userId: req.user?.id, method: req.method, path: req.originalUrl, status: res.statusCode, durationMs: Math.round((performance.now() - started) * 100) / 100, timestamp: new Date().toISOString() })))
  tenantContext.run({}, next)
}
