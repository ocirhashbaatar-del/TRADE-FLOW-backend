import crypto from 'node:crypto'
import { Role } from '@prisma/client'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { audit } from '../lib/audit.js'
import { sendMail } from '../lib/services.js'
import { authenticate, authorize, requireTenant } from '../middleware/auth.js'
import { hashToken } from '../utils/auth.js'
import { resolveTxt } from 'node:dns/promises'
import { jobQueueHealth } from '../lib/job-queue.js'
import { attachVercelDomain } from '../lib/vercel-domain.js'
import { assertSubscriptionCapacity } from '../lib/subscription.js'

const router = Router()
router.use(authenticate)
const admin = authorize(Role.ADMIN)
const tenantId = (req: Express.Request) => req.user!.tenantId!
const assertPlatformAdmin = async (id: string) => Boolean((await prisma.user.findUnique({ where: { id }, select: { platformAdmin: true } }))?.platformAdmin)
const permissionModules = ['dashboard', 'catalog', 'pricing', 'procurement', 'inventory', 'orders', 'fulfillment', 'finance', 'reports', 'customers', 'users', 'settings'] as const
const editableRoles = [Role.MANAGER, Role.EMPLOYEE, Role.VENDOR, Role.TRANSPORTER, Role.ACCOUNTANT, Role.CUSTOMER] as const
const planRules = { MVP: { users: 5, products: 500, warehouses: 1 }, GROWTH: { users: 30, products: 10000, warehouses: 10 }, ENTERPRISE: { users: 100000, products: 1000000, warehouses: 1000 } } as const
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

