import type { NextFunction, Request, Response } from 'express'
import type { Role } from '@prisma/client'
import { verifyAccessToken } from '../utils/auth.js'

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null
  if (!token) return res.status(401).json({ message: 'Нэвтрэх шаардлагатай.' })
  try { req.user = verifyAccessToken(token); next() }
  catch { res.status(401).json({ message: 'Token хүчингүй эсвэл хугацаа дууссан.' }) }
}

export const authorize = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) =>
  req.user && roles.includes(req.user.role) ? next() : res.status(403).json({ message: 'Энэ үйлдлийг хийх эрхгүй.' })

export const authorizeEmails = (...emails: string[]) => (req: Request, res: Response, next: NextFunction) =>
  req.user && emails.includes(req.user.email.trim().toLowerCase()) ? next() : res.status(403).json({ message: 'Энэ хэсэгт нэвтрэх эрхгүй.' })

export function requireTenant(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.tenantId) return res.status(403).json({ message: 'Tenant сонгогдоогүй байна.' })
  next()
}
