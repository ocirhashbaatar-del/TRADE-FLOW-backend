import type { NextFunction, Request, Response } from 'express'
import type { Role } from '@prisma/client'
import { verifyAccessToken } from '../utils/auth.js'
import { prisma } from '../lib/prisma.js'
import { setTenantContext } from '../lib/tenant-context.js'

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null
  if (!token) return res.status(401).json({ message: 'Нэвтрэх шаардлагатай.' })
  try { req.user = verifyAccessToken(token); setTenantContext(req.user.tenantId); next() }
  catch { res.status(401).json({ message: 'Token хүчингүй эсвэл хугацаа дууссан.' }) }
}

const moduleAliases: Record<string, string> = {
  products: 'catalog', categories: 'catalog', catalog: 'catalog', uploads: 'catalog', assets: 'catalog',
  inventory: 'inventory', procurement: 'procurement', orders: 'orders', fulfillment: 'fulfillment', deliveries: 'fulfillment',
  pricing: 'pricing', finance: 'finance', payments: 'finance', reports: 'reports', b2b: 'customers', admin: 'users',
}

const permissionAction = (req: Request): 'canRead' | 'canCreate' | 'canUpdate' | 'canDelete' => {
  if (req.method === 'GET' || req.method === 'HEAD') return 'canRead'
  if (req.method === 'DELETE') return 'canDelete'
  if (req.method === 'PUT' || req.method === 'PATCH' || /\/(approve|reject|ship|receive|cancel|close|send)(\/|$)/.test(req.path)) return 'canUpdate'
  return 'canCreate'
}

export const authorize = (...roles: Role[]) => async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(403).json({ message: 'Энэ үйлдлийг хийх эрхгүй.' })
  if (req.user.role === 'ADMIN') return next()
  const routeModule = req.baseUrl.split('/').filter(Boolean).at(-1) ?? ''
  const module = routeModule === 'admin'
    ? (/^\/tenant/.test(req.path) || /^\/permissions/.test(req.path) ? 'settings' : 'users')
    : moduleAliases[routeModule] ?? routeModule
  if (req.user.tenantId && module) {
    const permission = await prisma.rolePermission.findUnique({
      where: { tenantId_role_module: { tenantId: req.user.tenantId, role: req.user.role, module } },
    })
    if (permission) return permission[permissionAction(req)]
      ? next()
      : res.status(403).json({ message: `${module} хэсгийн энэ үйлдлийг хийх эрхгүй.` })
  }
  return roles.includes(req.user.role) ? next() : res.status(403).json({ message: 'Энэ үйлдлийг хийх эрхгүй.' })
}

export const authorizePermission = (module: string, action: 'auto' | 'canRead' | 'canCreate' | 'canUpdate' | 'canDelete', ...fallbackRoles: Role[]) => async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(403).json({ message: 'Энэ үйлдлийг хийх эрхгүй.' })
  if (req.user.role === 'ADMIN') return next()
  if (req.user.tenantId) {
    const permission = await prisma.rolePermission.findUnique({ where: { tenantId_role_module: { tenantId: req.user.tenantId, role: req.user.role, module } } })
    const resolvedAction = action === 'auto' ? permissionAction(req) : action
    if (permission) return permission[resolvedAction] ? next() : res.status(403).json({ message: `${module} хэсгийн ${resolvedAction} эрхгүй.` })
  }
  return fallbackRoles.includes(req.user.role) ? next() : res.status(403).json({ message: 'Энэ үйлдлийг хийх эрхгүй.' })
}

export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction) {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null
  if (token) {
    try { req.user = verifyAccessToken(token); setTenantContext(req.user.tenantId) } catch { /* Public catalog remains available without a session. */ }
  }
  next()
}

export const authorizeEmails = (...emails: string[]) => (req: Request, res: Response, next: NextFunction) =>
  req.user && emails.includes(req.user.email.trim().toLowerCase()) ? next() : res.status(403).json({ message: 'Энэ хэсэгт нэвтрэх эрхгүй.' })

export function requireTenant(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.tenantId) return res.status(403).json({ message: 'Tenant сонгогдоогүй байна.' })
  next()
}