router.get('/platform/health', async (req, res) => {
  if (!await assertPlatformAdmin(req.user!.id)) return res.status(403).json({ message: 'Super Admin эрх шаардлагатай.' })
  const [tenants, users, products, orders, activeTenants] = await Promise.all([prisma.tenant.count(), prisma.user.count(), prisma.product.count(), prisma.order.count(), prisma.tenant.count({ where: { active: true } })])
  res.json({ status: 'healthy', database: 'connected', queue: await jobQueueHealth(), tenants, activeTenants, users, products, orders, uptimeSeconds: Math.floor(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576), plans: planRules })
})
router.get('/platform/usage', async (req, res) => {
  if (!await assertPlatformAdmin(req.user!.id)) return res.status(403).json({ message: 'Super Admin эрх шаардлагатай.' })
  const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: 'desc' } }); res.json(await Promise.all(tenants.map(async (tenant) => ({ tenant, usage: { users: await prisma.user.count({ where: { tenantId: tenant.id, role: { not: Role.CUSTOMER } } }), products: await prisma.product.count({ where: { tenantId: tenant.id } }), warehouses: await prisma.warehouse.count({ where: { tenantId: tenant.id } }) }, limits: planRules[(tenant.subscription in planRules ? tenant.subscription : 'MVP') as keyof typeof planRules] }))))
})
router.post('/platform/tenants/:id/domain/request', async (req, res) => {
  if (!await assertPlatformAdmin(req.user!.id)) return res.status(403).json({ message: 'Super Admin эрх шаардлагатай.' })
  const tenant = await prisma.tenant.findUnique({ where: { id: String(req.params.id) } }); if (!tenant?.domain) return res.status(400).json({ message: 'Domain тохируулаагүй.' })
  const token = `tradeflow-verification=${crypto.randomBytes(24).toString('hex')}`; await prisma.tenant.update({ where: { id: tenant.id }, data: { domainVerificationToken: token, domainVerifiedAt: null } }); res.json({ domain: tenant.domain, type: 'TXT', name: `_tradeflow.${tenant.domain}`, value: token })
})
router.post('/platform/tenants/:id/domain/verify', async (req, res) => {
  if (!await assertPlatformAdmin(req.user!.id)) return res.status(403).json({ message: 'Super Admin эрх шаардлагатай.' })
  const tenant = await prisma.tenant.findUnique({ where: { id: String(req.params.id) } }); if (!tenant?.domain || !tenant.domainVerificationToken) return res.status(400).json({ message: 'Verification эхлээгүй.' })
  const records = await resolveTxt(`_tradeflow.${tenant.domain}`).catch(() => []); if (!records.some((parts) => parts.join('') === tenant.domainVerificationToken)) return res.status(409).json({ message: 'DNS TXT record баталгаажаагүй байна.' })
  res.json(await prisma.tenant.update({ where: { id: tenant.id }, data: { domainVerifiedAt: new Date() } }))
})
router.post('/platform/tenants/:id/domain/attach', async(req,res)=>{if(!await assertPlatformAdmin(req.user!.id))return res.status(403).json({message:'Super Admin эрх шаардлагатай.'});const tenant=await prisma.tenant.findUnique({where:{id:String(req.params.id)}});if(!tenant?.domain||!tenant.domainVerifiedAt)return res.status(409).json({message:'Domain эхлээд DNS-ээр баталгаажсан байх ёстой.'});res.json(await attachVercelDomain(tenant.domain))})
router.post('/platform/tenants/:id/plan',async(req,res)=>{if(!await assertPlatformAdmin(req.user!.id))return res.status(403).json({message:'Super Admin эрх шаардлагатай.'});const input=z.object({plan:z.enum(['MVP','GROWTH','ENTERPRISE']),reason:z.string().min(3)}).parse(req.body),id=String(req.params.id);const row=await prisma.$transaction(async tx=>{const current=await tx.tenant.findUniqueOrThrow({where:{id}});if(current.subscription!==input.plan)await tx.planChangeHistory.create({data:{tenantId:id,fromPlan:current.subscription,toPlan:input.plan,changedBy:req.user!.id,reason:input.reason}});return tx.tenant.update({where:{id},data:{subscription:input.plan}})});res.json(row)})
router.get('/platform/tenants/:id/plan-history',async(req,res)=>{if(!await assertPlatformAdmin(req.user!.id))return res.status(403).json({message:'Super Admin эрх шаардлагатай.'});res.json(await prisma.planChangeHistory.findMany({where:{tenantId:String(req.params.id)},orderBy:{createdAt:'desc'}}))})
router.get('/platform/incidents',async(req,res)=>{if(!await assertPlatformAdmin(req.user!.id))return res.status(403).json({message:'Super Admin эрх шаардлагатай.'});res.json({incidents:await prisma.platformIncident.findMany({orderBy:{createdAt:'desc'},take:100}),worker:await jobQueueHealth()})})
router.post('/platform/tenants/:id/export',async(req,res)=>{if(!await assertPlatformAdmin(req.user!.id))return res.status(403).json({message:'Super Admin эрх шаардлагатай.'});const id=String(req.params.id);if(!await prisma.tenant.findUnique({where:{id}}))return res.status(404).json({message:'Tenant олдсонгүй.'});const job=await prisma.tenantExportJob.create({data:{tenantId:id,requestedBy:req.user!.id,expiresAt:new Date(Date.now()+24*3600000)}});res.status(201).json({downloadUrl:`/api/v1/admin/platform/exports/${job.id}/download`})})
router.get('/platform/exports/:id/download',async(req,res)=>{if(!await assertPlatformAdmin(req.user!.id))return res.status(403).json({message:'Super Admin эрх шаардлагатай.'});const job=await prisma.tenantExportJob.findFirst({where:{id:String(req.params.id),status:'READY',expiresAt:{gt:new Date()}}});if(!job)return res.status(404).json({message:'Export олдсонгүй.'});const id=job.tenantId,[tenant,users,products,categories,orders,invoices,payments,movements,audits]=await Promise.all([prisma.tenant.findUnique({where:{id}}),prisma.user.findMany({where:{tenantId:id},select:{id:true,name:true,email:true,phone:true,role:true,createdAt:true}}),prisma.product.findMany({where:{tenantId:id}}),prisma.category.findMany({where:{tenantId:id}}),prisma.order.findMany({where:{tenantId:id},include:{items:true,statusHistory:true}}),prisma.invoice.findMany({where:{tenantId:id}}),prisma.paymentRecord.findMany({where:{tenantId:id}}),prisma.stockMovement.findMany({where:{tenantId:id}}),prisma.auditLog.findMany({where:{tenantId:id}})]);res.type('application/json').attachment(`tradeflow-${tenant?.slug??id}-export.json`).send(JSON.stringify({exportedAt:new Date().toISOString(),tenant,users,products,categories,orders,invoices,payments,movements,audits}))})
router.patch('/platform/incidents/:id',async(req,res)=>{if(!await assertPlatformAdmin(req.user!.id))return res.status(403).json({message:'Super Admin эрх шаардлагатай.'});const input=z.object({acknowledged:z.boolean().optional(),resolved:z.boolean().optional()}).parse(req.body);res.json(await prisma.platformIncident.update({where:{id:String(req.params.id)},data:{acknowledged:input.acknowledged,...(input.resolved?{resolvedAt:new Date()}: {})}}))})

