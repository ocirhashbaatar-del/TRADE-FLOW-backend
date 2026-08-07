import crypto from 'node:crypto'
import { Role } from '@prisma/client'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { audit } from '../lib/audit.js'
import { sendMail } from '../lib/services.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'
import { hashToken } from '../utils/auth.js'

const router = Router()
router.use(authenticate)
const admin = authorize(Role.ADMIN)
const tenantId = (req: Express.Request) => req.user!.tenantId!
const assertPlatformAdmin = async (id: string) => Boolean((await prisma.user.findUnique({ where: { id }, select: { platformAdmin: true } }))?.platformAdmin)
const permissionModules = ['dashboard', 'catalog', 'pricing', 'procurement', 'inventory', 'orders', 'fulfillment', 'finance', 'reports', 'customers', 'users', 'settings'] as const
const editableRoles = [Role.MANAGER, Role.EMPLOYEE, Role.VENDOR, Role.TRANSPORTER, Role.ACCOUNTANT, Role.CUSTOMER] as const
const defaultAccess: Partial<Record<Role, readonly string[]>> = {
  MANAGER: permissionModules,
  EMPLOYEE: ['dashboard', 'catalog', 'inventory', 'orders', 'fulfillment', 'customers'],
  VENDOR: ['dashboard', 'catalog', 'orders', 'fulfillment', 'procurement'],
  TRANSPORTER: ['orders', 'fulfillment'],
  ACCOUNTANT: ['dashboard', 'orders', 'finance', 'reports'],
  CUSTOMER: [],
}
const ensurePermissionMatrix = async (id: string) => prisma.rolePermission.createMany({
  data: editableRoles.flatMap((role) => permissionModules.map((module) => {
    const allowed = defaultAccess[role]?.includes(module) ?? false
    const readOnly = role === Role.TRANSPORTER || role === Role.ACCOUNTANT
    return { tenantId: id, role, module, canRead: allowed, canCreate: allowed && !readOnly, canUpdate: allowed, canDelete: allowed && role === Role.MANAGER }
  })),
  skipDuplicates: true,
})

router.get('/platform/tenants', async (req, res) => { if (!await assertPlatformAdmin(req.user!.id)) return res.status(403).json({ message: 'Super Admin эрх шаардлагатай.' }); res.json(await prisma.tenant.findMany({ orderBy: { createdAt: 'desc' } })) })
router.post('/platform/tenants', async (req, res) => { if (!await assertPlatformAdmin(req.user!.id)) return res.status(403).json({ message: 'Super Admin эрх шаардлагатай.' }); const input = z.object({ name: z.string().min(2), slug: z.string().regex(/^[a-z0-9-]+$/), domain: z.string().optional(), primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#059669') }).parse(req.body); res.status(201).json(await prisma.tenant.create({ data: input })) })
router.patch('/platform/tenants/:id', async (req, res) => { if (!await assertPlatformAdmin(req.user!.id)) return res.status(403).json({ message: 'Super Admin эрх шаардлагатай.' }); const input = z.object({ name: z.string().min(2).optional(), domain: z.string().nullable().optional(), logo: z.string().nullable().optional(), primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), subscription: z.string().optional(), active: z.boolean().optional() }).parse(req.body); res.json(await prisma.tenant.update({ where: { id: String(req.params.id) }, data: input })) })

router.use(requireTenant, admin)
router.get('/tenant', async (req, res) => res.json(await prisma.tenant.findUnique({ where: { id: tenantId(req) } })))
router.patch('/tenant', async (req, res) => { const input = z.object({ name: z.string().min(2).optional(), domain: z.string().nullable().optional(), logo: z.string().nullable().optional(), primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).parse(req.body); const row = await prisma.tenant.update({ where: { id: tenantId(req) }, data: input }); await audit(req, 'UPDATE', 'TenantBranding', row.id, undefined, row); res.json(row) })
router.get('/users', async (req, res) => res.json(await prisma.user.findMany({ where: { tenantId: tenantId(req) }, select: { id: true, name: true, email: true, role: true, emailVerified: true, createdAt: true }, orderBy: { createdAt: 'desc' } })))
router.patch('/users/:id', async (req, res) => { const input = z.object({ role: z.nativeEnum(Role).optional(), name: z.string().min(2).optional() }).parse(req.body); const target = await prisma.user.findFirst({ where: { id: String(req.params.id), tenantId: tenantId(req) } }); if (!target) return res.status(404).json({ message: 'Хэрэглэгч олдсонгүй.' }); const row = await prisma.user.update({ where: { id: target.id }, data: input }); await audit(req, 'UPDATE', 'UserRole', row.id, target, row); res.json(row) })
router.get('/invitations', async (req, res) => res.json(await prisma.staffInvitation.findMany({ where: { tenantId: tenantId(req) }, orderBy: { createdAt: 'desc' } })))
router.post('/invitations', async (req, res) => { const input = z.object({ name: z.string().min(2), email: z.email(), role: z.nativeEnum(Role).refine((role) => role !== Role.CUSTOMER) }).parse(req.body); const raw = crypto.randomBytes(32).toString('hex'); const invitation = await prisma.staffInvitation.upsert({ where: { tenantId_email: { tenantId: tenantId(req), email: input.email.toLowerCase() } }, update: { ...input, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 7 * 86400000), acceptedAt: null, invitedBy: req.user!.id }, create: { ...input, email: input.email.toLowerCase(), tenantId: tenantId(req), tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 7 * 86400000), invitedBy: req.user!.id } }); const link = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/auth/accept-invite?token=${raw}`; void sendMail(input.email, 'TradeFlow ажилтны урилга', `<p>${input.name}, <a href="${link}">урилгаа зөвшөөрөх</a></p>`); await audit(req, 'INVITE', 'StaffInvitation', invitation.id, undefined, invitation); res.status(201).json({ ...invitation, inviteUrl: link }) })
router.get('/permissions', async (req, res) => { if (req.user!.role !== Role.ADMIN) return res.status(403).json({ message: 'Permission тохируулахад ADMIN эрх шаардлагатай.' }); await ensurePermissionMatrix(tenantId(req)); res.json(await prisma.rolePermission.findMany({ where: { tenantId: tenantId(req) }, orderBy: [{ role: 'asc' }, { module: 'asc' }] })) })
router.put('/permissions', async (req, res) => { if (req.user!.role !== Role.ADMIN) return res.status(403).json({ message: 'Permission тохируулахад ADMIN эрх шаардлагатай.' }); const input = z.object({ role: z.nativeEnum(Role).refine((role) => role !== Role.ADMIN, 'ADMIN эрхийг хязгаарлах боломжгүй.'), module: z.enum(permissionModules), canRead: z.boolean(), canCreate: z.boolean(), canUpdate: z.boolean(), canDelete: z.boolean() }).parse(req.body); const row = await prisma.rolePermission.upsert({ where: { tenantId_role_module: { tenantId: tenantId(req), role: input.role, module: input.module } }, update: input, create: { ...input, tenantId: tenantId(req) } }); await audit(req, 'UPSERT', 'RolePermission', row.id, undefined, row); res.json(row) })

export default router