router.get('/my-permissions', requireTenant, async (req, res) => {
  if (req.user!.role === Role.ADMIN) return res.json(permissionModules.map((module) => ({ module, canRead: true, canCreate: true, canUpdate: true, canDelete: true })))
  await ensurePermissionMatrix(tenantId(req))
  res.json(await prisma.rolePermission.findMany({ where: { tenantId: tenantId(req), role: req.user!.role }, select: { module: true, canRead: true, canCreate: true, canUpdate: true, canDelete: true } }))
})

router.use(requireTenant, admin)
router.get('/tenant', async (req, res) => res.json(await prisma.tenant.findUnique({ where: { id: tenantId(req) } })))
router.post('/tenant/export-jobs',async(req,res)=>{const requested=String(req.headers['x-tenant-export']??''),target=requested&&await assertPlatformAdmin(req.user!.id)?requested:tenantId(req);const row=await prisma.tenantExportJob.create({data:{tenantId:target,requestedBy:req.user!.id,expiresAt:new Date(Date.now()+24*3600000)}});res.status(201).json({...row,downloadUrl:`/api/v1/platform-export/${row.id}`})})
router.get('/tenant/export-jobs/:id/download',async(req,res)=>{const tenantIdValue=tenantId(req),job=await prisma.tenantExportJob.findFirst({where:{id:String(req.params.id),tenantId:tenantIdValue,status:'READY',expiresAt:{gt:new Date()}}});if(!job)return res.status(404).json({message:'Export job олдсонгүй эсвэл хугацаа дууссан.'});const[tenant,users,products,categories,orders,invoices,payments,movements,audits]=await Promise.all([prisma.tenant.findUnique({where:{id:tenantIdValue}}),prisma.user.findMany({where:{tenantId:tenantIdValue},select:{id:true,name:true,email:true,phone:true,role:true,createdAt:true}}),prisma.product.findMany({where:{tenantId:tenantIdValue}}),prisma.category.findMany({where:{tenantId:tenantIdValue}}),prisma.order.findMany({where:{tenantId:tenantIdValue},include:{items:true,statusHistory:true}}),prisma.invoice.findMany({where:{tenantId:tenantIdValue}}),prisma.paymentRecord.findMany({where:{tenantId:tenantIdValue}}),prisma.stockMovement.findMany({where:{tenantId:tenantIdValue}}),prisma.auditLog.findMany({where:{tenantId:tenantIdValue}})]);res.type('application/json').attachment(`tradeflow-${tenant?.slug??tenantIdValue}-export.json`).send(JSON.stringify({exportedAt:new Date().toISOString(),tenant,users,products,categories,orders,invoices,payments,movements,audits}))})
router.patch('/tenant', async (req, res) => { const input = z.object({ name: z.string().min(2).optional(), domain: z.string().nullable().optional(), logo: z.string().nullable().optional(), primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).parse(req.body); const row = await prisma.tenant.update({ where: { id: tenantId(req) }, data: input }); await audit(req, 'UPDATE', 'TenantBranding', row.id, undefined, row); res.json(row) })
router.get('/users', async (req, res) => res.json(await prisma.user.findMany({ where: { tenantId: tenantId(req) }, select: { id: true, name: true, email: true, role: true, emailVerified: true, createdAt: true }, orderBy: { createdAt: 'desc' } })))
router.patch('/users/:id', async (req, res) => { const input = z.object({ role: z.nativeEnum(Role).optional(), name: z.string().min(2).optional() }).parse(req.body); const target = await prisma.user.findFirst({ where: { id: String(req.params.id), tenantId: tenantId(req) } }); if (!target) return res.status(404).json({ message: 'Хэрэглэгч олдсонгүй.' }); if (target.id === req.user!.id && input.role && input.role !== Role.ADMIN) return res.status(409).json({ message: 'Өөрийн ADMIN эрхийг өөрчлөх боломжгүй.' }); if (target.role === Role.ADMIN && input.role && input.role !== Role.ADMIN && await prisma.user.count({ where: { tenantId: tenantId(req), role: Role.ADMIN } }) <= 1) return res.status(409).json({ message: 'Tenant-д дор хаяж нэг ADMIN үлдэх ёстой.' }); const row = await prisma.user.update({ where: { id: target.id }, data: input }); await audit(req, 'UPDATE', 'UserRole', row.id, target, row); res.json(row) })
router.get('/invitations', async (req, res) => res.json(await prisma.staffInvitation.findMany({ where: { tenantId: tenantId(req) }, orderBy: { createdAt: 'desc' } })))
router.post('/invitations', async (req, res) => {
  const input = z.object({ name: z.string().min(2), email: z.email(), role: z.nativeEnum(Role).refine((role) => role !== Role.CUSTOMER) }).parse(req.body)
  const email = input.email.toLowerCase()
  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } })
  if (!existingUser) await prisma.$transaction((tx) => assertSubscriptionCapacity(tx, tenantId(req), 'users'))
  const raw = crypto.randomBytes(32).toString('hex')
  const invitation = await prisma.staffInvitation.upsert({ where: { tenantId_email: { tenantId: tenantId(req), email } }, update: { ...input, email, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 7 * 86400000), acceptedAt: null, invitedBy: req.user!.id }, create: { ...input, email, tenantId: tenantId(req), tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 7 * 86400000), invitedBy: req.user!.id } })
  const link = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/auth/accept-invite?token=${raw}`
  void sendMail(input.email, 'TradeFlow ажилтны урилга', `<p>${input.name}, <a href="${link}">урилгаа зөвшөөрөх</a></p>`)
  await audit(req, 'INVITE', 'StaffInvitation', invitation.id, undefined, invitation)
  res.status(201).json({ ...invitation, inviteUrl: link })
})
router.delete('/invitations/:id', async (req, res) => { const invitation = await prisma.staffInvitation.findFirst({ where: { id: String(req.params.id), tenantId: tenantId(req), acceptedAt: null } }); if (!invitation) return res.status(404).json({ message: 'Цуцлах боломжтой урилга олдсонгүй.' }); await prisma.staffInvitation.delete({ where: { id: invitation.id } }); await audit(req, 'DELETE', 'StaffInvitation', invitation.id, invitation, undefined); res.status(204).send() })
router.get('/permissions', async (req, res) => { if (req.user!.role !== Role.ADMIN) return res.status(403).json({ message: 'Permission тохируулахад ADMIN эрх шаардлагатай.' }); await ensurePermissionMatrix(tenantId(req)); res.json(await prisma.rolePermission.findMany({ where: { tenantId: tenantId(req) }, orderBy: [{ role: 'asc' }, { module: 'asc' }] })) })
router.put('/permissions', async (req, res) => { if (req.user!.role !== Role.ADMIN) return res.status(403).json({ message: 'Permission тохируулахад ADMIN эрх шаардлагатай.' }); const input = z.object({ role: z.nativeEnum(Role).refine((role) => role !== Role.ADMIN, 'ADMIN эрхийг хязгаарлах боломжгүй.'), module: z.enum(permissionModules), canRead: z.boolean(), canCreate: z.boolean(), canUpdate: z.boolean(), canDelete: z.boolean() }).parse(req.body); const row = await prisma.rolePermission.upsert({ where: { tenantId_role_module: { tenantId: tenantId(req), role: input.role, module: input.module } }, update: input, create: { ...input, tenantId: tenantId(req) } }); await audit(req, 'UPSERT', 'RolePermission', row.id, undefined, row); res.json(row) })

export default router
